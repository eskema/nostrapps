type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}
type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig">
type NappletSubscription = { close(): void }
type NappletIdentity = {
  getPublicKey(): Promise<string>
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>
  getProfile(): Promise<Record<string, unknown> | null>
  getFollows(): Promise<string[]>
  getMutes(): Promise<string[]>
  getBlocked(): Promise<string[]>
  getList(name: string): Promise<string[]>
  getZaps(): Promise<unknown[]>
  getBadges(): Promise<unknown[]>
  onChanged(handler: (pubkey: string) => void): NappletSubscription
}
type NappletTheme = {
  get(): Promise<{ colors: { background: string; text: string; primary: string }; title?: string }>
  onChanged(handler: (theme: unknown) => void): NappletSubscription
}
type NappletStorageOps = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  keys(): Promise<string[]>
}
type NappletStorage = NappletStorageOps & { instance: NappletStorageOps }
type NappletResource = {
  bytes(url: string): Promise<Blob>
  bytesMany(urls: string[]): Promise<unknown[]>
  bytesAsObjectURL(url: string): { url: string; revoke(): void; ready?: Promise<unknown> }
}
type NappletRelay = {
  publish(event: EventTemplate): Promise<NostrEvent>
  publishEncrypted(
    event: EventTemplate,
    recipient: string,
    encryption?: "nip44" | "nip04"
  ): Promise<NostrEvent>
  query(filters: unknown[] | object): Promise<{ event: NostrEvent }[]>
  subscribe(
    filters: unknown[] | object,
    onEvent: (result: { event: NostrEvent }) => void,
    onEose: () => void,
    options?: { relay?: string; group?: string }
  ): { close(): void }
  subscribe(id: string, filters: unknown[], handlers: object, relay?: string): { close(): void }
}
type NappletOutbox = {
  getEvent(id: string, options?: object): Promise<unknown>
  query(filters: unknown[] | unknown, options?: object): Promise<unknown>
  subscribe(filters: unknown[] | unknown, options?: object): { close(): void }
  publish(event: EventTemplate, options?: object): Promise<unknown>
  resolveRelays(target: object): Promise<unknown>
}
type NappletCommon = {
  encodeNip19(input: object): Promise<unknown>
  decodeNip19(value: string): Promise<unknown>
  getProfile(target: string): Promise<unknown>
  follows(): Promise<unknown>
  follow(...pubkeys: string[]): Promise<unknown>
  unfollow(...pubkeys: string[]): Promise<unknown>
  react(targetEventId: string, reaction: string, emoji?: string): Promise<unknown>
  report(target: object, reason: string, text: string): Promise<unknown>
}
type NappletIntentRequest = {
  archetype: string
  action: string
  convention: string
  payload?: unknown
  handler?: string
  handlerHint?: { address: string; relays?: string[] }
  behavior?: { focus?: boolean; reuse?: boolean }
}
type NappletIntentOptions = Pick<
  NappletIntentRequest,
  "payload" | "handler" | "handlerHint" | "behavior"
>
type NappletIntentDelivery = Pick<
  NappletIntentRequest,
  "archetype" | "action" | "convention" | "payload"
> & { sender: string }
type NappletIntentResult =
  | { ok: true; archetype: string; action: string; convention: string; handler: string }
  | { ok: false; error: string }
type NappletIntentAvailability = {
  archetype: string
  available: boolean
  hasDefault: boolean
  candidates: {
    id: string
    title?: string
    actions: string[]
    conventions: string[]
    contracts: { convention: string; params: string[] }[]
  }[]
}
type NappletIntent = {
  invoke(uri: string, options?: NappletIntentOptions): Promise<NappletIntentResult>
  invoke(request: NappletIntentRequest): Promise<NappletIntentResult>
  open(uri: string, options?: NappletIntentOptions): Promise<NappletIntentResult>
  available(archetype: string): Promise<NappletIntentAvailability>
  handlers(): Promise<NappletIntentAvailability[]>
  onDelivery(handler: (delivery: NappletIntentDelivery) => void): NappletSubscription
  onChanged(handler: (availability: NappletIntentAvailability) => void): NappletSubscription
}
type Napplet = {
  intent?: NappletIntent
  identity?: NappletIdentity
  theme?: NappletTheme
  storage?: NappletStorage
  resource?: NappletResource
  relay?: NappletRelay
  outbox?: NappletOutbox
  common?: NappletCommon
  inc?: {
    emit(topic: string, tags?: string[][], content?: string): void
    on(topic: string, cb: (payload: unknown, event: NostrEvent) => void): NappletSubscription
  }
  link?: { open(url: string, options?: object): Promise<{ status: "opened" | "denied" }> }
  config?: {
    registerSchema(schema: object, version?: number): Promise<void>
    get(): Promise<Record<string, unknown>>
    openSettings(options?: object): void
  }
}

interface Window {
  napplet?: Napplet
  __nappletDomains?: string[]
}
