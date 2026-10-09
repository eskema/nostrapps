declare module "*?raw" {
  const src: string
  export default src
}

type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

type Filter = {
  ids?: string[]
  kinds?: number[]
  authors?: string[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [tag: `#${string}`]: string[] | undefined
}

type EventTemplate = Omit<NostrEvent, "id" | "pubkey" | "sig">
type Nip04 = {
  encrypt(pubkey: string, plaintext: string): Promise<string>
  decrypt(pubkey: string, ciphertext: string): Promise<string>
}
type Nip44 = Nip04
type NostrSigner = {
  getPublicKey(): Promise<string>
  signEvent(event: EventTemplate): Promise<NostrEvent>
  nip04: Nip04
  nip44: Nip44
}
type NostrDB = {
  add(event: NostrEvent): Promise<void>
  query(filters: unknown): Promise<NostrEvent[]>
  count(filters: unknown): Promise<number>
  event(id: string): Promise<NostrEvent | undefined>
  remove(ids: string[]): Promise<string[]>
  replaceable(kind: number, author: string, identifier?: string): Promise<NostrEvent | undefined>
  // Every event saved to the store from now on that matches filters, one by
  // one. What is already stored comes from query(). Leaving the loop ends it.
  subscribe(filters: Filter | Filter[]): AsyncGenerator<NostrEvent>
  supports(): string[]
}
type ListResult<T> = { event: NostrEvent | null; items: T[] }
// What window.napp.nip19.decode hands back for a nevent / naddr — accepted
// directly by utils.loadEvent in place of the encoded code.
type EventPointer = { id: string; relays?: string[]; author?: string; kind?: number }
type AddressPointer = {
  identifier: string
  pubkey: string
  kind: number
  relays?: string[]
}
type RelayItem = { url: string; read: boolean; write: boolean }
type RelayHealth = {
  url: string
  // online: a monitor checked it in the last 2 hours; offline: checked this
  // week, not since; unknown: no monitor checked it this week
  status: "online" | "offline" | "unknown"
  checkedAt: number | null
  rtt: number | null
  nips: number[] | null
  // [] when the monitors say it requires nothing, null when nobody said
  requires: string[] | null
}
type SyncResult = {
  // false when some author/kind could not be fetched; error says which
  success: boolean
  // events saved to the store that it did not have before
  newEvents: number
  error?: string
}
type SubscribeOpts = {
  /** Sent to the relays as the subscription id prefix. Defaults to "<author prefix>-<napp d tag>". */
  label?: string
  /** Milliseconds to wait for every relay's EOSE before giving up on the slow ones. Defaults to 20000. */
  maxEoseTimeout?: number
  /** Called once, with everything that arrived before EOSE (or the timeout), deduplicated. */
  eoseEventsCallback?: (events: NostrEvent[]) => void
  /** Called once for each new event that arrives after that. */
  liveEventCallback?: (event: NostrEvent) => void
  /** Called once when every relay has ended the subscription, with each relay's reason. Not called when the napp closes it. */
  closedCallback?: (reasons: { [relay: string]: string }) => void
}
type Utils = {
  loadRelayList(pubkey: string): Promise<ListResult<RelayItem>>
  loadFollowsList(pubkey: string): Promise<ListResult<string>>
  loadMuteList(pubkey: string): Promise<ListResult<string>>
  loadBookmarks(pubkey: string): Promise<ListResult<string>>
  loadPins(pubkey: string): Promise<ListResult<string>>
  loadBlossomServers(pubkey: string): Promise<ListResult<string>>
  loadEmojis(pubkey: string): Promise<ListResult<string>>
  loadFavoriteRelays(pubkey: string): Promise<ListResult<string>>
  loadBlockedRelays(pubkey: string): Promise<ListResult<string>>
  loadSearchRelays(pubkey: string): Promise<ListResult<string>>
  loadDmRelays(pubkey: string): Promise<ListResult<string>>
  loadWikiAuthors(pubkey: string): Promise<ListResult<string>>
  loadWikiRelays(pubkey: string): Promise<ListResult<string>>
  loadFavoriteFollowSets(pubkey: string): Promise<ListResult<unknown>>
  loadFavoriteScrolls(pubkey: string): Promise<ListResult<unknown>>
  loadProfileBadges(pubkey: string): Promise<ListResult<unknown>>
  loadSimpleGroups(pubkey: string): Promise<ListResult<unknown>>
  loadGitAuthors(pubkey: string): Promise<ListResult<string>>
  loadGitRepositories(pubkey: string): Promise<ListResult<string>>
  loadMediaFollows(pubkey: string): Promise<ListResult<string>>
  loadFavoritePodcasts(pubkey: string): Promise<ListResult<string>>
  loadAuthoredPodcasts(pubkey: string): Promise<ListResult<string>>
  fetchFavoriteRelaysWithSets(pubkey: string): Promise<unknown[]>
  fetchEmojisWithSets(pubkey: string): Promise<unknown[]>
  fetchFavoriteFollowSetsWithSets(pubkey: string): Promise<unknown[]>
  loadFollowSets(pubkey: string): Promise<unknown>
  loadRelaySets(pubkey: string): Promise<unknown>
  loadEmojiSets(pubkey: string): Promise<unknown>
  loadRelayInfo(url: string): Promise<unknown>
  // A plain REQ to exactly these relays (no outbox logic). Returns the closer.
  subscribe(relays: string[], filter: object, opts?: SubscribeOpts): () => void
  loadNostrUser(request: string | { pubkey: string; relays?: string[] }): Promise<unknown>
  searchUserLocal(term: string): Promise<unknown[]>
  searchUser(term: string): Promise<unknown[]>
  loadEvent(
    code: string | EventPointer | AddressPointer,
    relays?: string[],
    author?: string
  ): Promise<NostrEvent | null>
  loadEvents(ids: string[]): Promise<NostrEvent[]>
  verifyEvent(event: NostrEvent): Promise<boolean>
  generateKey(): Promise<{ sk: string; pk: string }>
  signWithKey(event: EventTemplate, sk: string): Promise<NostrEvent>
  saveFile(
    name: string,
    data: Blob | ArrayBuffer | ArrayBufferView,
    type?: string
  ): Promise<{ name: string; size: number }>
  copyText(text: string): Promise<{ length: number }>
  publish(
    event: NostrEvent,
    relays?: string[]
  ): Promise<{ published: number; failed: number; relays: Record<string, unknown> }>
}
// The kit, with `requires: ["ui"]`: the launcher's controls as elements wearing
// its classes. Appearance is the class's; layout (width, margins, placement)
// is the parent's.
type UiButtonOpts = {
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
type UiCheckOpts = {
  checked?: boolean
  title?: string
  onChange?: (checked: boolean) => void
  class?: string
  // text beside the box, as one <label> with it; the box is its .control
  label?: string
  // a dimmed line under the label
  note?: string
}
type UiTabs<T extends string> = HTMLDivElement & {
  select(value: T): void // move the selection without reporting it
  readonly value: T | undefined
}
type UiList<T> = HTMLDivElement & {
  add(item: T): HTMLDivElement
  delete(item: T): void
  items: T[] // in order; assign to replace them all
}
type Ui = {
  button(opts?: UiButtonOpts): HTMLButtonElement
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
  }): UiTabs<T>
  // an inline svg, 1em, in currentColor; the names are the keys of `icons`.
  // flush puts its ink at that edge instead of its box, for an icon that ends a
  // line under text; iconInk says how far each glyph sits in, add yours there
  icon(name: string, opts?: { flush?: "start" | "end" }): SVGElement
  iconInk: Record<string, [number, number]>
  // the glyphs icon() draws, the body of a 16×16 viewBox each; add your own
  icons: Record<string, string>
  // a napp's picture on a plate: xs an author's in a line of text, s in a row,
  // m beside a name (default), l on a card, xl on its detail; .img is the <img>; fade eases it in once loaded
  appIcon(opts?: {
    src?: string
    size?: "xs" | "s" | "m" | "l" | "xl"
    fade?: boolean
    class?: string
  }): HTMLSpanElement & { img: HTMLImageElement }
  // a person, the same wherever one is named: the name (the profile's name,
  // else the viewer's petname for them, else the display name, else the short
  // npub), a picture before it when asked for (true: xs, in a line of text; or
  // an appIcon size), and after it the petname and a check for someone
  // followed. It fills itself in when the profile lands. A link to the profile
  // action unless link is false or onClick says otherwise
  author(
    pubkey: string,
    opts?: {
      picture?: boolean | "xs" | "s" | "m" | "l" | "xl"
      petname?: boolean
      follows?: boolean
      prefix?: string
      link?: boolean
      onClick?: (pubkey: string, e: MouseEvent) => void
      class?: string
    }
  ): HTMLElement
  authors: {
    // how the kit loads a profile, encodes an npub, opens a profile; set for napps already.
    // load: null for a napp that looks profiles up itself and hands them over with set()
    use(config: {
      load?: ((pubkey: string) => Promise<unknown>) | null
      npub?: (pubkey: string) => string
      open?: (pubkey: string) => void
    }): void
    // a profile in hand (what loadNostrUser gives, or a kind 0's content): repaints its authors
    set(pubkey: string, user: unknown): void
    // the viewer's follow list, a kind 3 (null: logged out): its petnames and who is followed
    viewer(follows: { tags?: unknown } | null): void
    // the name as text, as known right now
    name(pubkey: string): string
    follows(pubkey: string): boolean
  }
  // a short label in small sans capitals, dimmed; a tone colors it
  badge(
    text: string,
    opts?: { tone?: "good" | "danger" | "warn"; title?: string; class?: string }
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
  // fold is the small one under content, a rule above and a dimmed summary;
  // sticky keeps the summary at the top while the content scrolls under it.
  // (For anything else that should stay in view, the ui-sticky class.)
  details(
    opts: {
      summary: string | Node | Array<string | Node>
      open?: boolean
      fold?: boolean
      sticky?: boolean | { top: number | string }
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
  check(opts: UiCheckOpts & { label: string }): HTMLLabelElement
  check(opts?: UiCheckOpts): HTMLInputElement
  radio(opts: UiCheckOpts & { name: string; label: string }): HTMLLabelElement
  radio(opts: UiCheckOpts & { name: string }): HTMLInputElement
  // one of N, labelled, as a group; .value reads and sets the pick. label is a
  // caption before them; collapse keeps it one overline line, caption and pick,
  // until clicked, and folds it back once one is chosen
  radios<T extends string>(opts: {
    name: string
    options: Array<T | { value: T; label?: string; title?: string; note?: string }>
    value?: T
    onChange?: (value: T) => void
    label?: string
    collapse?: boolean
    class?: string
  }): HTMLDivElement & { value: T | undefined }
  // a small tracked uppercase caption
  overline(text: string, cls?: string): HTMLSpanElement
  // a word set round a circle, turning; sized by the font-size it sits in
  ring(word: string, cls?: string): SVGElement
  // a column of rows: the row's text cut with an ellipsis, then the controls
  // given; the text's voice is what's in it (code(url) for an id or a url); a
  // row that failed takes tone "danger"
  itemList(cls?: string): HTMLDivElement
  item(
    opts: { label: string | HTMLElement; title?: string; tone?: "danger"; class?: string },
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
    label?: (item: T) => string | HTMLElement
    title?: (item: T) => string
    controls?: (item: T, row: HTMLDivElement) => HTMLElement[]
    add?: { label: string; placeholder?: string; onAdd: (value: string) => string | void }
    empty?: string
    class?: string
  }): UiList<T>
  // keep an element in view as the rest scrolls: at the top (the default, at 0), the bottom,
  // or both, each at an offset (a number is px). Only that: its background is yours
  sticky<T extends HTMLElement>(el: T, opts?: { top?: number | string; bottom?: number | string }): T
  // plain elements for the glue between the parts
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    ...children: Array<Node | string>
  ): HTMLElementTagNameMap[K]
  // the launcher's faces in place of the system's; call it from the head, before the first
  // paint. Absent where the kit came without them (from Blossom by hash)
  fonts?(): Promise<void>
  // a column with a gap; a row of controls that wraps
  stack(...children: Array<Node | string>): HTMLDivElement
  bar(...children: Array<Node | string>): HTMLDivElement
  // text-like content spaced as it reads: blocks a line apart, a heading close over
  // what it heads; the flow spaces its children, they carry no margins
  flow(...children: Array<Node | string>): HTMLDivElement
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
  relays: { health(urls: string[]): Promise<RelayHealth[]> }
  // Fetches into the store, from each author's write relays, their events of
  // these kinds between since and until, skipping what an earlier sync already
  // brought (unless force). Read them back with nostrdb.query.
  sync(
    authors: string[],
    kinds: number[],
    since: number,
    until: number,
    opts?: { force?: boolean }
  ): Promise<SyncResult>
  utils: Utils
  ui: Ui
  // Set by the kit's loader line (the nostrapps ui kit napp shows it): resolves
  // once the kit is in; await it before the first helper. Absent without the line.
  ready?: Promise<void>
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
  nostr: NostrSigner
  nostrdb: NostrDB
  napp: Napp
}
