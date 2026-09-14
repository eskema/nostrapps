declare module "@fontsource-variable/source-sans-3"
declare module "@fontsource-variable/source-serif-4"
declare module "@fontsource-variable/source-code-pro"
declare module "nostr-web-components"

interface HTMLElement {
  disabled: boolean
}

// Esc / back-gesture close requests (dialog.ts). Chrome 120, Firefox 132; not
// in lib.dom yet.
interface CloseWatcher extends EventTarget {
  requestClose(): void
  close(): void
  destroy(): void
  oncancel: ((this: CloseWatcher, ev: Event) => any) | null
  onclose: ((this: CloseWatcher, ev: Event) => any) | null
}
declare var CloseWatcher: {
  prototype: CloseWatcher
  new (options?: { signal?: AbortSignal }): CloseWatcher
}

// Make querySelector default to HTMLElement in system napps
interface ParentNode {
  querySelector<K extends keyof HTMLElementTagNameMap>(
    selectors: K
  ): HTMLElementTagNameMap[K] | null
  querySelector<E extends HTMLElement = HTMLElement>(selectors: string): E | null
}
