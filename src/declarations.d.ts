declare module "@fontsource-variable/source-sans-3"
declare module "@fontsource-variable/source-serif-4"
declare module "@fontsource-variable/source-code-pro"
declare module "nostr-web-components"

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
