// Relay health: what the NIP-66 monitors say about each relay, for the outbox
// relay picker and for napps (napp.relays.health).
//
// Monitors publish a kind 30166 check-in per relay (d = the relay url) on each
// round, from many places. A relay is
//   online   when some monitor checked it in within ONLINE_WINDOW,
//   offline  when monitors checked it this week, but none that recently,
//   unknown  when no monitor has checked it this week (never tracked, or long
//            gone): not the same thing as offline.
// Asking is batched: relays nobody asked about wait in a queue, and one query
// per batch goes to the monitor relays. Kept in memory only: a relay gets a
// dozen check-ins of ~1.3 KB each, too much to keep in the store for the few
// seconds a reload would save.

import { pool } from "@nostr/gadgets/global"
import { normalizeURL } from "@nostr/tools/utils"
import type { NostrEvent } from "@nostr/tools/core"

const MONITOR_RELAYS = ["wss://relay.nostr.watch", "wss://relaypag.es"]
const ONLINE_WINDOW = 2 * 3600 // s; active monitors check every 15–60 min
const LOOKBACK = 7 * 86400 // s; older check-ins are from monitors that stopped
const REFRESH_AFTER = 30 * 60_000 // ms
const RETRY_AFTER = 5 * 60_000 // ms, when the monitors didn't answer at all
// ~12 check-ins per relay: a batch stays under the 500 events relays commonly
// cap a query at
const BATCH = 25
const QUERY_CAP = 500
const BATCH_DELAY = 3000 // ms

export type RelayStatus = "online" | "offline" | "unknown"

export interface RelayHealth {
  url: string
  status: RelayStatus
  // the freshest check-in, unix seconds
  checkedAt: number | null
  // median time to open a connection, over the recent check-ins, in ms
  rtt: number | null
  nips: number[] | null
  // what the relay requires: "auth", "payment", "pow", "restricted"…
  // [] when monitors say it requires nothing, null when nobody said
  requires: string[] | null
}

type Known = Omit<RelayHealth, "url"> & { askedAt: number }

const known = new Map<string, Known>()
const queue = new Set<string>()
const inflight = new Map<string, Promise<void>>()
let timer: ReturnType<typeof setTimeout> | null = null

function norm(url: string): string | null {
  try {
    const u = normalizeURL(url)
    return /^wss?:\/\//.test(u) ? u : null
  } catch {
    return null
  }
}

// What the check-ins about one relay add up to, as of when the monitors were
// asked.
function verdict(events: NostrEvent[], askedAt: number): Known {
  const now = Math.floor(askedAt / 1000)
  const recent = events.filter(e => e.created_at >= now - LOOKBACK)
  if (!recent.length)
    return { status: "unknown", checkedAt: null, rtt: null, nips: null, requires: null, askedAt }
  recent.sort((a, b) => b.created_at - a.created_at)
  const checkedAt = recent[0].created_at
  const fresh = recent.filter(e => e.created_at >= now - ONLINE_WINDOW)
  const status: RelayStatus = fresh.length ? "online" : "offline"

  const rtts = (fresh.length ? fresh : recent.slice(0, 1))
    .map(e => Number(e.tags.find(t => t[0] === "rtt-open")?.[1]))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  const rtt = rtts.length ? Math.round(rtts[Math.floor(rtts.length / 2)]) : null

  // not every monitor reads NIP-11: the freshest check-in that did
  const withN = recent.find(e => e.tags.some(t => t[0] === "N"))
  const nips = withN
    ? [...new Set(withN.tags.filter(t => t[0] === "N").map(t => Number(t[1])))].filter(
        Number.isInteger
      )
    : null
  const withR = recent.find(e => e.tags.some(t => t[0] === "R" && t[1]))
  const requires = withR
    ? withR.tags.filter(t => t[0] === "R" && t[1] && !t[1].startsWith("!")).map(t => t[1])
    : null

  return { status, checkedAt, rtt, nips, requires, askedAt }
}

function byRelay(events: NostrEvent[]): Map<string, NostrEvent[]> {
  const out = new Map<string, NostrEvent[]>()
  for (const e of events) {
    const d = e.tags.find(t => t[0] === "d")?.[1]
    const url = d && norm(d)
    if (!url) continue
    let list = out.get(url)
    if (!list) out.set(url, (list = []))
    list.push(e)
  }
  return out
}

async function ask(urls: string[]): Promise<void> {
  // monitors write d as URL().href; normalizeURL drops a path's trailing slash
  const ds = new Set<string>()
  for (const u of urls) {
    ds.add(u)
    try {
      ds.add(new URL(u).href)
    } catch {}
  }
  const askedAt = Date.now()
  const events = await pool.querySync(
    MONITOR_RELAYS,
    { kinds: [30166], "#d": [...ds], since: Math.floor(askedAt / 1000) - LOOKBACK },
    { label: "relay-health", maxWait: 6000 }
  )
  // Nothing at all back is the monitors failing, not every relay gone:
  // leave what we knew, and try again later.
  if (!events.length) {
    for (const u of urls) {
      const k = known.get(u)
      if (k) k.askedAt = askedAt - REFRESH_AFTER + RETRY_AFTER
      else known.set(u, { ...verdict([], askedAt), askedAt: askedAt - REFRESH_AFTER + RETRY_AFTER })
    }
    return
  }
  const grouped = byRelay(events)
  // A capped answer may have cut a relay's fresh check-ins off: that must not
  // read as offline, so it reads as unknown this round.
  const capped = events.length >= QUERY_CAP
  for (const u of urls) {
    const v = verdict(grouped.get(u) ?? [], askedAt)
    if (capped && v.status === "offline") v.status = "unknown"
    known.set(u, v)
  }
}

function flush() {
  timer = null
  const urls = [...queue]
  queue.clear()
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH)
    const p = ask(batch)
      .catch(err => console.warn("[relay-health] asking the monitors failed", err))
      .finally(() => {
        for (const u of batch) if (inflight.get(u) === p) inflight.delete(u)
      })
    for (const u of batch) inflight.set(u, p)
  }
}

function want(url: string) {
  const k = known.get(url)
  if (inflight.has(url) || (k && Date.now() - k.askedAt < REFRESH_AFTER)) return
  queue.add(url)
  timer ??= setTimeout(flush, BATCH_DELAY)
}

function health(url: string): RelayHealth {
  const k = known.get(url)
  if (!k) return { url, status: "unknown", checkedAt: null, rtt: null, nips: null, requires: null }
  const { askedAt: _, ...facts } = k
  return { url, ...facts }
}

// What is known right now, without waiting. Relays not known yet (or known a
// while ago) are queued for the next batch.
export function relayHealthNow(url: string): RelayHealth | null {
  const u = norm(url)
  if (!u) return null
  want(u)
  return health(u)
}

// Ask about these relays and wait for the answer, up to `waitMs`; whatever
// hasn't come back by then is returned as it stands (unknown, at first).
export async function relayHealth(urls: string[], waitMs = 6000): Promise<RelayHealth[]> {
  const list = [...new Set(urls.map(norm).filter((u): u is string => !!u))]
  for (const u of list) want(u)
  if (queue.size) {
    if (timer) clearTimeout(timer)
    flush()
  }
  const pending = [...new Set(list.map(u => inflight.get(u)).filter(Boolean))]
  if (pending.length)
    await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, waitMs))])
  return list.map(health)
}
