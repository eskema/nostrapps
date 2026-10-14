import { Index } from "flexsearch"
import { loadNostrUser, nostrUserFromEvent, type NostrUser } from "@nostr/gadgets/metadata"
import { pool } from "@nostr/gadgets/global"
import type { NostrEvent } from "@nostr/tools/core"
import { getStore } from "./store.js"
import { getPubkey } from "./account.js"
import { loadFollowsList, loadMuteList, loadSearchRelays } from "@nostr/gadgets/lists"
import { decode } from "@nostr/tools/nip19"
import { isNip05, queryProfile } from "@nostr/tools/nip05"

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

// ─── author picking ────────────────────────────────────────────────
// What an author picker lists for a term (napp.utils.findAuthors, and the
// kit's authorPicker through it): one person for an identifier (npub,
// nprofile, hex), else the known profiles that match, the viewer's follows
// first and then names starting with the term. An empty term lists the
// follows. Muted people never show. Both network steps are asked for:
// `remote`, relay search fills up the rest; `nip05`, a typed name@domain is
// resolved to its person and each row's nip-05 is checked against its pubkey
// (one that doesn't point back is blanked). Rows are flat, a kind 0's content
// plus the pubkey and whether the viewer follows them, so a picker can paint
// them without asking again.

export interface FoundAuthor {
  pubkey: string
  name: string
  display_name: string
  picture: string
  nip05: string
  follows: boolean
}

const HEX_PUBKEY = /^[0-9a-f]{64}$/i
// name@domain.tld only: a bare domain is a valid nip-05 too, but every word
// with a dot typed into a picker would go out to the network as one.
const NIP05_ADDRESS = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))
  ])
}

// List loaders can hang on a relay that never answers: give up and go on
// without (no follows first, no mutes left out).
async function listPubkeys(load: Promise<{ items: unknown[] }>): Promise<string[]> {
  try {
    const { items } = await within(load, 3000)
    return items
      .map(i => (typeof i === "string" ? i : (i as { value?: unknown })?.value))
      .filter((v): v is string => typeof v === "string" && HEX_PUBKEY.test(v))
  } catch {
    return []
  }
}

async function identifierPubkey(q: string, nip05: boolean): Promise<string | null> {
  if (HEX_PUBKEY.test(q)) return q.toLowerCase()
  if (/^(npub|nprofile)1[02-9ac-hj-np-z]+$/.test(q)) {
    try {
      const { type, data } = decode(q)
      if (type === "npub") return data
      if (type === "nprofile") return data.pubkey
    } catch {}
    return null
  }
  if (nip05 && NIP05_ADDRESS.test(q)) {
    try {
      return (await within(queryProfile(q), 4000))?.pubkey ?? null
    } catch {}
  }
  return null
}

// Whether a nip-05 points back at this pubkey, asked once a session; a lookup
// that failed (not a mismatch) is asked again next time.
const nip05Checks = new Map<string, Promise<boolean>>()
function nip05Points(address: string, pubkey: string): Promise<boolean> {
  if (!isNip05(address)) return Promise.resolve(false)
  const key = `${address.toLowerCase()} ${pubkey}`
  let check = nip05Checks.get(key)
  if (!check) {
    check = within(queryProfile(address), 3000).then(
      p => p?.pubkey === pubkey,
      () => {
        nip05Checks.delete(key)
        return false
      }
    )
    nip05Checks.set(key, check)
  }
  return check
}

export async function findAuthors(
  term: string,
  opts: { limit?: number; remote?: boolean; nip05?: boolean } = {}
): Promise<FoundAuthor[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(Number(opts.limit) || 12)))
  const remote = opts.remote === true
  const nip05 = opts.nip05 === true
  const q = String(term ?? "")
    .trim()
    .replace(/^@/, "")
    .replace(/^nostr:/i, "")
  const me = getPubkey()
  const [follows, mutes] = await Promise.all([
    me ? listPubkeys(loadFollowsList(me)) : [],
    me ? listPubkeys(loadMuteList(me)) : []
  ])
  const followed = new Set(follows)
  const muted = new Set(mutes)
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const row = (pubkey: string): FoundAuthor => {
    const user = users.get(pubkey)
    const m = (user?.metadata ?? {}) as Record<string, unknown>
    return {
      pubkey,
      name: text(m.name),
      display_name: text(m.display_name),
      picture: text(user?.image) || text(m.picture),
      nip05: text(m.nip05),
      follows: followed.has(pubkey)
    }
  }

  const checked = async (rows: FoundAuthor[]) => {
    if (nip05)
      await Promise.all(
        rows.map(async a => {
          if (a.nip05 && !(await nip05Points(a.nip05, a.pubkey))) a.nip05 = ""
        })
      )
    return rows
  }

  const direct = await identifierPubkey(q, nip05)
  if (direct) {
    if (!users.has(direct)) await within(loadNostrUserIndexed(direct), 4000).catch(() => {})
    return checked([row(direct)])
  }
  if (!q)
    return checked(
      follows
        .filter(pk => !muted.has(pk))
        .slice(0, limit)
        .map(row)
    )

  const seen = new Set<string>()
  const found: FoundAuthor[] = []
  const add = (pubkey: string) => {
    if (seen.has(pubkey) || muted.has(pubkey)) return
    seen.add(pubkey)
    found.push(row(pubkey))
  }
  for (const user of searchUserLocal(q, 60)) add(user.pubkey)
  if (remote && found.length < limit)
    for (const user of await searchUser(q, limit).catch(() => [])) add(user.pubkey)

  const lower = q.toLowerCase()
  const starts = (a: FoundAuthor) =>
    [a.name, a.display_name, a.nip05].some(s => s.toLowerCase().startsWith(lower))
  const rank = (a: FoundAuthor) => (a.follows ? 2 : 0) + (starts(a) ? 1 : 0)
  return checked(
    found
      .map((a, i) => ({ a, i }))
      .sort((x, y) => rank(y.a) - rank(x.a) || x.i - y.i)
      .slice(0, limit)
      .map(x => x.a)
  )
}
