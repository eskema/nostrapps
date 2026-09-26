import { matchFilter, type Filter } from "@nostr/tools/filter"
import type { NostrEvent } from "@nostr/tools/core"

// ─── store subscriptions (trial) ─────────────────────────────────
// A filter held open on the store: every event saved from then on that
// matches it, whichever door it came through (a feed's relays, the outbox
// sync, the loaders, a napp, another tab), and word of any removal. What was
// stored before comes from a query.
//
// Napp feeds get what lands here unless localStorage "nostrapps:feeds" says
// "usual" (off) or "compare" (the usual delivery only, this runs beside it and
// differences go to the logs window). Taking it out: this file, its calls in
// store.ts, the store subscription section in host.ts.

export const feedsMode: "store" | "compare" | null = (() => {
  try {
    const mode = localStorage.getItem("nostrapps:feeds")
    return mode === "usual" ? null : mode === "compare" ? "compare" : "store"
  } catch {
    return "store"
  }
})()

type Sub = { filter: Filter; onevent: (event: NostrEvent) => void; onremove: () => void }
const subs = new Set<Sub>()

export function subscribeStore(
  filter: Filter,
  onevent: (event: NostrEvent) => void,
  onremove: () => void
): () => void {
  const sub = { filter, onevent, onremove }
  subs.add(sub)
  return () => {
    subs.delete(sub)
  }
}

function deliver(events: NostrEvent[]) {
  for (const sub of subs) {
    for (const event of events) {
      if (!matchFilter(sub.filter, event)) continue
      try {
        sub.onevent(event)
      } catch (err) {
        console.warn("[store-subs] onevent failed", err)
      }
    }
  }
}

function removed() {
  for (const sub of subs) {
    try {
      sub.onremove()
    } catch (err) {
      console.warn("[store-subs] onremove failed", err)
    }
  }
}

// The store worker is shared by every tab, the doors to it are not: each tab
// tells the others what it saved or removed.
const channel =
  feedsMode && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("nostrapps:store-subs")
    : null
channel?.addEventListener("message", ({ data }) => {
  if (Array.isArray(data?.saved)) deliver(data.saved)
  if (data?.removed) removed()
})

let outgoing: NostrEvent[] = []

// Called by the store once a save went in.
export function storeSaved(event: NostrEvent) {
  if (!feedsMode) return
  deliver([event])
  if (!channel) return
  const { id, pubkey, created_at, kind, tags, content, sig } = event
  // a save batch resolves all at once: one message for it
  if (outgoing.push({ id, pubkey, created_at, kind, tags, content, sig }) === 1)
    setTimeout(() => {
      channel.postMessage({ saved: outgoing })
      outgoing = []
    }, 0)
}

// Called by the store once something was deleted from it.
export function storeRemoved() {
  if (!feedsMode) return
  removed()
  channel?.postMessage({ removed: true })
}
