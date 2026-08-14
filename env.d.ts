// Vite raw-text imports (e.g. the napplet bridge inlined into a srcdoc).
declare module "*?raw" {
  const src: string
  export default src
}

// ── Nostr core types (same as from @nostr/tools) ──────────────────────────
interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

interface EventTemplate {
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
interface NostrNip04 {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}

interface NostrNip44 {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}

interface NostrSigner {
  getPublicKey(): Promise<string>
  signEvent(evt: EventTemplate): Promise<VerifiedEvent>
  nip04: NostrNip04
  nip44: NostrNip44
}

// ── Event store (NIP-DB) ─────────────────────────────────────────────────
interface NostrDB {
  add(event: NostrEvent): Promise<void>
  query(filters: unknown): Promise<NostrEvent[]>
  count(filters: unknown): Promise<number>
  event(id: string): Promise<NostrEvent | undefined>
  replaceable(kind: number, author: string, identifier?: string): Promise<NostrEvent | undefined>
  supports(): string[]
}

// ── NIP-51 list helpers ──────────────────────────────────────────────────
interface RelayItem {
  url: string
  read: boolean
  write: boolean
}

interface ListResult<I> {
  event: NostrEvent | null
  items: I[]
}

// ── Addressable set helpers ──────────────────────────────────────────────
interface SetResult<I> {
  event: NostrEvent | null
  items: I[]
}

// ── Profile metadata ─────────────────────────────────────────────────────
interface ProfileMetadata {
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

interface NostrUser {
  pubkey: string
  npub: string
  shortName: string
  image?: string
  metadata: ProfileMetadata
  lastUpdated: number
}

interface NostrUserRequest {
  pubkey: string
  relays?: string[]
  refreshStyle?: boolean | NostrEvent | null
}

// ── Relay info (NIP-11) ─────────────────────────────────────────────────
interface RelayInfoDocument {
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
interface PublishResult {
  relays: { [url: string]: { ok: boolean; error?: string } }
  published: number
  failed: number
}

// ── Feed subscription ────────────────────────────────────────────────────
interface FeedHandle {
  close(): void
}

type FeedCallback = (events: NostrEvent[], synced: boolean) => void

interface FeedOpts {
  since?: number
  until?: number
  limit?: number
}

interface NappFeeds {
  profile(pubkey: string, kinds: number[], callback: FeedCallback, opts?: FeedOpts): FeedHandle
  following(source: string, kinds: number[], callback: FeedCallback, opts?: FeedOpts): FeedHandle
  inbox(pubkey: string, kinds: number[], callback: FeedCallback, opts?: FeedOpts): FeedHandle
}

// ── Data-loading utils ───────────────────────────────────────────────────
interface NappUtils {
  // NIP-51 lists — accepts hex pubkey, npub, or nprofile
  loadRelayList(pubkey: string): Promise<ListResult<RelayItem>>
  loadFollowsList(pubkey: string): Promise<ListResult<string>>
  loadMuteList(pubkey: string): Promise<ListResult<string>>
  loadBookmarks(pubkey: string): Promise<ListResult<string>>
  loadPins(pubkey: string): Promise<ListResult<string>>
  loadBlossomServers(pubkey: string): Promise<ListResult<string>>
  loadEmojis(pubkey: string): Promise<ListResult<string>>
  loadFavoriteRelays(pubkey: string): Promise<ListResult<string>>
  loadWikiAuthors(pubkey: string): Promise<ListResult<string>>
  loadWikiRelays(pubkey: string): Promise<ListResult<string>>

  // Addressable sets
  loadFollowSets(pubkey: string): Promise<SetResult<string>>
  loadRelaySets(pubkey: string): Promise<SetResult<string>>
  loadEmojiSets(pubkey: string): Promise<SetResult<string>>

  // Relay info
  loadRelayInfo(url: string): Promise<RelayInfoDocument | null>

  // Profile metadata
  loadNostrUser(request: NostrUserRequest | string): Promise<NostrUser>

  // Event fetching
  loadEvent(code: string, relays?: string[], author?: string): Promise<NostrEvent | null>
  // Batched by-id fetch — one REQ over the id union; non-64-hex ids are dropped.
  loadEvents(ids: string[]): Promise<NostrEvent[]>
  // Verify an event's id + signature on the host (nostr-tools verifyEvent).
  verifyEvent(event: NostrEvent): Promise<boolean>

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

interface NappNip19 {
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

interface NappFx {
  isHex64(s: unknown): boolean
  parseCoordinate(coord: string): { kind: number; pubkey: string; identifier: string } | null
  formatCoordinate(coord: { kind: number; pubkey: string; identifier: string }): string
  satsFromBolt11(invoice: string): number | null
}

// ── Main napp object ─────────────────────────────────────────────────────
interface Napp {
  instance: string
  registerAction(
    pattern: string,
    fn?: ((name: string, payload: unknown) => Promise<unknown>) | null
  ): void
  action(name: string, payload?: unknown, opts?: { instance?: string }): Promise<unknown>
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

interface NappletSubscription {
  close(): void
}

interface NappletTheme_Payload {
  colors: { background: string; text: string; primary: string }
  title?: string
}

interface NappletIdentity {
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

interface NappletTheme {
  get(): Promise<NappletTheme_Payload>
  onChanged(handler: (theme: NappletTheme_Payload) => void): NappletSubscription
}

interface NappletStorageOps {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  keys(): Promise<string[]>
}
interface NappletStorage extends NappletStorageOps {
  /** Per-instance scope (top-level ops are the shared scope). */
  instance: NappletStorageOps
}

interface NappletResource {
  /** Fetch a URL's bytes through the shell — works even when the napplet is
   *  sealed. Schemes: https/http/data/blob and blossom:<sha256>. The Blob's
   *  `.type` carries the MIME. */
  bytes(url: string): Promise<Blob>
  bytesMany(urls: string[]): Promise<unknown[]>
  /** Fetch + wrap in a managed object URL. `img.src = h.url` after `await
   *  h.ready`; `h.revoke()` releases it. */
  bytesAsObjectURL(url: string): { url: string; revoke(): void; ready?: Promise<unknown> }
}

interface NappletRelaySubscription {
  close(): void
}
interface NappletRelay {
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
interface NappletRelayEventResult {
  event: NostrEvent
}
interface NappletOutboxEventResult {
  result?: NappletRelayEventResult
  incomplete?: boolean
  error?: string
}
interface NappletOutboxResult {
  events: NappletRelayEventResult[]
  incomplete?: boolean
  error?: string
}
interface NappletOutboxPublishResult {
  ok: boolean
  event?: NostrEvent
  eventId?: string
  relays?: Record<string, boolean>
  error?: string
}
interface NappletOutboxRelayPlan {
  relays: string[]
  source: "nip65" | "cache" | "policy" | "fallback"
  missingAuthors?: string[]
}
interface NappletOutboxSubscription {
  on(event: "event", cb: (result: NappletRelayEventResult) => void): void
  on(event: "closed", cb: (reason?: string) => void): void
  close(): void
}
interface NappletOutbox {
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
interface NappletCommonActionResult {
  ok: boolean
  eventId?: string
  event?: NostrEvent
  error?: string
}
interface NappletCommon {
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

interface NappletInc {
  /** `content` is a JSON string that becomes the payload; extraTags unused. */
  emit(topic: string, extraTags?: string[][], content?: string): void
  /** callback(payload, syntheticEvent) — the second arg is a kind-0-shaped
   *  envelope carrying the sender's napp id as `pubkey`. */
  on(topic: string, callback: (payload: unknown, event: NostrEvent) => void): NappletSubscription
}

interface NappletLink {
  /** Opens in a new tab behind a prompt. Malformed or non-http(s) URLs reject;
   *  a user denial (or blocked popup) resolves with status "denied". */
  open(url: string, options?: { label?: string }): Promise<{ status: "opened" | "denied" }>
}

interface NappletConfig {
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
interface Napplet {
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
