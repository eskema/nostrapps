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
type NappRelayHealth = {
  url: string
  // online: a monitor checked it in the last 2 hours; offline: checked this
  // week, not since; unknown: no monitor checked it this week
  status: "online" | "offline" | "unknown"
  checkedAt: number | null
  rtt: number | null
  nips: number[] | null
  // [] when the monitors say it requires nothing, null when nobody said
  requires: string[] | null
  // place in the launcher's ranking across the user's follows, 0 first
  rank: number | null
}
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
  relay(
    relays: string[],
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
// The kit, with `requires: ["ui"]`: the launcher's controls as elements wearing
// its classes. Appearance is the class's; layout (width, margins, placement)
// is the parent's.
type NappUiButtonOpts = {
  label?: string
  onClick?: (e: MouseEvent) => void
  variant?: "primary" | "outline" | "danger" | "warning" | "ghost" | "link"
  title?: string
  type?: "button" | "submit"
  disabled?: boolean
  // a glyph before the label; alone, the title names the button for assistive tech
  icon?: string
  class?: string
}
type NappUiCheckOpts = {
  checked?: boolean
  title?: string
  onChange?: (checked: boolean) => void
  class?: string
  // text beside the box, as one <label> with it; the box is its .control
  label?: string
  // a dimmed line under the label
  note?: string
}
type NappUiTabs<T extends string> = HTMLDivElement & {
  select(value: T): void // move the selection without reporting it
  readonly value: T | undefined
}
type NappUiList<T> = HTMLDivElement & {
  add(item: T): HTMLDivElement
  delete(item: T): void
  items: T[] // in order; assign to replace them all
}
type NappUi = {
  button(opts?: NappUiButtonOpts): HTMLButtonElement
  // selectable: primary while active, ghost otherwise; the label truncates
  chip(opts: {
    label: string
    active?: boolean
    icon?: string
    onClick?: (e: MouseEvent) => void
    title?: string
    class?: string
  }): HTMLButtonElement
  // a text tab, underlined while active; toggle .active on it to move the selection
  tab(opts: {
    label: string
    active?: boolean
    onClick?: (e: MouseEvent) => void
    title?: string
    class?: string
  }): HTMLButtonElement
  // a row of tabs that owns the selection and reports the value when it changes
  tabs<T extends string>(opts: {
    items: Array<T | { value: T; label?: string; title?: string; class?: string }>
    active?: T
    onChange?: (value: T) => void
    // blocks sharing the row, the selected one filled: a window's sections
    segmented?: boolean
    class?: string
  }): NappUiTabs<T>
  // an inline svg, 1em, in currentColor; the names are the keys of `icons`
  icon(name: string): SVGElement
  // the glyphs icon() draws, the body of a 16×16 viewBox each; add your own
  icons: Record<string, string>
  // a napp's picture on a plate: s in a line of text, m beside a name (default),
  // l on a card, xl on its detail; .img is the <img>; fade eases it in once loaded
  appIcon(opts?: {
    src?: string
    size?: "s" | "m" | "l" | "xl"
    fade?: boolean
    class?: string
  }): HTMLSpanElement & { img: HTMLImageElement }
  // a short label in small sans capitals, dimmed; a tone colors it
  badge(
    text: string,
    opts?: { tone?: "good" | "danger"; title?: string; class?: string }
  ): HTMLSpanElement
  // the line for when a list or a section has nothing yet; it takes the size of where it sits
  empty(text: string, cls?: string): HTMLDivElement
  // a line to heed: a glyph in the tone's color (warn by default), the text beside it
  notice(
    text: string,
    opts?: { tone?: "warn" | "danger" | "good"; icon?: string; class?: string }
  ): HTMLDivElement
  // something working on it: it breathes, with aria-busy, until busy(el, false)
  busy<T extends HTMLElement>(el: T, on?: boolean): T
  // a ring turning, 1em in the text's color; bigger through its font-size
  spinner(cls?: string): HTMLSpanElement
  // a <details>: its <summary>, then the children (or append them later); the
  // summary is text, or parts in a line (a title, then a count or a badge);
  // fold is the small one under content, a rule above and a dimmed summary
  details(
    opts: {
      summary: string | Node | Array<string | Node>
      open?: boolean
      fold?: boolean
      class?: string
    },
    ...children: Array<Node | string>
  ): HTMLDetailsElement
  // code in a line, a <code>: mono at 0.85em of the text around it
  code(text: string, cls?: string): HTMLElement
  // code or data in lines on a tinted plate, a <pre>; long lines wrap
  codeBlock(text: string, cls?: string): HTMLPreElement
  input(opts?: {
    type?: string
    placeholder?: string
    value?: string
    autocomplete?: string
    spellcheck?: boolean
    class?: string
  }): HTMLInputElement
  // a form line: overline caption, the control filling the width, a note under it
  field(opts: {
    label: string
    control: HTMLElement
    note?: string
    class?: string
  }): HTMLLabelElement
  check(opts: NappUiCheckOpts & { label: string }): HTMLLabelElement
  check(opts?: NappUiCheckOpts): HTMLInputElement
  radio(opts: NappUiCheckOpts & { name: string; label: string }): HTMLLabelElement
  radio(opts: NappUiCheckOpts & { name: string }): HTMLInputElement
  // one of N, labelled, as a group; .value reads and sets the pick
  radios<T extends string>(opts: {
    name: string
    options: Array<T | { value: T; label?: string; title?: string; note?: string }>
    value?: T
    onChange?: (value: T) => void
    class?: string
  }): HTMLDivElement & { value: T | undefined }
  // a small tracked uppercase caption
  overline(text: string, cls?: string): HTMLSpanElement
  // a word set round a circle, turning; sized by the font-size it sits in
  ring(word: string, cls?: string): SVGElement
  // a column of rows: a truncating mono label, then the controls given
  itemList(cls?: string): HTMLDivElement
  item(
    opts: { label: string; title?: string; class?: string },
    ...controls: HTMLElement[]
  ): HTMLDivElement
  // rows that open one at a time; append rows to the list, a row's content to the row
  rowList(cls?: string): HTMLDivElement
  row(list: HTMLElement, ...summary: Array<string | Node>): HTMLDetailsElement
  // a button that becomes an input + add; onAdd returns the error to show, or nothing
  addControl(opts: {
    label: string
    placeholder?: string
    class?: string
    onAdd: (value: string) => string | void
  }): HTMLDivElement
  // rows + add control + operations; the row's label and controls are yours, the structure the kit's
  list<T>(opts?: {
    items?: T[]
    label?: (item: T) => string
    title?: (item: T) => string
    controls?: (item: T, row: HTMLDivElement) => HTMLElement[]
    add?: { label: string; placeholder?: string; onAdd: (value: string) => string | void }
    empty?: string
    class?: string
  }): NappUiList<T>
  // plain elements for the glue between the parts
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    ...children: Array<Node | string>
  ): HTMLElementTagNameMap[K]
  // a column with a gap; a row of controls that wraps
  stack(...children: Array<Node | string>): HTMLDivElement
  bar(...children: Array<Node | string>): HTMLDivElement
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
  relays: { health(urls: string[]): Promise<NappRelayHealth[]> }
  feeds: NappFeeds
  utils: NappUtils
  ui: NappUi
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
