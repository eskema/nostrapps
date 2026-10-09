// napp.sync: bring an (author, kind) range into the store from the author's
// write relays, remembering in redstore's outbox bounds what is already here
// so a later call for a range we hold asks no relay at all.
//
// A bound is one contiguous [oldest, newest] per author and kind. A call
// fetches only what lies outside it — and the gap between the two when the
// range asked for is disjoint from it, so the bound stays one piece.

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

export async function sync(
  authors: string[],
  kinds: number[],
  since: number,
  until: number,
  opts: { force?: boolean; onNew: (event: NostrEvent) => Promise<void> | void }
): Promise<SyncResult> {
  // nothing past now can be known complete
  until = Math.min(until, Math.round(Date.now() / 1000))
  if (since > until) return { success: true, newEvents: 0 }

  let newEvents = 0
  const errors: string[] = []
  await Promise.all(
    authors.flatMap(author =>
      kinds.map(kind =>
        serialize(`${author}:${kind}`, () =>
          syncPair(author, kind, since, until, !!opts.force, async event => {
            newEvents++
            await opts.onNew(event)
          })
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
  force: boolean,
  onNew: (event: NostrEvent) => Promise<void>
) {
  const key = `${author}:${kind}`
  const b = (await loadBounds()).get(key)

  // the ranges to ask for, newest first
  const segments: Bound[] = []
  if (!b) segments.push([since, until])
  else if (force) {
    // the whole range, stretched over any gap to the bound
    segments.push([Math.min(since, b[1]), Math.max(until, b[0])])
  } else {
    // what lies above the bound, and what lies below it
    if (until > b[1]) segments.push([b[1], until])
    if (since < b[0]) segments.push([since, b[0]])
  }
  if (segments.length === 0) return

  const relays = await authorRelays(author, kind)
  const failures: string[] = []
  for (const [lo, hi] of segments) {
    const coveredDownTo = await fetchRange(
      relays,
      { authors: [author], kinds: [kind] },
      lo,
      hi,
      onNew
    )
    if (coveredDownTo === undefined) {
      failures.push(`no relay answered for ${lo}–${hi}`)
      continue
    }
    const all = await loadBounds()
    const next = merge(all.get(key), coveredDownTo, hi)
    all.set(key, next)
    await getStore().setOutboxBound(author, kind, next)
  }
  if (failures.length) throw new Error(failures.join(", "))
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
async function fetchRange(
  relays: string[],
  base: Filter,
  lo: number,
  hi: number,
  onNew: (event: NostrEvent) => Promise<void>
): Promise<number | undefined> {
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

  const coverages = await Promise.all(
    relays.map(async (url): Promise<number | undefined> => {
      const relay = await pool.ensureRelay(url, { connectionTimeout: MAX_WAIT }).catch(() => null)
      if (!relay) return undefined

      let until = hi
      let downTo: number | undefined
      for (let p = 0; p < MAX_PAGES; p++) {
        const page = await withReqSlot(() =>
          fetchPage(relay, { ...base, since: lo, until, limit: PAGE_LIMIT }, seen, collect)
        )
        if (!page) return downTo // timed out or CLOSED: keep what earlier pages proved
        // only an empty page means the relay has nothing more: a short one may
        // be the relay capping our limit silently
        if (page.count === 0) return lo
        if (page.oldest >= until) {
          // all from the same second we already asked down to
          return page.count < PAGE_LIMIT ? lo : downTo
        }
        // the oldest second may be cut short, so it is asked again
        downTo = page.oldest + 1
        until = page.oldest
      }
      return downTo
    })
  )
  await Promise.all(saving)

  let coveredDownTo: number | undefined
  for (const c of coverages)
    if (c !== undefined && (coveredDownTo === undefined || c > coveredDownTo)) coveredDownTo = c
  return coveredDownTo
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
      onevent: event => {
        count++
        if (event.created_at < oldest) oldest = event.created_at
        if (seen.has(event.id)) return
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
