import { pool, setRelayPicker } from "@nostr/gadgets/global"
import { OutboxManager } from "@nostr/gadgets/outbox"
import { loadFollowsList } from "@nostr/gadgets/lists"
import { globalism } from "@nostr/gadgets/utils"
import { NostrEvent } from "@nostr/tools/core"
import { getStore } from "./store"

export const FALLBACK_RELAYS = ["relay.damus.io", "relay.primal.net", "nos.lol"]
const DEFAULT_KINDS = [1, 1111]

let globalSyncAbort: AbortController | null = null
let syncStartTimer: ReturnType<typeof setTimeout> | null = null
let relayPopularityRanking: string[] = []
let liveTargets: string[] = []
let startSignal: AbortSignal | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined

export const status: { syncing: true; pubkey: string } | { syncing: undefined | false } = {
  syncing: undefined
}

// Created on the next macrotask, so it's `undefined` during the synchronous
// boot/restore pass. Callers must guard (`outbox?.…`) — e.g. stopOutbox() runs
// while a settings window is being restored before this timer fires.
export let outbox: OutboxManager

function recreateOutbox() {
  if (outbox) outbox.close()

  outbox = new OutboxManager(getStore(), {
    pool,
    label: "nostrapps",
    onsyncupdate(pubkey) {
      console.debug(":: synced updating", pubkey)
      for (let i = 0; i < current.onsync.length; i++) {
        current.onsync[i](pubkey)
      }
    },
    onbeforeupdate(pubkey) {
      for (let i = 0; i < current.onbefore.length; i++) {
        current.onbefore[i](pubkey)
      }
    },
    onliveupdate(event) {
      console.debug(":: live", event)
      for (let i = 0; i < current.onnew.length; i++) {
        current.onnew[i](event)
      }
    },
    defaultRelaysForConfusedPeople: FALLBACK_RELAYS,
    storeRelaysSeenOn: true
  })
}

setTimeout(() => recreateOutbox(), 0)

function resync() {
  if (!liveTargets.length) return

  resetPromises()

  syncInternal()
}

export function stopOutbox() {
  if (syncStartTimer) {
    clearTimeout(syncStartTimer)
    syncStartTimer = null
  }
  globalSyncAbort?.abort("<logged-out>")
  globalSyncAbort = null
  clearInterval(refreshTimer)
  refreshTimer = undefined
  outbox?.close()
  liveTargets = []
  relayPopularityRanking = []
  status.syncing = undefined
  resetPromises()
}

export const current: {
  onsync: Array<(pubkey?: string) => void>
  onbefore: Array<(pubkey: string) => void>
  onnew: Array<(event: NostrEvent) => void>
} = { onsync: [], onbefore: [], onnew: [] }

let isReady: () => void
let _ready: Promise<void>

function resetPromises() {
  _ready = new Promise<void>(resolve => {
    isReady = resolve
  })
}

resetPromises()

export async function ready(): Promise<void> {
  return _ready
}

// ─── live mode (opt-in) ──────────────────────────────────────────
// Sync alone no longer opens live subscriptions — those are only started when
// something actually asks (e.g. an open napp feed calls goLive). Requests
// accumulate: the OutboxManager marks already-live author/kind pairs as
// permanent and skips them, so overlapping calls are cheap and idempotent.
export function goLive(opts?: { authors?: string[]; kinds?: number[] }) {
  if (!outbox) return
  // live() mutates the arrays it's given — always hand it copies.
  const authors = opts?.authors?.length ? [...opts.authors] : liveTargets.slice()
  const kinds = opts?.kinds?.length ? [...opts.kinds] : DEFAULT_KINDS.slice()
  if (!authors.length) return
  outbox.live(authors, kinds, { signal: undefined }).catch(err => {
    console.warn("failed to start live subscriptions", err)
  })
}

export async function startOutbox(pubkey: string) {
  // tear down any previous sync
  if (syncStartTimer) {
    clearTimeout(syncStartTimer)
    syncStartTimer = null
  }
  if (globalSyncAbort) {
    globalSyncAbort.abort("<account-changed>")
    globalSyncAbort = null
  }
  recreateOutbox()

  let followings: string[] = []
  try {
    const result = await loadFollowsList(pubkey)
    followings = result.items
  } catch (err) {
    console.warn("failed to load follows list", err)
  }

  // Rank relays by how prevalent they are across our follows' relay lists,
  // then make the pool prefer the top two when picking where to read from.
  const rankingPool = Array.from(new Set([pubkey, ...followings]))
  if (rankingPool.length > 0) {
    const rank = await globalism(rankingPool)
    relayPopularityRanking = rank
    setRelayPicker(candidates => {
      const urls: string[] = candidates.length === 0 ? [] : candidates.map(r => r.url)
      if (relayPopularityRanking.length === 0) return urls.slice(0, 2)

      return [...urls]
        .sort((a, b) => relayPopularityRanking.indexOf(a) - relayPopularityRanking.indexOf(b))
        .slice(0, 2)
    })
  }

  globalSyncAbort = new AbortController()
  const abort = globalSyncAbort

  // Give the login path a moment to settle (first paints, fallback queries)
  // before the heavy sync starts.
  syncStartTimer = setTimeout(() => {
    syncStartTimer = null
    start(pubkey, followings, abort.signal)
  }, 5000)
}

async function start(account: string, followings: string[], signal: AbortSignal) {
  ;(status as Extract<typeof status, { syncing: true }>).pubkey = account

  resetPromises()

  const known = new Set<string>()
  if (account) known.add(account)
  for (const pk of followings) known.add(pk)

  liveTargets = Array.from(known)
  startSignal = signal

  clearInterval(refreshTimer)
  syncInternal()
  refreshTimer = setInterval(resync, 1000 * 60 * 30 /* 30 minutes */)
}

async function syncInternal() {
  startSignal!.onabort = () => {
    status.syncing = undefined
  }

  // With a big following, probabilistically skip authors whose newest stored
  // event is old — full effort for active accounts, decaying to ~90% skipped
  // for ones silent for two months. Keeps the periodic resync affordable.
  let syncTargets = liveTargets
  if (liveTargets.length > 100) {
    const now = Math.floor(Date.now() / 1000)
    const fullAbandonDays = 60

    const keep = await Promise.all(
      liveTargets.map(async pubkey => {
        const events = await getStore().queryEvents({ authors: [pubkey], kinds: DEFAULT_KINDS }, 1)
        if (events.length === 0) return true
        const ageDays = (now - events[0].created_at) / 86400
        if (ageDays <= 3) return true
        const p = Math.min(0.9, (ageDays - 3) / (fullAbandonDays - 3))
        const skip = Math.random() < p
        if (skip) console.debug(":: outbox skip inactive target", pubkey, `${ageDays.toFixed(1)}d`)
        return !skip
      })
    )
    syncTargets = liveTargets.filter((_, i) => keep[i])
  }

  status.syncing = true

  if (0 === (await getStore().queryEvents({}, 1)).length) {
    // this means the database has no events.
    // let's wait some time to do our first sync, as the user right now is likely to
    // be doing the preliminary fallback query and we don't want to interfere with it
    await new Promise(resolve => setTimeout(resolve, 15000))
  }

  const hasNew = await outbox.sync(syncTargets, DEFAULT_KINDS, {
    signal: startSignal!
  })

  if (hasNew) {
    for (let i = 0; i < current.onsync.length; i++) {
      current.onsync[i]()
    }
  }

  status.syncing = false
  isReady()
}
