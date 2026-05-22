import type { EventTemplate, NostrEvent } from "@nostr/tools/pure"

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<NostrEvent>
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
  signEvent(event: EventTemplate): Promise<NostrEvent>
  nip04: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
  nip44: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
}

export interface NappWindowState {
  nappId: string
  instanceId: string
  petname: string
  left: number
  top: number
  width: number
  height: number | undefined
  minimized: boolean
  maximized: boolean
  pinned: boolean
  userSized: boolean
  zIndex: number
  closed?: boolean
  system?: boolean
  systemId?: string
  panelState?: unknown
}

export interface NappWindow {
  root: HTMLDivElement
  iframe: HTMLIFrameElement | null
  close(): void
  destroy(): void
  getState(): NappWindowState
  focus(): void
  notifyState(): void
  systemId?: string
  getSystemPanelState?(): unknown
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
}

export interface SuggestionItem {
  source: "system" | "action" | "open" | "closed" | "name" | "napp"
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
    opts?: { initial?: unknown; onStateChange?(state: unknown): void }
  ): { unmount(): void } | void
}

export interface AppInfo {
  nappId: string
  name: string
  handlers: string[]
  manifest: {
    pubkey: string
    kind: number
    dTag?: string | null
    eventId: string
    createdAt: number
  } | null
  openCount: number
}

export interface SystemCtx {
  account: {
    getPubkey(): string | null
    getType(): string | null
    subscribe(fn: (pk: string | null) => void): () => void
  }
  apps: {
    list(): AppInfo[]
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
  launchSystemNapp(sysId: string, opts?: { initial?: unknown }): NappWindow
  launchAppInfo(data: AppInfo): NappWindow
  launchFromInput(raw: string): Promise<void>
  isInstalled(nappId: string): boolean
  wasInstalled(nappId: string): boolean
  uninstall(nappId: string): Promise<void>
  installedManifest(nappId: string): unknown
  update(target: { pubkey: string; kind?: number; dTag?: string }): Promise<void>
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
  listing?: NostrEvent | null
}

export interface NsiteTarget {
  pubkey: string
  kind?: number
  dTag?: string
}

export interface NappLaunchOpts {
  instanceId?: string
  petname?: string
  onProgress?: (msg: string) => void
  onStateChange?: (state: NappWindowState) => void
  onReorder?: () => void
  onClose?: (instanceId: string) => void
  onDestroy?: (instanceId: string) => void
  initial?: Partial<NappWindowState>
  dispatchHandlers?: {
    action(callerNappId: string, name: string, payload: unknown): Promise<unknown>
  }
}

export interface SystemLaunchOpts {
  instanceId?: string
  initial?: { data?: unknown; panelState?: unknown } & Partial<NappWindowState>
  onStateChange?: (state: NappWindowState) => void
  onReorder?: () => void
  onClose?: (instanceId: string) => void
}

export interface LaunchOpts {
  instanceId?: string
  petname?: string
  initial?: Partial<NappWindowState>
  onProgress?: (msg: string) => void
  onStateChange?: (state: NappWindowState) => void
  onReorder?: () => void
  onClose?: (instanceId: string) => void
  onDestroy?: (instanceId: string) => void
  dispatchHandlers?: {
    action(callerNappId: string, name: string, payload: unknown): Promise<unknown>
  }
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
