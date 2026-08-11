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
  // Optional: absent on older cached bridges, so feature-detect before calling.
  loadEvents?(ids: string[]): Promise<NostrEvent[]>
  // Verify an event's id + signature on the host (nostr-tools verifyEvent).
  // Optional: absent on older cached bridges.
  verifyEvent?(event: NostrEvent): Promise<boolean>

  // Save bytes to the user's disk. Napp iframes deliberately omit the
  // `allow-downloads` sandbox token, so a napp cannot download on its own and
  // gets no error when it tries — this rpc is the only route out, and being an
  // rpc is what puts it behind the permission prompt. Prefer passing a Blob:
  // it survives structured clone by reference, so the bytes are not copied.
  // Optional: absent on older cached bridges, so feature-detect before calling.
  saveFile?(
    name: string,
    data: Blob | ArrayBuffer | ArrayBufferView,
    type?: string
  ): Promise<{ name: string; size: number }>

  // Copy text to the user's clipboard. The napp sandbox has no
  // `clipboard-write` delegation, so navigator.clipboard rejects inside the
  // iframe — this rpc is the only route, and being an rpc puts it behind the
  // permission prompt (which previews the text being copied). Max 100k chars.
  // Optional: absent on older cached bridges, so feature-detect before calling.
  copyText?(text: string): Promise<{ length: number }>

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
  /** Sync bech32/nip19 helpers. Optional: absent on older cached bridges. */
  nip19?: NappNip19
  /** Sync misc helpers (hex / coordinates / bolt11). Optional on older bridges. */
  fx?: NappFx
}

// ── NIP-5D (window.napplet) — the NAP capability seam ────────────────────
// Web projection of github.com/napplet/naps. Phase-1 domains: shell
// (mandatory), identity, theme. Feature-detect with
// `window.napplet?.shell.supports("identity")` — supports() is synchronous,
// answered locally from the cached shell.init environment.

interface NappletShellEnvironment {
  capabilities: { domains: string[] }
  services: string[]
}

interface NappletSubscription {
  close(): void
}

interface NappletShell {
  /** Synchronous, local; false before shell.init and for unknown domains. */
  supports(domain: string): boolean
  services(): string[]
  ready(): Promise<NappletShellEnvironment>
  onReady(handler: (env: NappletShellEnvironment) => void): NappletSubscription
}

interface NappletIdentity {
  /** The launcher's cached account key, or "" when no signer is connected.
   *  Read-only — never triggers a signer prompt. */
  getPublicKey(): Promise<string>
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
  getProfile(): Promise<Record<string, unknown> | null>
  getFollows(): Promise<string[]>
  getMutes(): Promise<string[]>
  /** NIP-51 lists: "bookmarks" | "pins" | "emojis" | "blossom-servers" |
   *  "favorite-relays" | "wiki-authors" | "wiki-relays". */
  getList(type: string): Promise<unknown[]>
  onChanged(handler: (pubkey: string) => void): NappletSubscription
}

interface NappletTheme {
  get(): Promise<{
    title: string
    colors: { background: string; text: string; primary: string }
  }>
  onChanged(handler: (theme: unknown) => void): NappletSubscription
}

interface Napplet {
  shell: NappletShell
  identity: NappletIdentity
  theme: NappletTheme
}

// ── Augment global Window ────────────────────────────────────────────────
interface Window {
  nostr: NostrSigner
  nostrdb: NostrDB
  napp: Napp
  /** NIP-5D surface. Optional: absent on older cached bridges — feature-detect. */
  napplet?: Napplet
}
