import { Index } from "flexsearch"
import { loadNostrUser, nostrUserFromEvent, type NostrUser } from "@nostr/gadgets/metadata"
import { pool } from "@nostr/gadgets/global"
import type { NostrEvent } from "@nostr/tools/core"
import { getStore } from "./store.js"
import { loadSearchRelays } from "./extra-lists.js"
import { getPubkey } from "./account.js"

// Default NIP-50 search relays, used when the user has no kind:10007
// search-relay list (or isn't logged in).
const DEFAULT_SEARCH_RELAYS = ["wss://relay.vertexlab.io", "wss://search.nostrarchives.com/"]

// In-memory full-text index over known profiles. Built once at startup from
// every kind:0 in the local db, then augmented whenever a profile is loaded.
const index = new Index({ tokenize: "forward" })
const users = new Map<string, NostrUser>()

function searchableText(user: NostrUser): string {
  const m = user.metadata ?? {}
  return [m.name, m.display_name, m.nip05, m.about, user.npub, user.pubkey]
    .filter(Boolean)
    .join(" ")
}

// (Re-)index one user. Safe to call on every load — update replaces the old
// entry instead of duplicating it.
export function indexUser(user: NostrUser) {
  if (!user?.pubkey) return
  users.set(user.pubkey, user)
  try {
    if (index.contain(user.pubkey)) index.update(user.pubkey, searchableText(user))
    else index.add(user.pubkey, searchableText(user))
  } catch {
    // A corrupt entry must never break profile loading — the map still has it.
    try {
      index.add(user.pubkey, searchableText(user))
    } catch {}
  }
}

// Same as gadgets' loadNostrUser, but feeds the result into the local index.
export async function loadNostrUserIndexed(
  request: Parameters<typeof loadNostrUser>[0]
): Promise<NostrUser> {
  const user = await loadNostrUser(request)
  indexUser(user)
  return user
}

// Index every kind:0 in the local store (newest event per author wins).
// Fire-and-forget at startup; profiles loaded later augment the index.
export async function buildUserIndex() {
  const events = await getStore().queryEvents({ kinds: [0] })
  const newest = new Map<string, NostrEvent>()
  for (const event of events) {
    const prev = newest.get(event.pubkey)
    if (!prev || event.created_at > prev.created_at) newest.set(event.pubkey, event)
  }
  for (const event of newest.values()) {
    try {
      indexUser(nostrUserFromEvent(event))
    } catch {}
  }
}

// Local lookup over the in-memory index. Returns [] for a blank term.
export function searchUserLocal(term: string, limit = 20): NostrUser[] {
  const q = term?.trim()
  if (!q) return []
  let ids: unknown
  try {
    ids = index.search(q, limit)
  } catch {
    return []
  }
  const flat = (Array.isArray(ids) ? ids.flat(Infinity) : []) as unknown[]
  const out: NostrUser[] = []
  for (const id of flat) {
    if (typeof id !== "string" && typeof id !== "number") continue
    const user = users.get(String(id))
    if (user) out.push(user)
    if (out.length >= limit) break
  }
  return out
}

async function searchRelayUrls(): Promise<string[]> {
  const pk = getPubkey()
  if (pk) {
    try {
      const items = (await loadSearchRelays(pk)).items.filter(Boolean)
      if (items.length) return items
    } catch {}
  }
  return [...DEFAULT_SEARCH_RELAYS]
}

// Remote lookup via a NIP-50 `search` query for kind:0 against the user's
// search relays (or the defaults). Found profiles join the local index.
export async function searchUser(term: string, limit = 20): Promise<NostrUser[]> {
  const q = term?.trim()
  if (!q) return []
  const relays = await searchRelayUrls()
  const events = await pool.querySync(relays, { kinds: [0], search: q, limit }, { maxWait: 4000 })
  const newest = new Map<string, NostrEvent>()
  for (const event of events) {
    const prev = newest.get(event.pubkey)
    if (!prev || event.created_at > prev.created_at) newest.set(event.pubkey, event)
  }
  const out: NostrUser[] = []
  for (const event of newest.values()) {
    try {
      const user = nostrUserFromEvent(event)
      indexUser(user)
      out.push(user)
    } catch {}
    if (out.length >= limit) break
  }
  return out
}
