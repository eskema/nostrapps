// Vite raw-text imports (e.g. the napplet bridge inlined into a srcdoc).
declare module "*?raw" {
  const src: string
  export default src
}

// ── Nostr core types (same as from @nostr/tools) ──────────────────────────
type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

type EventTemplate = {
  kind: number
  tags: string[][]
  content: string
  created_at: number
}

interface VerifiedEvent extends NostrEvent {
  [verifiedSymbol]: true
}

declare const verifiedSymbol: unique symbol

// ── NIP-07 signer ────────────────────────────────────────────────────────
type NostrNip04 = {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}

type NostrNip44 = {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}

type NostrSigner = {
  getPublicKey(): Promise<string>
  signEvent(evt: EventTemplate): Promise<VerifiedEvent>
  nip04: NostrNip04
  nip44: NostrNip44
}

// ── Event store (NIP-DB) ─────────────────────────────────────────────────
type NostrDB = {
  add(event: NostrEvent): Promise<void>
  query(filters: unknown): Promise<NostrEvent[]>
  count(filters: unknown): Promise<number>
  event(id: string): Promise<NostrEvent | undefined>
  remove(ids: string[]): Promise<string[]>
  replaceable(kind: number, author: string, identifier?: string): Promise<NostrEvent | undefined>
  supports(): string[]
}

// ── NIP-51 list helpers ──────────────────────────────────────────────────
type RelayItem = {
  url: string
  read: boolean
  write: boolean
}

type ListResult<I> = {
  event: NostrEvent | null
  items: I[]
}

// ── NIP-51 list item shapes (mirror @nostr/gadgets/lists) ─────────────────
type AddressPointer = {
  identifier: string
  pubkey: string
  kind: number
  relays: string[]
}

type EventPointer = {
  id: string
  kind?: number
  relays?: string[]
  author?: string
}

type Emoji = {
  shortcode: string
  url: string
}

type SimpleGroupItem = {
  groupId: string
  relay: string
  name?: string
}

type ResolvedSet<I> = {
  pointer: AddressPointer
  event: NostrEvent | null
  items: I[]
  title: string
  image?: string
  description?: string
}

// ── Addressable set helpers ──────────────────────────────────────────────
type SetResult<I> = {
  event: NostrEvent | null
  items: I[]
}

// ── Profile metadata ─────────────────────────────────────────────────────
type ProfileMetadata = {
  name?: string
  picture?: string
  about?: string
  display_name?: string
  website?: string
  banner?: string
  nip05?: string
  lud16?: string
  lud06?: string
}

type NostrUser = {
  pubkey: string
  npub: string
  shortName: string
  image?: string
  metadata: ProfileMetadata
  lastUpdated: number
}

type NostrUserRequest = {
  pubkey: string
  relays?: string[]
  refreshStyle?: boolean | NostrEvent | null
}

// ── Relay info (NIP-11) ─────────────────────────────────────────────────
type RelayInfoDocument = {
  url: string
  name?: string
  description?: string
  icon?: string
  pubkey?: string
  contact?: string
  supported_nips?: number[]
  software?: string
  version?: string
}

// ── Publishing result ────────────────────────────────────────────────────
type PublishResult = {
  relays: { [url: string]: { ok: boolean; error?: string } }
  published: number
  failed: number
}

// ── Feed subscription ────────────────────────────────────────────────────
type FeedHandle = {
  close(): void
}

type FeedCallback = (events: NostrEvent[], synced: boolean) => void

type FeedOpts = {
  since?: number
  until?: number
  limit?: number
}

type NappFeeds = {
  profile(pubkey: string, kinds: number[], callback: FeedCallback, opts?: FeedOpts): FeedHandle
  following(source: string, kinds: number[], callback: FeedCallback, opts?: FeedOpts): FeedHandle
  inbox(
    pubkey: string | string[],
    kinds: number[],
    callback: FeedCallback,
    opts?: FeedOpts
  ): FeedHandle
  outbox(
    pubkeys: string | string[],
    kinds: number[],
    callback: FeedCallback,
    opts?: FeedOpts
  ): FeedHandle
}

// ── Data-loading utils ───────────────────────────────────────────────────
type NappUtils = {
  // NIP-51 lists — accepts hex pubkey, npub, or nprofile
  loadRelayList(pubkey: string): Promise<ListResult<RelayItem>>
  loadFollowsList(pubkey: string): Promise<ListResult<string>>
  loadMuteList(pubkey: string): Promise<ListResult<string>>
  loadBookmarks(pubkey: string): Promise<ListResult<string>>
  loadPins(pubkey: string): Promise<ListResult<string>>
  loadBlossomServers(pubkey: string): Promise<ListResult<string>>
  loadEmojis(pubkey: string): Promise<ListResult<string>>
  loadFavoriteRelays(pubkey: string): Promise<ListResult<string>>
  loadBlockedRelays(pubkey: string): Promise<ListResult<string>>
  loadSearchRelays(pubkey: string): Promise<ListResult<string>>
  loadDmRelays(pubkey: string): Promise<ListResult<string>>
  loadWikiAuthors(pubkey: string): Promise<ListResult<string>>
  loadWikiRelays(pubkey: string): Promise<ListResult<string>>
  loadFavoriteFollowSets(pubkey: string): Promise<ListResult<AddressPointer>> // kind 10021
  loadFavoriteScrolls(pubkey: string): Promise<ListResult<EventPointer>> // kind 10027
  loadProfileBadges(pubkey: string): Promise<ListResult<string | AddressPointer>> // kind 10008
  loadSimpleGroups(pubkey: string): Promise<ListResult<SimpleGroupItem>> // kind 10009
  loadGitAuthors(pubkey: string): Promise<ListResult<string>> // kind 10017
  loadGitRepositories(pubkey: string): Promise<ListResult<string>> // kind 10018
  loadMediaFollows(pubkey: string): Promise<ListResult<string>> // kind 10020
  loadFavoritePodcasts(pubkey: string): Promise<ListResult<string>> // kind 10054
  loadAuthoredPodcasts(pubkey: string): Promise<ListResult<string>> // kind 10064

  // Composite helpers resolving address-pointer items into their sets
  fetchFavoriteRelaysWithSets(pubkey: string): Promise<Array<string | ResolvedSet<string>>>
  fetchEmojisWithSets(pubkey: string): Promise<Array<Emoji | ResolvedSet<Emoji>>>
  fetchFavoriteFollowSetsWithSets(pubkey: string): Promise<Array<ResolvedSet<string>>>

  // Addressable sets
  loadFollowSets(pubkey: string): Promise<SetResult<string>>
  loadRelaySets(pubkey: string): Promise<SetResult<string>>
  loadEmojiSets(pubkey: string): Promise<SetResult<string>>

  // Relay info
  loadRelayInfo(url: string): Promise<RelayInfoDocument | null>

  // Profile metadata
  loadNostrUser(request: NostrUserRequest | string): Promise<NostrUser>

  // Local full-text profile search over the launcher's in-memory index
  // (built from stored kind:0s at startup, augmented on every loadNostrUser).
  searchUserLocal(term: string): Promise<NostrUser[]>
  // Remote NIP-50 kind:0 search on the user's search relays (or defaults).
  searchUser(term: string): Promise<NostrUser[]>

  // Event fetching
  loadEvent(code: string, relays?: string[], author?: string): Promise<NostrEvent | null>
  // Batched by-id fetch — one REQ over the id union; non-64-hex ids are dropped.
  loadEvents(ids: string[]): Promise<NostrEvent[]>
  // Verify an event's id + signature on the host (nostr-tools verifyEvent).
  verifyEvent(event: NostrEvent): Promise<boolean>

  // Throwaway-key signing — for ephemeral/anonymous identities, NOT the
  // user's key. NO rpc: both run inside the napp's own frame (nostr-tools
  // signing, lazy-imported from the /nostr-crypto.js companion), so the
  // secret key never reaches the host — it only ever sees finished signed
  // events (e.g. via publish). No permission prompt: the user's identity
  // is never involved. generateKey returns a fresh secp256k1 keypair (hex).
  generateKey(): Promise<{ sk: string; pk: string }>
  signWithKey(event: EventTemplate, sk: string): Promise<NostrEvent>

  // Save bytes to the user's disk. Napp iframes deliberately omit the
  // `allow-downloads` sandbox token, so a napp cannot download on its own and
  // gets no error when it tries — this rpc is the only route out, and being an
  // rpc is what puts it behind the permission prompt. Prefer passing a Blob:
  // it survives structured clone by reference, so the bytes are not copied.
  saveFile(
    name: string,
    data: Blob | ArrayBuffer | ArrayBufferView,
    type?: string
  ): Promise<{ name: string; size: number }>

  // Copy text to the user's clipboard. The napp sandbox has no
  // `clipboard-write` delegation, so navigator.clipboard rejects inside the
  // iframe — this rpc is the only route, and being an rpc puts it behind the
  // permission prompt (which previews the text being copied). Max 100k chars.
  copyText(text: string): Promise<{ length: number }>

  // Publishing
  publish(event: NostrEvent, relays?: string[]): Promise<PublishResult>
}

// ── Sync nostr primitives (bech32 / TLV, no rpc) ─────────────────────────
type Nip19Decoded =
  | { type: "npub" | "note" | "nsec"; data: string }
  | { type: "nprofile"; data: { pubkey: string; relays: string[] } }
  | { type: "nevent"; data: { id: string; relays: string[]; author?: string; kind?: number } }
  | {
      type: "naddr"
      data: { identifier: string; pubkey: string; kind: number; relays: string[] }
    }

type NappNip19 = {
  decode(bech: string): Nip19Decoded
  npubEncode(hex: string): string
  noteEncode(hex: string): string
  neventEncode(pointer: { id: string; relays?: string[]; author?: string; kind?: number }): string
  naddrEncode(pointer: {
    identifier: string
    pubkey: string
    kind: number
    relays?: string[]
  }): string
}

type NappFx = {
  isHex64(s: unknown): boolean
  parseCoordinate(coord: string): { kind: number; pubkey: string; identifier: string } | null
  formatCoordinate(coord: { kind: number; pubkey: string; identifier: string }): string
  satsFromBolt11(invoice: string): number | null
}

// ── Main napp object ─────────────────────────────────────────────────────
type Napp = {
  instance: string
  registerAction(
    pattern: string,
    fn?: ((name: string, payload: unknown) => Promise<unknown>) | null
  ): void
  action(
    name: string,
    payload?: unknown,
    opts?: { instance?: string; auxiliary?: boolean }
  ): Promise<unknown>
  /** Close this window (same as the header × — keeps state for restore). */
  close(): void
  feeds: NappFeeds
  utils: NappUtils
  /** Sync bech32/nip19 helpers. */
  nip19: NappNip19
  /** Sync misc helpers (hex / coordinates / bolt11). */
  fx: NappFx
}

// ── NIP-5D (window.napplet) — the NAP capability seam ────────────────────
// Web projection of github.com/napplet/naps. Availability is PRESENCE: the
// shell injects window.napplet with only the granted domain objects, so a
// napplet feature-detects with `if (window.napplet?.identity)`. Shapes match
// the @napplet/nap contracts (result field names verbatim), so an app built
// with @napplet/shim runs unchanged. This surface is separate from window.napp.

type NappletSubscription = {
  close(): void
}

type NappletTheme_Payload = {
  colors: { background: string; text: string; primary: string }
  title?: string
}

type NappletIdentity = {
  /** The launcher's cached account key, or "" when no signer is connected.
   *  Read-only — never triggers a signer prompt. */
  getPublicKey(): Promise<string>
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
  getProfile(): Promise<Record<string, unknown> | null>
  getFollows(): Promise<string[]>
  getMutes(): Promise<string[]>
  getBlocked(): Promise<string[]>
  /** NIP-51 lists: "bookmarks" | "pins" | "emojis" | "blossom-servers" |
   *  "favorite-relays" | "wiki-authors" | "wiki-relays". */
  getList(listType: string): Promise<string[]>
  getZaps(): Promise<unknown[]>
  getBadges(): Promise<unknown[]>
  onChanged(handler: (pubkey: string) => void): NappletSubscription
}

type NappletTheme = {
  get(): Promise<NappletTheme_Payload>
  onChanged(handler: (theme: NappletTheme_Payload) => void): NappletSubscription
}

type NappletStorageOps = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  keys(): Promise<string[]>
}
interface NappletStorage extends NappletStorageOps {
  /** Per-instance scope (top-level ops are the shared scope). */
  instance: NappletStorageOps
}

type NappletResource = {
  /** Fetch a URL's bytes through the shell — works even when the napplet is
   *  sealed. Schemes: https/http/data/blob and blossom:<sha256>. The Blob's
   *  `.type` carries the MIME. */
  bytes(url: string): Promise<Blob>
  bytesMany(urls: string[]): Promise<unknown[]>
  /** Fetch + wrap in a managed object URL. `img.src = h.url` after `await
   *  h.ready`; `h.revoke()` releases it. */
  bytesAsObjectURL(url: string): { url: string; revoke(): void; ready?: Promise<unknown> }
}

type NappletRelaySubscription = {
  close(): void
}
type NappletRelay = {
  /** Publish an UNSIGNED template; the shell signs (behind a prompt) and
   *  publishes. Resolves with the signed event. */
  publish(event: EventTemplate): Promise<NostrEvent>
  publishEncrypted(
    event: EventTemplate,
    recipient: string,
    encryption?: "nip44" | "nip04"
  ): Promise<NostrEvent>
  query(filters: unknown[]): Promise<{ event: NostrEvent }[]>
  subscribe(
    subId: string,
    filters: unknown[],
    handlers: {
      onEvent?: (event: NostrEvent) => void
      onEose?: () => void
      onClosed?: (reason?: string) => void
    },
    relay?: string
  ): NappletRelaySubscription
}

// ── NIP-5D outbox domain (NIP-65 outbox-model relay routing) ──────────────
type NappletRelayEventResult = {
  event: NostrEvent
}
type NappletOutboxEventResult = {
  result?: NappletRelayEventResult
  incomplete?: boolean
  error?: string
}
type NappletOutboxResult = {
  events: NappletRelayEventResult[]
  incomplete?: boolean
  error?: string
}
type NappletOutboxPublishResult = {
  ok: boolean
  event?: NostrEvent
  eventId?: string
  relays?: Record<string, boolean>
  error?: string
}
type NappletOutboxRelayPlan = {
  relays: string[]
  source: "nip65" | "cache" | "policy" | "fallback"
  missingAuthors?: string[]
}
type NappletOutboxSubscription = {
  on(event: "event", cb: (result: NappletRelayEventResult) => void): void
  on(event: "closed", cb: (reason?: string) => void): void
  close(): void
}
type NappletOutbox = {
  /** Fetch one event by id through shell-owned outbox routing. */
  getEvent(
    eventId: string,
    options?: { author?: string; relays?: string[]; timeoutMs?: number }
  ): Promise<NappletOutboxEventResult>
  /** One-shot outbox-aware query; the shell resolves authors' relays + dedups. */
  query(
    filters: unknown[] | unknown,
    options?: { authors?: string[]; relays?: string[]; limit?: number; timeoutMs?: number }
  ): Promise<NappletOutboxResult>
  /** Live outbox-aware subscription. `sub.on("event", …)` / `sub.close()`. */
  subscribe(
    filters: unknown[] | unknown,
    options?: { authors?: string[]; relays?: string[]; timeoutMs?: number }
  ): NappletOutboxSubscription
  /** Publish an UNSIGNED template; the shell signs (behind a prompt) and fans
   *  out to writer + recipient inboxes. `toOutbox` defaults on. */
  publish(
    event: EventTemplate,
    options?: { relays?: string[]; toOutbox?: boolean; toInboxes?: string[] }
  ): Promise<NappletOutboxPublishResult>
  /** Resolve which relays the shell would use for a read/write target. */
  resolveRelays(target: {
    authors?: string[]
    pubkey?: string
    direction?: "read" | "write"
  }): Promise<NappletOutboxRelayPlan>
}

// ── NAP-COMMON (shell-mediated social actions) ────────────────────────────
// Results carry `ok` — ok:false is an answer (bad input, denied), not a throw.
type NappletCommonActionResult = {
  ok: boolean
  eventId?: string
  event?: NostrEvent
  error?: string
}
type NappletCommon = {
  /** Public nip19 only — never nsec. */
  encodeNip19(input: {
    type: "npub" | "note" | "nprofile" | "nevent" | "naddr"
    [key: string]: unknown
  }): Promise<{ ok: boolean; value?: string; nip19Type?: string; error?: string }>
  decodeNip19(value: string): Promise<{
    ok: boolean
    nip19Type?: string
    hex?: string
    pubkey?: string
    eventId?: string
    identifier?: string
    relays?: string[]
    author?: string
    kind?: number
    error?: string
  }>
  /** Shell profile cache. `result.event` is reconstructed from the cached
   *  kind 0 (content/created_at real, id/sig empty). */
  getProfile(target: string): Promise<{
    ok: boolean
    pubkey: string
    profile?: Record<string, unknown> | null
    result?: { event: NostrEvent }
    error?: string
  }>
  follows(): Promise<{ ok: boolean; pubkeys: string[]; error?: string }>
  /** Writes rewrite kind 3 / publish kinds 7 and 1984 — behind a prompt. */
  follow(...pubkeys: string[]): Promise<NappletCommonActionResult>
  unfollow(...pubkeys: string[]): Promise<NappletCommonActionResult>
  react(
    targetEventId: string,
    reaction: string,
    customEmojiHref?: string
  ): Promise<NappletCommonActionResult>
  report(
    target: { type: "event"; id: string; pubkey?: string } | { type: "pubkey"; pubkey: string },
    reason: string,
    text: string
  ): Promise<NappletCommonActionResult>
}

type NappletInc = {
  /** `content` is a JSON string that becomes the payload; extraTags unused. */
  emit(topic: string, extraTags?: string[][], content?: string): void
  /** callback(payload, syntheticEvent) — the second arg is a kind-0-shaped
   *  envelope carrying the sender's napp id as `pubkey`. */
  on(topic: string, callback: (payload: unknown, event: NostrEvent) => void): NappletSubscription
}

type NappletLink = {
  /** Opens in a new tab behind a prompt. Malformed or non-http(s) URLs reject;
   *  a user denial (or blocked popup) resolves with status "denied". */
  open(url: string, options?: { label?: string }): Promise<{ status: "opened" | "denied" }>
}

type NappletConfig = {
  /** Restricted JSON Schema: no $ref, no regex keywords, depth ≤ 6, secrets
   *  (`x-napplet-secret`) carry no default. Rejections throw "<code>: <detail>". */
  registerSchema(schema: Record<string, unknown>, version?: number): Promise<void>
  get(): Promise<Record<string, unknown>>
  /** First subscriber gets an immediate snapshot; every settings save pushes. */
  subscribe(callback: (values: Record<string, unknown>) => void): NappletSubscription
  /** Ask the launcher to open the settings form (optionally at a section). */
  openSettings(options?: { section?: string }): void
  onSchemaError(callback: (err: { code: string; error: string }) => void): () => void
  /** The registered schema, else the napplet-config-schema meta tag. */
  readonly schema: Record<string, unknown> | null
}

// Every domain is optional: presence = the shell granted it.
type Napplet = {
  identity?: NappletIdentity
  theme?: NappletTheme
  storage?: NappletStorage
  resource?: NappletResource
  relay?: NappletRelay
  outbox?: NappletOutbox
  common?: NappletCommon
  inc?: NappletInc
  link?: NappletLink
  config?: NappletConfig
}

// ── Augment global Window ────────────────────────────────────────────────
interface Window {
  nostr: NostrSigner
  nostrdb: NostrDB
  napp: Napp
  /** NIP-5D surface. Present only when the shell grants ≥1 domain — feature-detect. */
  napplet?: Napplet
  /** Injected by the shell before bridge.js: the granted NIP-5D domains. */
  __nappletDomains?: string[]
}
