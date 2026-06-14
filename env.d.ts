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
  // NIP-51 lists
  loadRelayList(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: RelayItem[]
  ): Promise<ListResult<RelayItem>>
  loadFollowsList(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadMuteList(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadBookmarks(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadPins(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadBlossomServers(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadEmojis(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadFavoriteRelays(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadFavoriteScrolls(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadWikiAuthors(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>
  loadWikiRelays(
    pubkey: string,
    hints?: string[],
    refreshStyle?: boolean | NostrEvent | null,
    defaultItems?: string[]
  ): Promise<ListResult<string>>

  // Addressable sets
  loadFollowSets(
    pubkey: string,
    hints?: string[],
    forceUpdate?: boolean
  ): Promise<SetResult<string>>
  loadFollowPacks(
    pubkey: string,
    hints?: string[],
    forceUpdate?: boolean
  ): Promise<SetResult<string>>
  loadRelaySets(pubkey: string, hints?: string[], forceUpdate?: boolean): Promise<SetResult<string>>
  loadEmojiSets(pubkey: string, hints?: string[], forceUpdate?: boolean): Promise<SetResult<string>>

  // Relay info
  loadRelayInfo(
    url: string,
    refreshStyle?: boolean | NostrEvent | null
  ): Promise<RelayInfoDocument | null>

  // Profile metadata
  loadNostrUser(request: NostrUserRequest | string): Promise<NostrUser>

  // Event fetching
  loadEvent(code: string, relays?: string[], author?: string): Promise<NostrEvent | null>

  // Publishing
  publish(event: NostrEvent, relays?: string[]): Promise<PublishResult>
}

// ── Main napp object ─────────────────────────────────────────────────────
interface Napp {
  instance: string
  registerAction(pattern: string, fn: (name: string, payload: unknown) => Promise<unknown>): void
  action(name: string, payload?: unknown, opts?: { instance?: string }): Promise<unknown>
  feeds: NappFeeds
  utils: NappUtils
}

// ── Augment global Window ────────────────────────────────────────────────
interface Window {
  nostr: NostrSigner
  nostrdb: NostrDB
  napp: Napp
}
