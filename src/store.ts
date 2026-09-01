import { setReplaceableStore } from "@nostr/gadgets/global"
import { RedEventStore } from "@nostr/gadgets/redstore"
import type { Filter } from "@nostr/tools/filter"
import type { NostrEvent } from "@nostr/tools/core"

// The redstore wasm is single-threaded: any panic inside it (a malformed
// event hitting the binary codec, a bad author in a query) aborts with
// "RuntimeError: unreachable" AND leaves its no_threads mutex locked, so
// every later call fails with "cannot recursively acquire mutex". Nothing
// recovers by itself — so getStore() hands out a stable Proxy facade
// (OutboxManager and host.ts capture the store once) and the poisoned worker
// behind it is torn down and respawned; see guardedCall/respawn below.
let instance: RedEventStore
let facade: RedEventStore | null = null

type RawCall = (method: string, data: any) => Promise<any>
// the current worker's unguarded bridge — quarantine retries go through this
let rawCall: RawCall

function spawn(): RedEventStore {
  const s = new RedEventStore(null)
  const raw = s.call.bind(s)
  s.call = (method, data) => guardedCall(raw, method, data)
  rawCall = raw
  return s
}

export function getStore(): RedEventStore {
  if (!facade) {
    instance = spawn()
    facade = new Proxy({} as RedEventStore, {
      get(_, prop) {
        const v = (instance as any)[prop]
        return typeof v === "function" ? v.bind(instance) : v
      },
      set(_, prop, value) {
        ;(instance as any)[prop] = value
        return true
      }
    })
    setReplaceableStore(facade)
  }
  return facade
}

// bfcache keeps a navigated-away page's dedicated worker ALIVE (heartbeating,
// holding the OPFS lock) — a zombie leader that every live tab then forwards
// to, and that those tabs cannot heal if its wasm dies. Hand leadership back
// when this page is stashed. close() also closes the worker's
// BroadcastChannel, so that worker is spent: a restored page gets a new one
// (not through respawn(), whose cap is for actual wasm deaths).
window.addEventListener("pagehide", () => {
  if (facade) instance.close().catch(() => {})
})
window.addEventListener("pageshow", e => {
  if (!facade || !e.persisted) return
  instance = spawn()
  instance.init().catch(err => console.warn("[redstore] reopen after bfcache failed", err))
})

// Worker rejections are strings ("worker: RuntimeError: unreachable"); the
// save batcher wraps them in Error.
function isWasmDeath(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err)
  return /RuntimeError|unreachable|recursively acquire mutex/.test(s)
}

async function guardedCall(raw: RawCall, method: string, data: any): Promise<any> {
  try {
    return await raw(method, data)
  } catch (err) {
    if (!isWasmDeath(err)) throw err
    const role = respawn()
    // saveEvents is the one call whose payload we can salvage: retry it on
    // the fresh worker, isolating the poisonous event — but only when that
    // worker came up as the leader. If it's a follower, the panic lives in
    // another tab's leader (ours runs no wasm) and probing through it would
    // blame every event; that tab's own guard heals it. Everything else just
    // rejects — the point is that the NEXT call works.
    if (method === "saveEvents" && (await role) === "leader") return retrySaves(data)
    throw err
  }
}

type RespawnResult = "leader" | "follower" | false

let respawning: Promise<RespawnResult> | null = null
let respawnTimes: number[] = []
let gaveUp = false

async function respawn(): Promise<RespawnResult> {
  if (respawning) return respawning
  respawning = (async (): Promise<RespawnResult> => {
    const now = Date.now()
    respawnTimes = respawnTimes.filter(t => now - t < 60_000)
    if (respawnTimes.length >= 3) {
      if (!gaveUp)
        console.error("[redstore] wasm died 3 times inside a minute — leaving the store down")
      gaveUp = true
      return false
    }
    respawnTimes.push(now)

    // close() releases the OPFS handle JS-side even with a dead wasm and
    // broadcasts so a follower tab can take over leadership; terminate
    // regardless, racing a timeout in case the worker is fully hung.
    const old = instance
    try {
      await Promise.race([old.close(), new Promise(r => setTimeout(r, 1000))])
    } catch {}
    try {
      ;(old as any).worker?.terminate?.()
    } catch {}

    // small backoff so OPFS actually releases the file lock
    await new Promise(r => setTimeout(r, 300 * respawnTimes.length))

    const fresh = spawn()
    let leader: boolean
    try {
      leader = await fresh.init()
    } catch (err) {
      try {
        ;(fresh as any).worker?.terminate?.()
      } catch {}
      console.error("[redstore] respawn failed", err)
      return false
    }
    instance = fresh
    gaveUp = false
    console.warn(`[redstore] store worker respawned (${leader ? "leader" : "follower"})`)
    return leader ? "leader" : "follower"
  })().finally(() => {
    respawning = null
  })
  return respawning
}

const utf8Decoder = new TextDecoder()

// A saveEvents batch died: something in it panics the wasm codec. Retry it
// one event at a time on the respawned worker — clean events save, the
// poisonous one is logged (that JSON is the upstream repro) and reported as
// not-new. Each poison hit costs another respawn, so several killers in one
// batch still drain, cap permitting.
async function retrySaves(data: { lastAttempts: number[]; rawEvents: Uint8Array[] }) {
  const results: boolean[] = []
  for (let i = 0; i < data.rawEvents.length; i++) {
    try {
      const r = await rawCall("saveEvents", {
        lastAttempts: [data.lastAttempts[i]],
        rawEvents: [data.rawEvents[i]]
      })
      results.push(!!r?.[0])
    } catch (err) {
      if (!isWasmDeath(err)) {
        results.push(false)
        continue
      }
      console.error("[redstore-poison]", utf8Decoder.decode(data.rawEvents[i]))
      results.push(false)
      if ((await respawn()) !== "leader") throw err
    }
  }
  return results
}

// redstore merge bug workaround. execute() in redstore's src/query.rs merges
// one index sub-query per (author, kind) pair; its ordering barrier
// (top_query_timestamp) is computed over ALL sub-queries' buffered floors —
// including EXHAUSTED ones, which by definition deliver nothing more. When
// every sub-query exhausts on its first pull (the norm for replaceable
// kinds: one event per pair), the newest event's timestamp blocks all older
// events from the other pairs and the last_run break abandons them — so
// {authors: [me], kinds: [10002, 10007]} returns ONLY the newest event
// (observed 2026-08-16: publishing a kind 10007 made the relays napp lose
// the 10002). A single sub-query cannot be blocked by its own floor, so
// until the barrier skips exhausted queries upstream, split sparse
// multi-pair filters into single-pair queries and merge here.
const isSparseKind = (k: number) =>
  k === 0 || k === 3 || (k >= 10000 && k < 20000) || (k >= 30000 && k < 40000)

export async function safeQueryEvents(filter: Filter, maxLimit?: number): Promise<NostrEvent[]> {
  const store = getStore()
  const { authors, kinds } = filter
  const pairs = (authors?.length || 0) * (kinds?.length || 0)
  if (!authors || !kinds || pairs <= 1 || pairs > 64 || !kinds.every(isSparseKind)) {
    return store.queryEvents(filter, maxLimit)
  }
  const chunks = await Promise.all(
    authors.flatMap(author =>
      kinds.map(kind => store.queryEvents({ ...filter, authors: [author], kinds: [kind] }, maxLimit))
    )
  )
  const merged = chunks.flat().sort((a, b) => b.created_at - a.created_at)
  const limit = Math.min(filter.limit ?? Infinity, maxLimit ?? Infinity)
  return Number.isFinite(limit) ? merged.slice(0, limit) : merged
}

// Vite HMR: when this module reloads, the old RedEventStore worker still
// holds the OPFS access handle. Dispose it so the new instance can reopen
// the SQLite file. Without this, dev-mode HMR makes every nostrdb.* call
// hang behind a NoModificationAllowedError on the locked file.
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const old = instance
    if (!old) return
    try {
      await old.close()
    } catch {}
    try {
      ;(old as any).worker?.terminate?.()
    } catch {}
  })
}
