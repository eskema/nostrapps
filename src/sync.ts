// napp.sync: bring an (author, kind) range into the store from the author's
// write relays, remembering in redstore's outbox bounds what is already here
// so a later call for a range we hold asks no relay at all.
//
// A bound is one contiguous [oldest, newest] per author and kind. A call
// fetches only what lies outside it — and the gap between the two when the
// range asked for is disjoint from it, so the bound stays one piece.
//
// With a limit it is the newest that many before until instead: the store
// answers for what lies inside the bound, and the relays for the rest.

import { filterPurgatory, pool, relayPicker } from "@nostr/gadgets/global"
import { loadRelayList } from "@nostr/gadgets/lists"
import type { NostrEvent } from "@nostr/tools/core"
import type { Filter } from "@nostr/tools/filter"
import { getStore } from "./store.js"
import { FALLBACK_RELAYS } from "./relay-health.js"

export type SyncResult = { success: boolean; newEvents: number; error?: string }

type Bound = [oldest: number, newest: number]

const PAGE_LIMIT = 500
const MAX_PAGES = 20
const MAX_WAIT = 6000

// ─── REQ semaphore ─────────────────────────────────────────────
// Every REQ a sync opens, across all calls from every napp, holds one slot.
const MAX_REQS = 16
let reqsOpen = 0
const reqWaiters: (() => void)[] = []

async function withReqSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (reqsOpen >= MAX_REQS) await new Promise<void>(r => reqWaiters.push(r))
  else reqsOpen++
  try {
    return await fn()
  } finally {
    // the slot passes straight to the next waiter, or is freed
    const next = reqWaiters.shift()
    if (next) next()
    else reqsOpen--
  }
}

// ─── bounds ────────────────────────────────────────────────────
// Read from the store once, then kept here and written through.
let bounds: Promise<Map<string, Bound>> | null = null

function loadBounds(): Promise<Map<string, Bound>> {
  bounds ??= getStore()
    .getOutboxBounds()
    .then(all => {
      const m = new Map<string, Bound>()
      for (const pubkey in all)
        for (const kind in all[pubkey]) m.set(`${pubkey}:${kind}`, [...all[pubkey][kind]] as Bound)
      return m
    })
    .catch(err => {
      bounds = null
      throw err
    })
  return bounds
}

// The bound once [lo, hi] is also covered: their union when they touch, else
// the newer of the two (one bound cannot hold a gap).
function merge(b: Bound | undefined, lo: number, hi: number): Bound {
  if (!b) return [lo, hi]
  if (lo <= b[1] && hi >= b[0]) return [Math.min(lo, b[0]), Math.max(hi, b[1])]
  return hi > b[1] ? [lo, hi] : b
}

// Calls for the same (author, kind) run one after the other, so the second
// sees what the first brought and asks only for what is still missing.
const pairLocks = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (pairLocks.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  pairLocks.set(key, tail)
  tail.then(() => {
    if (pairLocks.get(key) === tail) pairLocks.delete(key)
  })
  return run
}

// ─── sync ──────────────────────────────────────────────────────

export type SyncOpts = {
  since?: number
  until: number
  limit?: number
  onNew: (event: NostrEvent) => Promise<void> | void
}

export async function sync(
  authors: string[],
  kinds: number[],
  opts: SyncOpts
): Promise<SyncResult> {
  // nothing past now can be known complete
  const until = Math.min(opts.until, Math.round(Date.now() / 1000))
  if (opts.since !== undefined && opts.since > until) return { success: true, newEvents: 0 }

  let newEvents = 0
  const onNew = async (event: NostrEvent) => {
    newEvents++
    await opts.onNew(event)
  }

  const errors: string[] = []
  await Promise.all(
    authors.flatMap(author =>
      kinds.map(kind =>
        serialize(`${author}:${kind}`, () =>
          opts.limit === undefined
            ? syncPair(author, kind, opts.since ?? 0, until, onNew)
            : syncPairLatest(author, kind, opts.since, until, opts.limit, onNew)
        ).catch(err => {
          errors.push(`${author.slice(0, 8)}/${kind}: ${err?.message ?? String(err)}`)
        })
      )
    )
  )

  if (errors.length === 0) return { success: true, newEvents }
  const shown = errors.slice(0, 3).join("; ")
  return {
    success: false,
    newEvents,
    error: errors.length > 3 ? `${shown} (and ${errors.length - 3} more)` : shown
  }
}

async function syncPair(
  author: string,
  kind: number,
  since: number,
  until: number,
  onNew: (event: NostrEvent) => Promise<void>
) {
  const key = `${author}:${kind}`
  const b = (await loadBounds()).get(key)

  // the ranges to ask for, newest first
  const segments: Bound[] = []
  if (!b) segments.push([since, until])
  else {
    // what lies above the bound, and what lies below it
    if (until > b[1]) segments.push([b[1], until])
    if (since < b[0]) segments.push([since, b[0]])
  }
  if (segments.length === 0) return

  const relays = await authorRelays(author, kind)
  const failures: string[] = []
  for (const [lo, hi] of segments) {
    const coveredDownTo = await fetchRange(relays, author, kind, lo, hi, onNew)
    if (coveredDownTo === undefined) {
      failures.push(`no relay answered for ${lo}–${hi}`)
      continue
    }
    await extendBound(author, kind, coveredDownTo, hi)
  }
  if (failures.length) throw new Error(failures.join(", "))
}

// The newest `limit` events at or before until (and not before since), asking
// the relays only for what the store can't already prove it has: whatever is
// above the bound first, then one REQ for the missing ones below it.
async function syncPairLatest(
  author: string,
  kind: number,
  since: number | undefined,
  until: number,
  limit: number,
  onNew: (event: NostrEvent) => Promise<void>
) {
  let b = (await loadBounds()).get(`${author}:${kind}`)
  let relays: string[] | undefined

  // bring the bound up to until, but no further down than limit events
  if (b && until > b[1]) {
    relays = await authorRelays(author, kind)
    const coveredDownTo = await fetchRange(relays, author, kind, b[1], until, onNew, {
      want: limit
    })
    if (coveredDownTo === undefined) throw new Error(`no relay answered for ${b[1]}–${until}`)
    b = await extendBound(author, kind, coveredDownTo, until)
  }

  // [oldestBound, until] is in the store; below it is unknown
  const held = b && b[0] <= until && until <= b[1]
  const oldestBound = held ? b![0] : until
  if (held && since !== undefined && since >= oldestBound) return

  let have = 0
  if (held) {
    const events = await getStore().queryEvents(
      { authors: [author], kinds: [kind], since: oldestBound, until, limit },
      limit
    )
    have = events.length
  }
  if (have >= limit) return

  // below the oldest second already fetched; with no bound, from until itself
  const top = held ? oldestBound - 1 : until
  relays ??= await authorRelays(author, kind)
  const reached = await fetchLatest(relays, author, kind, since, top, limit - have, onNew)
  if (reached === undefined) throw new Error(`no relay answered below ${top}`)
  await extendBound(author, kind, reached, until)
}

// Records [lo, hi] as covered for this pair, answering the bound now held.
async function extendBound(author: string, kind: number, lo: number, hi: number): Promise<Bound> {
  const all = await loadBounds()
  const key = `${author}:${kind}`
  const next = merge(all.get(key), lo, hi)
  all.set(key, next)
  await getStore().setOutboxBound(author, kind, next)
  return next
}

// Two of the author's write relays, or the fallbacks when they list none.
async function authorRelays(author: string, kind: number): Promise<string[]> {
  const items = (await loadRelayList(author)).items
  const relays = relayPicker(filterPurgatory(items, [kind]), [kind])
  return relays.length ? relays : FALLBACK_RELAYS
}

// Everything matching base between lo and hi (inclusive) from each relay,
// paging down from hi. Saves each event as it comes. Answers how far down the
// range is known complete: the least any answering relay got to (so nothing
// one of them still had is claimed), or undefined when none answered.
// With want, a relay stops once it has sent that many, and is then taken
// to reach down to the oldest second it sent.
async function fetchRange(
  relays: string[],
  author: string,
  kind: number,
  lo: number,
  hi: number,
  onNew: (event: NostrEvent) => Promise<void>,
  { want = Infinity }: { want?: number } = {}
): Promise<number | undefined> {
  const { seen, collect, saved } = collector(onNew)

  const coverages = await Promise.all(
    relays.map(async (url): Promise<number | undefined> => {
      const relay = await pool.ensureRelay(url, { connectionTimeout: MAX_WAIT }).catch(() => null)
      if (!relay) return undefined

      let until = hi
      let downTo: number | undefined
      let got = 0
      for (let p = 0; p < MAX_PAGES && got < want; p++) {
        const limit = Math.min(PAGE_LIMIT, want - got)
        const page = await withReqSlot(() =>
          fetchPage(
            relay,
            { authors: [author], kinds: [kind], since: lo, until, limit },
            seen,
            collect
          )
        )
        if (!page) return downTo // timed out or CLOSED: keep what earlier pages proved
        // only an empty page means the relay has nothing more: a short one may
        // be the relay capping our limit silently
        if (page.count === 0) return lo
        if (page.oldest >= until) {
          // all from the same second we already asked down to
          return page.count < limit ? lo : downTo
        }
        got += page.count
        downTo = page.oldest
        until = page.oldest - 1
      }
      // stopped at want: like fetchLatest, down to the oldest second it sent,
      // so the next REQ asks below it
      return got >= want ? until : downTo
    })
  )
  await saved()

  let coveredDownTo: number | undefined
  for (const c of coverages)
    if (c !== undefined && (coveredDownTo === undefined || c > coveredDownTo)) coveredDownTo = c
  return coveredDownTo
}

// One REQ for the newest limit at or before until (and not before since) to
// each relay. Answers the second the store now reaches down to: the newest of
// the oldest each answering relay sent (since, or 0, from one that sent
// nothing), or undefined when none answered.
async function fetchLatest(
  relays: string[],
  author: string,
  kind: number,
  since: number | undefined,
  until: number,
  limit: number,
  onNew: (event: NostrEvent) => Promise<void>
): Promise<number | undefined> {
  const { seen, collect, saved } = collector(onNew)

  const reached = await Promise.all(
    relays.map(async (url): Promise<number | undefined> => {
      const relay = await pool.ensureRelay(url, { connectionTimeout: MAX_WAIT }).catch(() => null)
      if (!relay) return undefined
      const page = await withReqSlot(() =>
        fetchPage(relay, { authors: [author], kinds: [kind], since, until, limit }, seen, collect)
      )
      if (!page) return undefined
      return page.count === 0 ? (since ?? 0) : page.oldest
    })
  )
  await saved()

  let newest: number | undefined
  for (const r of reached) if (r !== undefined && (newest === undefined || r > newest)) newest = r
  return newest
}

// Saves what a fetch brings, telling onNew of each event the store lacked.
function collector(onNew: (event: NostrEvent) => Promise<void>) {
  const seen = new Set<string>()
  const saving: Promise<unknown>[] = []
  const store = getStore()
  const collect = (event: NostrEvent) => {
    saving.push(
      store
        .saveEvent(event)
        .then(isNew => (isNew ? onNew(event) : undefined))
        .catch(err => console.warn("[sync] saving failed", err))
    )
  }
  return { seen, collect, saved: () => Promise.all(saving) }
}

type Relay = Awaited<ReturnType<typeof pool.ensureRelay>>

// One REQ to one relay until EOSE. Undefined when it failed.
function fetchPage(
  relay: Relay,
  filter: Filter,
  seen: Set<string>,
  collect: (event: NostrEvent) => void
): Promise<{ count: number; oldest: number } | undefined> {
  return new Promise(resolve => {
    let count = 0
    let oldest = Infinity
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok ? { count, oldest } : undefined)
    }
    const sub = relay.subscribe([filter], {
      label: "napp-sync",
      eoseTimeout: MAX_WAIT + 1000,
      alreadyHaveEvent(id) {
        return seen.has(id)
      },
      onevent: event => {
        count++
        if (event.created_at < oldest) oldest = event.created_at
        seen.add(event.id)
        collect(event)
      },
      oneose: () => {
        finish(true)
        sub.close()
      },
      onclose: () => finish(false)
    })
    const timer = setTimeout(() => {
      finish(false)
      sub.close("<timeout>")
    }, MAX_WAIT)
  })
}
