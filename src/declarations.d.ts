declare module "@fontsource-variable/source-sans-3"
declare module "@fontsource-variable/source-serif-4"
declare module "@fontsource-variable/source-code-pro"
declare module "nostr-web-components"
declare module "@nostr/gadgets/redstore" {
  export class RedEventStore {
    constructor(workerPath: string | null)
    saveEvent(event: unknown): Promise<void>
    queryEvents(filter: unknown): Promise<unknown[]>
    loadReplaceables(params: unknown): Promise<unknown>
    close(): Promise<void>
    worker?: { terminate(): void }
  }
}
declare module "@nostr/gadgets/global" {
  import type { SubscribeManyParams } from "@nostr/tools/pool"
  export const pool: {
    subscribeMap(
      reqs: Array<{ url: string; filter: unknown }>,
      params: {
        label?: string
        onevent(event: unknown): void
        oneose(): void
        onerror?(err: Error): void
      }
    ): { close(): void }
    subscribeMany(
      relays: string[],
      filters: unknown,
      params: SubscribeManyParams
    ): { close(): void }
    publish(relays: string[], event: unknown): Array<Promise<void>>
  }
}
declare module "@nostr/gadgets/outbox" {
  export function outboxFilterRelayBatch(
    pubkeys: string[],
    filter: unknown
  ): Promise<Array<{ url: string; filter: unknown }> | null>
}
declare module "@nostr/gadgets/lists" {
  export function loadBlossomServers(pubkey: string): Promise<{ items?: string[] }>
}
declare module "@noble/hashes/sha256" {
  export function sha256(data: Uint8Array): Uint8Array
}
declare module "@noble/hashes/utils" {
  export function bytesToHex(bytes: Uint8Array): string
}

interface HTMLElement {
  disabled: boolean
}

// Make querySelector default to HTMLElement in system napps
interface ParentNode {
  querySelector<K extends keyof HTMLElementTagNameMap>(
    selectors: K
  ): HTMLElementTagNameMap[K] | null
  querySelector<E extends HTMLElement = HTMLElement>(selectors: string): E | null
}
