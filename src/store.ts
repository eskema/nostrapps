import { setReplaceableStore } from "@nostr/gadgets/global"
import { RedEventStore } from "@nostr/gadgets/redstore"
import type { Filter } from "@nostr/tools/filter"
import type { NostrEvent } from "@nostr/tools/core"

let instance: RedEventStore | null

export function getStore() {
  if (!instance) {
    instance = new RedEventStore(null)
    setReplaceableStore(instance)
  }
  return instance
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
    instance = null
    if (!old) return
    try {
      await old.close()
    } catch {}
    try {
      // @ts-ignore
      old.worker?.terminate?.()
    } catch {}
  })
}
