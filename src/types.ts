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
    showDirectoryPicker?(): Promise<FileSystemDirectoryHandle>
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

// A saved window configuration (a "space" / workspace).
// `open` is the live working set (what you see / get restored when you switch
// in); `saved` is the committed snapshot you can reset back to. Switching
// preserves `open`; Save commits open→saved; Reset reverts open←saved.
export interface SpaceData {
  id: string
  name: string
  open: NappWindowState[]
  saved: NappWindowState[]
  packMode: boolean
  savedPackMode: boolean
}

export interface SpacesState {
  current: string
  list: SpaceData[]
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
  body: HTMLDivElement
  titleEl: HTMLSpanElement
  close(): void
  destroy(): void
  getState(): NappWindowState
  focus(): void
  notifyState(): void
  setIframe(src: string, sandbox?: string): void
  systemId?: string
}

export type MessageData =
  | {
      __nostrapps: "napp-action-registered"
      instanceId: string
      idx: number
      pattern: string
    }
  | {
      __nostrapps: "napp-dispatch-action"
      requestId: string
      idx: number
      name: string
      payload: unknown
    }
  | {
      __nostrapps: "napp-dispatch-result"
      requestId: string
      result?: unknown
      error?: string
    }
  | {
      __nostrapps: "rpc"
      id: string
      method: string
      params: any
      instanceId?: string
    }
  | {
      __nostrapps: "rpc-result"
      id: string
      result: unknown
    }
  | {
      __nostrapps: "napp-ready"
      instanceId: string
    }
  | {
      __nostrapps: "napp-theme-change"
      theme: string
      // Resolved color tokens from the launcher's active theme, forwarded so
      // napps can match the launcher's surface/text without hardcoding values.
      vars?: Record<string, string>
    }
  | {
      __nostrapps: "napp-feed-callback"
      callbackId: string
      events: unknown[]
    }

export type InstalledApp = {
  nappId: string
  icon: string
  title: string
  petname: string
  singleton: boolean
  actions: string[]
  event?: NostrEvent
  // Unix seconds when a local/dev/temp app was added (apps with no manifest
  // event, so no publish date). Surfaced as the card's date for those.
  installedAt?: number
}

export interface SuggestionItem {
  source: "system" | "action" | "open" | "napp"
  nappId?: string
  instanceId?: string
  petname?: string | null
  raw?: string
  slash?: string
  systemId?: string
  actionId?: string
  // For "open" items: which space the window lives in (the input is a global
  // view across all spaces). spaceCurrent marks windows in the active space.
  spaceId?: string
  spaceName?: string
  spaceCurrent?: boolean
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
    get(nappId: string): InstalledApp | undefined
    list(): Array<InstalledApp>
    events(): NostrEvent[]
    subscribe(fn: () => void): () => void
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
  launchSystemNapp(sysId: string, opts?: { params?: any; persistent?: boolean }): NappWindow
  launchNapp(nappId: string, petname?: string): Promise<void>
  isInstalled(nappId: string): boolean
  wasInstalled(nappId: string): boolean
  install(nappId: string): Promise<string>
  uninstall(nappId: string): Promise<void>
  update(target: { pubkey: string; dTag: string; relayHints?: string[] }): Promise<void>
  installDevApp(): Promise<void>
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
