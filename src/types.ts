import { VerifiedEvent } from "@nostr/tools"
import type { EventTemplate, NostrEvent } from "@nostr/tools/pure"

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<VerifiedEvent>
      nip04: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
      nip44: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
    }
  }
}

export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(event: EventTemplate): Promise<VerifiedEvent>
  nip04: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
  nip44: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
}

export type NappWindowState = {
  nappId: string
  instanceId: string
  petname: string
  system?: boolean
  systemId?: string
  status: Status
  position?: Position
  params?: any
  loadedActions?: Array<{ name: string; payload: unknown }>
}

export type Status = {
  minimized: boolean
  maximized: boolean
  pinned: boolean
  userSized: boolean
  zIndex: number
}

export type Position = {
  left: number
  top: number
  width: number
  height?: number
}

export type NappWindow = {
  root: HTMLDivElement
  iframe: HTMLIFrameElement | null
  close(): void
  destroy(): void
  getState(): NappWindowState
  focus(): void
  notifyState(): void
  systemId?: string
}

export interface MessageData {
  __nostrapps?: string
  id?: string
  method?: string
  params?: Record<string, unknown>
  instanceId?: string
  requestId?: string
  result?: unknown
  error?: string
  name?: string
  payload?: unknown
  pattern?: string
  handlerId?: string
}

export interface SuggestionItem {
  source: "system" | "action" | "open" | "name" | "napp"
  nappId?: string
  instanceId?: string
  petname?: string | null
  raw?: string
  slash?: string
  systemId?: string
  actionId?: string
}

export interface SystemNappDef {
  id: string
  title: string
  slash?: string
  singleton?: boolean
  mount(
    container: HTMLElement,
    ctx: SystemCtx,
    opts?: { params?: any; onStateChange?(state: NappWindowState): void }
  ): { unmount(): void } | void
}

export interface SystemCtx {
  account: {
    getPubkey(): string | null
    getType(): string | null
    subscribe(fn: (pk: string | null) => void): () => void
  }
  apps: {
    list(): Array<{
      event: NostrEvent | null
      nappId: string
      name: string
      handlers: string[]
      openCount: number
    }>
    events(): NostrEvent[]
    subscribe(fn: () => void): () => void
  }
  database: {
    query(filter: Record<string, unknown>): Promise<NostrEvent[]>
  }
  theme: {
    get(): string
    set(choice: string): void
    subscribe(fn: (choice: string) => void): () => void
  }
  logs: {
    history(): Array<{ at: number; msg: string }>
    subscribe(fn: () => void): () => void
  }
  connect(): Promise<void>
  connectBunker(uri: string): Promise<void>
  connectGoogle(): Promise<void>
  disconnect(): Promise<void>
  factoryReset(): Promise<void>
  loadFolder(): void
  setStatus(msg: string): void
  launchSystemNapp(sysId: string, opts?: { params?: any }): NappWindow
  isInstalled(nappId: string): boolean
  wasInstalled(nappId: string): boolean
  install(nappId: string): Promise<string>
  uninstall(nappId: string): Promise<void>
  update(target: { pubkey: string; dTag: string; relayHints?: string[] }): Promise<void>
}

export interface NsiteFile {
  path: string
  body: Blob
  mime: string
}

export interface NsiteResult {
  nappId: string
  files: NsiteFile[]
  title: string | null
  manifest?: NostrEvent | null
  singleton?: boolean
}

export type SystemLaunchOpts = {
  instanceId?: string
  initial?: Partial<NappWindowState>
  params?: any
  position?: Position
  status?: Status
  singleton?: true
  onStateChange?: (state: NappWindowState) => void
  onReorder?: () => void
  onClose?: (instanceId: string) => void
}

export type LaunchOpts = {
  instanceId?: string
  petname?: string
  params?: any
  position?: Position
  status?: Status
  onProgress?: (msg: string) => void
  onStateChange?: (state: NappWindowState) => void
  onReorder?: () => void
  onClose?: (instanceId: string) => void
  onDestroy?: (instanceId: string) => void
}

export interface PackCell {
  col: number
  row: number
  cols: number
  rows: number
}

export interface CellRect extends PackCell {
  left: number
  top: number
  width: number
  height: number
}

export interface StageBounds {
  width: number
  height: number
  padL: number
  padR: number
  padT: number
  padB: number
}

export interface GridRect {
  col: number
  row: number
  cols: number
  rows: number
}

export interface LogEntry {
  at: number
  msg: string
}

export type SignerGetter = () => Signer
