declare module "*?raw" {
  const src: string
  export default src
}

type NappNostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

type NappEventTemplate = Omit<NappNostrEvent, "id" | "pubkey" | "sig">
type NappNip04 = {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}
type NappNip44 = NappNip04
type NappNostrSigner = {
  getPublicKey(): Promise<string>
  signEvent(event: NappEventTemplate): Promise<NappNostrEvent>
  nip04: NappNip04
  nip44: NappNip44
}
type NappNostrDB = {
  add(event: NappNostrEvent): Promise<void>
  query(filters: unknown): Promise<NappNostrEvent[]>
  count(filters: unknown): Promise<number>
  event(id: string): Promise<NappNostrEvent | undefined>
  remove(ids: string[]): Promise<string[]>
  replaceable(kind: number, author: string, identifier?: string): Promise<NostrEvent | undefined>
  supports(): string[]
}
type NappListResult<T> = { event: NappNostrEvent | null; items: T[] }
type NappRelayItem = { url: string; read: boolean; write: boolean }
type NappFeedHandle = { close(): void }
type NappFeeds = {
  profile(
    pubkey: string,
    kinds: number[],
    cb: (events: NappNostrEvent[], synced: boolean) => void,
    opts?: object
  ): NappFeedHandle
  following(
    source: string,
    kinds: number[],
    cb: (events: NappNostrEvent[], synced: boolean) => void,
    opts?: object
  ): NappFeedHandle
  inbox(
    pubkey: string | string[],
    kinds: number[],
    cb: (events: NappNostrEvent[], synced: boolean) => void,
    opts?: object
  ): NappFeedHandle
  outbox(
    pubkeys: string | string[],
    kinds: number[],
    cb: (events: NappNostrEvent[], synced: boolean) => void,
    opts?: object
  ): NappFeedHandle
}
type NappUtils = {
  loadRelayList(pubkey: string): Promise<NappListResult<NappRelayItem>>
  loadFollowsList(pubkey: string): Promise<NappListResult<string>>
  loadMuteList(pubkey: string): Promise<NappListResult<string>>
  loadBookmarks(pubkey: string): Promise<NappListResult<string>>
  loadPins(pubkey: string): Promise<NappListResult<string>>
  loadBlossomServers(pubkey: string): Promise<NappListResult<string>>
  loadEmojis(pubkey: string): Promise<NappListResult<string>>
  loadFavoriteRelays(pubkey: string): Promise<NappListResult<string>>
  loadBlockedRelays(pubkey: string): Promise<NappListResult<string>>
  loadSearchRelays(pubkey: string): Promise<NappListResult<string>>
  loadDmRelays(pubkey: string): Promise<NappListResult<string>>
  loadWikiAuthors(pubkey: string): Promise<NappListResult<string>>
  loadWikiRelays(pubkey: string): Promise<NappListResult<string>>
  loadFavoriteFollowSets(pubkey: string): Promise<NappListResult<unknown>>
  loadFavoriteScrolls(pubkey: string): Promise<NappListResult<unknown>>
  loadProfileBadges(pubkey: string): Promise<NappListResult<unknown>>
  loadSimpleGroups(pubkey: string): Promise<NappListResult<unknown>>
  loadGitAuthors(pubkey: string): Promise<NappListResult<string>>
  loadGitRepositories(pubkey: string): Promise<NappListResult<string>>
  loadMediaFollows(pubkey: string): Promise<NappListResult<string>>
  loadFavoritePodcasts(pubkey: string): Promise<NappListResult<string>>
  loadAuthoredPodcasts(pubkey: string): Promise<NappListResult<string>>
  fetchFavoriteRelaysWithSets(pubkey: string): Promise<unknown[]>
  fetchEmojisWithSets(pubkey: string): Promise<unknown[]>
  fetchFavoriteFollowSetsWithSets(pubkey: string): Promise<unknown[]>
  loadFollowSets(pubkey: string): Promise<unknown>
  loadRelaySets(pubkey: string): Promise<unknown>
  loadEmojiSets(pubkey: string): Promise<unknown>
  loadRelayInfo(url: string): Promise<unknown>
  loadNostrUser(request: string | { pubkey: string; relays?: string[] }): Promise<unknown>
  searchUserLocal(term: string): Promise<unknown[]>
  searchUser(term: string): Promise<unknown[]>
  loadEvent(code: string, relays?: string[], author?: string): Promise<NappNostrEvent | null>
  loadEvents(ids: string[]): Promise<NappNostrEvent[]>
  verifyEvent(event: NappNostrEvent): Promise<boolean>
  generateKey(): Promise<{ sk: string; pk: string }>
  signWithKey(event: NappEventTemplate, sk: string): Promise<NappNostrEvent>
  saveFile(
    name: string,
    data: Blob | ArrayBuffer | ArrayBufferView,
    type?: string
  ): Promise<{ name: string; size: number }>
  copyText(text: string): Promise<{ length: number }>
  publish(
    event: NappNostrEvent,
    relays?: string[]
  ): Promise<{ published: number; failed: number; relays: Record<string, unknown> }>
}
type Napp = {
  instance: string
  registerAction(
    pattern: string,
    handler?: (name: string, payload: unknown) => Promise<unknown>
  ): void
  action(
    name: string,
    payload?: unknown,
    opts?: { instance?: string; auxiliary?: boolean }
  ): Promise<unknown>
  close(): void
  link(url: string): void
  log(message: string): void
  feeds: NappFeeds
  utils: NappUtils
  nip19: {
    decode(value: string): unknown
    npubEncode(hex: string): string
    noteEncode(hex: string): string
    neventEncode(pointer: object): string
    naddrEncode(pointer: object): string
  }
  fx: {
    isHex64(value: unknown): boolean
    parseCoordinate(value: string): unknown
    formatCoordinate(value: object): string
    satsFromBolt11(invoice: string): number | null
  }
}

interface Window {
  nostr: NappNostrSigner
  nostrdb: NappNostrDB
  napp: Napp
}
