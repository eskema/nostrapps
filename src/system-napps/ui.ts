// Shared UI primitives — the small design system for this app, and for napps:
// one that declares `requires: ["ui"]` gets this module as /napp-ui.js
// (window.napp.ui) and the CSS as /napp-ui.css, both built by vite.config.ts.
//
// CONVENTION: build interactive controls through these helpers, never by
// hand-rolling `document.createElement("button")` + bespoke CSS:
//   • button({ variant, label, onClick, … })  → a `.btn .btn-<variant>`
//   • chip({ label, active, icon, onClick, … }) → a `.btn .btn-chip` (selectable)
//   • tab({ label, active, onClick, … })        → a `.ui-tab` text tab
//   • icon(name)                                → an inline `<svg>` (currentColor)
//   • details({ summary, open, … })             → a `.ui-details` disclosure
//   • input({ type, placeholder, … })           → a `.ui-input` text field
//   • check({ checked, onChange, … })           → a `.ui-check` checkbox
//   • overline(text)                            → a `.ui-overline` caption/badge
//   • ring(word)                                → a `.ui-ring` word set round a circle, turning
//   • class `ui-title` on any text              → the window title's voice
//   • itemList() + item({ label }, …controls)   → `.ui-items` / `.ui-item` rows
//   • rowList() + row(list, …summary)           → `.ui-rows` / `.ui-row` rows that open
//   • addControl({ label, onAdd, … })           → the two-step "add an item" form
// And a layer over them that owns the state and the structure, so a screen is
// a few calls:
//   • button({ icon, … })                       → a glyph before the label, or alone
//   • tabs({ items, active, onChange })         → `.ui-tabs`, a row owning its selection
//   • check({ label, note, … })                 → the box and its text as one <label>
//   • radios({ name, options, value, onChange }) → `.ui-radios`, one of N, labelled
//   • field({ label, control, note })           → `.ui-field`, the form line
//   • list({ items, label, controls, add })     → `.ui-list`: rows, add control, add/delete/items
//   • el(tag, class, …children), stack(…), bar(…) → plain glue, a column, a row
// Variants: primary | outline | danger | warning | ghost. Layout (align-self,
// margins, placement) belongs on the parent/context, not the variant. CSS lives
// in src/ui.css, the one file the launcher and the napps share.
//
// list() is the one list component, and all it knows is structure: the column,
// the add control under it, the operations. What a row means — which controls
// it carries, what they do — stays the context's, given as `controls`. For any
// other shape, compose itemList/item/check/addControl directly.

export type ButtonVariant = "primary" | "outline" | "danger" | "warning" | "ghost" | "link"

export interface ButtonOpts {
  label?: string
  onClick?: (e: MouseEvent) => void
  variant?: ButtonVariant
  title?: string
  type?: "button" | "submit"
  disabled?: boolean
  /** A glyph before the label. Alone, the title names the button for assistive tech. */
  icon?: string
  /** Extra classes for layout/context (e.g. "apps-relay-delete"). */
  class?: string
}

// ─── icons ────────────────────────────────────────────────────────
// Inline SVG glyphs (stroke = currentColor, 1em) so they sit consistently next
// to text and follow the theme — no more mismatched unicode characters. The
// body of a 16×16 viewBox per name; exported so a napp can add its own.
export const icons: Record<string, string> = {
  tile: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  pack: '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>',
  grid: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M8 2v12M2 8h12"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  save: '<path d="M8 2.5v6M5.5 6L8 8.5 10.5 6"/><path d="M3 11v1.5h10V11"/>',
  reset: '<path d="M13 13.5V9.5a4 4 0 0 0-4-4H4"/><path d="M7 2.5 4 5.5 7 8.5"/>',
  reload: '<path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5"/><path d="M3 3v2.7h2.7"/>',
  back: '<path d="M13 8H3.5M7 4 3.5 8 7 12"/>',
  forward: '<path d="M3 8h9.5M9 4 12.5 8 9 12"/>',
  move: '<path d="M2 8h8"/><path d="M7 5l3 3-3 3"/><path d="M13 4v8"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  link: '<path d="M6.5 9.5l3-3"/><path d="M7.3 4.7l1.2-1.2a2.4 2.4 0 0 1 3.4 3.4l-1.2 1.2"/><path d="M8.7 11.3l-1.2 1.2a2.4 2.4 0 0 1-3.4-3.4l1.2-1.2"/>'
}

export function icon(name: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "1em")
  svg.setAttribute("height", "1em")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.4")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.classList.add("ui-icon")
  svg.innerHTML = icons[name] || ""
  return svg
}

// Create a styled <button>. Variant drives appearance; layout stays on the
// parent (pass `class` for context-specific positioning if needed).
export function button(opts: ButtonOpts = {}): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = opts.type || "button"
  b.className = `btn btn-${opts.variant || "outline"}${opts.class ? ` ${opts.class}` : ""}`
  if (opts.label != null) b.textContent = opts.label
  if (opts.icon) {
    b.prepend(icon(opts.icon))
    if (opts.label == null && opts.title) b.setAttribute("aria-label", opts.title)
  }
  if (opts.title) b.title = opts.title
  if (opts.disabled) b.disabled = true
  if (opts.onClick) b.addEventListener("click", opts.onClick)
  return b
}

export interface ChipOpts {
  label: string
  onClick?: (e: MouseEvent) => void
  active?: boolean
  icon?: string
  title?: string
  class?: string
}

// A selectable chip (window/space switcher etc.). Built on the button system:
// active → primary, otherwise ghost; the label truncates with an ellipsis.
export function chip(o: ChipOpts): HTMLButtonElement {
  const b = button({
    variant: o.active ? "primary" : "ghost",
    title: o.title,
    onClick: o.onClick,
    class: `btn-chip${o.class ? ` ${o.class}` : ""}`
  })
  if (o.icon) b.appendChild(icon(o.icon))
  const label = document.createElement("span")
  label.className = "btn-chip-label"
  label.textContent = o.label
  b.appendChild(label)
  return b
}

export interface TabOpts {
  label: string
  onClick?: (e: MouseEvent) => void
  active?: boolean
  title?: string
  /** Extra classes for context (e.g. "spaces-tab" for the drag handler). */
  class?: string
}

// A text tab: dimmed label, underline when active (spaces bar, apps type
// filter). Its own primitive rather than a button variant — the flat,
// borderless look fights the .btn backgrounds, which is why these used to be
// hand-rolled. Toggle `.active` on the returned element to change selection.
export function tab(o: TabOpts): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = `ui-tab${o.active ? " active" : ""}${o.class ? ` ${o.class}` : ""}`
  b.textContent = o.label
  if (o.title) b.title = o.title
  if (o.onClick) b.addEventListener("click", o.onClick)
  return b
}

export interface TabItem<T extends string = string> {
  value: T
  /** Shown text; the value if not given. */
  label?: string
  title?: string
  class?: string
}

export interface TabsOpts<T extends string = string> {
  items: Array<T | TabItem<T>>
  active?: T
  onChange?: (value: T) => void
  class?: string
}

export type Tabs<T extends string = string> = HTMLDivElement & {
  /** Move the selection without reporting it (restoring state, say). */
  select(value: T): void
  readonly value: T | undefined
}

// A row of tabs that owns the selection: a click moves it and reports the
// value, once, when it changes. Built from tab(); the row is `.ui-tabs`.
export function tabs<T extends string = string>(opts: TabsOpts<T>): Tabs<T> {
  const row = document.createElement("div") as Tabs<T>
  row.className = `ui-tabs${opts.class ? ` ${opts.class}` : ""}`
  row.setAttribute("role", "tablist")
  const buttons = new Map<T, HTMLButtonElement>()
  let current = opts.active
  const select = (value: T) => {
    current = value
    for (const [v, b] of buttons) {
      b.classList.toggle("active", v === value)
      b.setAttribute("aria-selected", String(v === value))
    }
  }
  for (const it of opts.items) {
    const t: TabItem<T> = typeof it === "string" ? { value: it } : it
    const b = tab({
      label: t.label ?? t.value,
      title: t.title,
      class: t.class,
      active: t.value === current,
      onClick: () => {
        if (t.value === current) return
        select(t.value)
        opts.onChange?.(t.value)
      }
    })
    b.setAttribute("role", "tab")
    b.setAttribute("aria-selected", String(t.value === current))
    b.dataset.value = t.value
    buttons.set(t.value, b)
    row.append(b)
  }
  row.select = select
  Object.defineProperty(row, "value", { get: () => current })
  return row
}

export interface DetailsOpts {
  /** Summary label — the always-visible disclosure header. */
  summary: string
  /** Start expanded (default collapsed). */
  open?: boolean
  /** Extra classes for context. */
  class?: string
}

// A collapsible disclosure (<details>/<summary>) styled like the apps-store
// file/info sections. Returns the <details> with its <summary> already in place
// — append your content to it. For a live count, update the summary later:
// `d.querySelector("summary")!.textContent = …`.
export function details(opts: DetailsOpts): HTMLDetailsElement {
  const d = document.createElement("details")
  d.className = `ui-details${opts.class ? ` ${opts.class}` : ""}`
  if (opts.open) d.open = true
  const s = document.createElement("summary")
  s.textContent = opts.summary
  d.appendChild(s)
  return d
}

export interface InputOpts {
  type?: string
  placeholder?: string
  value?: string
  autocomplete?: string
  spellcheck?: boolean
  /** Extra classes for layout/context. */
  class?: string
}

// A styled text input (`.ui-input`). Appearance comes from the class; layout
// (flex/width) belongs on the parent/context.
export function input(opts: InputOpts = {}): HTMLInputElement {
  const el = document.createElement("input")
  el.type = opts.type || "text"
  el.className = `ui-input${opts.class ? ` ${opts.class}` : ""}`
  if (opts.placeholder != null) el.placeholder = opts.placeholder
  if (opts.value != null) el.value = opts.value
  if (opts.autocomplete) el.setAttribute("autocomplete", opts.autocomplete)
  if (opts.spellcheck === false) el.spellcheck = false
  return el
}

export interface FieldOpts {
  label: string
  control: HTMLElement
  /** A dimmed line under the control. */
  note?: string
  class?: string
}

// A form line (`.ui-field`): an overline caption, the control under it filling
// the width, a note under that. A <label>, so the caption focuses the control.
export function field(opts: FieldOpts): HTMLLabelElement {
  const l = document.createElement("label")
  l.className = `ui-field${opts.class ? ` ${opts.class}` : ""}`
  l.append(overline(opts.label), opts.control)
  if (opts.note) {
    const n = document.createElement("span")
    n.className = "ui-field-note"
    n.textContent = opts.note
    l.append(n)
  }
  return l
}

export interface CheckOpts {
  checked?: boolean
  title?: string
  onChange?: (checked: boolean) => void
  /** Extra classes: on the box, or on the <label> when there is one. */
  class?: string
  /** Text beside the box, as one <label> with it: the words toggle it too. The box is its `.control`. */
  label?: string
  /** A dimmed line under the label. */
  note?: string
}

function box(opts: CheckOpts, type: "checkbox" | "radio"): HTMLInputElement {
  const c = document.createElement("input")
  c.type = type
  c.className = `ui-check${type === "radio" ? " ui-radio" : ""}${opts.class && !opts.label ? ` ${opts.class}` : ""}`
  if (opts.checked) c.checked = true
  if (opts.title) c.title = opts.title
  if (opts.onChange) c.addEventListener("change", () => opts.onChange!(c.checked))
  return c
}

// The box and its text as one <label> (`.ui-check-label`).
function labeled(input: HTMLInputElement, opts: CheckOpts): HTMLLabelElement {
  const l = document.createElement("label")
  l.className = `ui-check-label${opts.class ? ` ${opts.class}` : ""}`
  const text = document.createElement("span")
  text.className = "ui-check-text"
  text.textContent = opts.label!
  if (opts.note) {
    const n = document.createElement("span")
    n.className = "ui-check-note"
    n.textContent = opts.note
    text.append(n)
  }
  l.append(input, text)
  return l
}

// A themeable checkbox (`.ui-check`): checked takes a --surface fill with a
// --text border and check, so it flips with the theme (same as the napps').
// With a label, the box comes with its text as one <label>.
export function check(opts: CheckOpts & { label: string }): HTMLLabelElement
export function check(opts?: CheckOpts): HTMLInputElement
export function check(opts: CheckOpts = {}): HTMLElement {
  const c = box(opts, "checkbox")
  return opts.label ? labeled(c, opts) : c
}

// Same visual as check(), round — for one-of-N picks. radios() builds the group.
export function radio(opts: CheckOpts & { name: string; label: string }): HTMLLabelElement
export function radio(opts: CheckOpts & { name: string }): HTMLInputElement
export function radio(opts: CheckOpts & { name: string }): HTMLElement {
  const r = box(opts, "radio")
  r.name = opts.name
  return opts.label ? labeled(r, opts) : r
}

export interface RadioItem<T extends string = string> {
  value: T
  /** Shown text; the value if not given. */
  label?: string
  title?: string
  note?: string
}

export interface RadiosOpts<T extends string = string> {
  name: string
  options: Array<T | RadioItem<T>>
  value?: T
  onChange?: (value: T) => void
  class?: string
}

export type Radios<T extends string = string> = HTMLDivElement & { value: T | undefined }

// One of N, labelled, as a group (`.ui-radios`): `.value` reads and sets the
// pick, onChange reports it. A row that wraps; a class of the context's can
// stack it.
export function radios<T extends string = string>(opts: RadiosOpts<T>): Radios<T> {
  const group = document.createElement("div") as Radios<T>
  group.className = `ui-radios${opts.class ? ` ${opts.class}` : ""}`
  group.setAttribute("role", "radiogroup")
  const inputs = new Map<T, HTMLInputElement>()
  for (const o of opts.options) {
    const it: RadioItem<T> = typeof o === "string" ? { value: o } : o
    const l = radio({
      name: opts.name,
      label: it.label ?? it.value,
      note: it.note,
      title: it.title,
      checked: it.value === opts.value,
      onChange: () => opts.onChange?.(it.value)
    })
    inputs.set(it.value, l.control as HTMLInputElement)
    group.append(l)
  }
  Object.defineProperty(group, "value", {
    get: () => [...inputs].find(([, i]) => i.checked)?.[0],
    set: (v: T) => {
      for (const [k, i] of inputs) i.checked = k === v
    }
  })
  return group
}

// Small uppercase letter-spaced caption (`.ui-overline`) — control captions,
// metadata badges, counts.
export function overline(text: string, cls?: string): HTMLSpanElement {
  const s = document.createElement("span")
  s.className = `ui-overline${cls ? ` ${cls}` : ""}`
  s.textContent = text
  return s
}

// A word set around a circle (`.ui-ring`), slowly turning — the overline's
// voice bent into a stamp. Geometry is in em of the ring's text (the font-size
// on .ui-ring, the overline's by default) and the svg sizes itself to fit, like
// icon(). The word goes round once, its letters spread to fill the
// circumference (textLength on the textPath — where Blink reads it), and a dot
// sits centred in the seam: its own run, since a fitted run gets no gap after
// its last glyph. Orange by default, glyphs only; placement is the context's.
let ringSeq = 0
export function ring(word: string, cls?: string): SVGElement {
  const NS = "http://www.w3.org/2000/svg"
  // Drawn at 100 units per em: Blink measures a path by flattening it to a
  // fixed tolerance in user units, so a circle a few units wide comes out
  // short and glyphs placed past its "end" are dropped.
  const em = 100
  const r = 1.6 * em // the baseline circle's radius
  const box = 2 * (r + 0.8 * em) // the glyphs stand outside the path: room for them
  const c = box / 2
  const circ = 2 * Math.PI * r
  const n = word.length
  const glyph = 0.6 * em // ≈ an uppercase glyph's advance, tracking included
  const dot = 0.3 * em
  // n − 1 gaps inside the word and one either side of the dot, all equal.
  const gap = (circ - n * glyph - dot) / (n + 1)
  const span = n * glyph + (n - 1) * gap // the word's run along the path
  const svg = document.createElementNS(NS, "svg")
  svg.setAttribute("viewBox", `0 0 ${box} ${box}`)
  svg.setAttribute("width", `${box / em}em`)
  svg.setAttribute("height", `${box / em}em`)
  svg.setAttribute("aria-hidden", "true")
  svg.classList.add("ui-ring")
  if (cls) svg.classList.add(...cls.split(" "))
  const id = `ui-ring-${++ringSeq}`
  const defs = document.createElementNS(NS, "defs")
  const path = document.createElementNS(NS, "path")
  path.id = id
  // A full circle from the top, clockwise, so the text reads the right way up
  // along the outside.
  path.setAttribute("d", `M${c} ${c - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}`)
  defs.appendChild(path)
  const run = (content: string, attrs: Record<string, string>) => {
    const text = document.createElementNS(NS, "text")
    text.setAttribute("font-size", String(em))
    const tp = document.createElementNS(NS, "textPath")
    tp.setAttribute("href", `#${id}`)
    for (const [k, v] of Object.entries(attrs)) tp.setAttribute(k, v)
    tp.textContent = content
    text.appendChild(tp)
    return text
  }
  const wordRun = run(word, { textLength: span.toFixed(1), lengthAdjust: "spacing" })
  const dotRun = run("·", { startOffset: ((span + circ) / 2).toFixed(1) })
  dotRun.setAttribute("text-anchor", "middle")
  svg.append(defs, wordRun, dotRun)
  return svg
}

// ─── item lists ───────────────────────────────────────────────────
// The editable-list shape (relays napp look): itemList() is the column, item()
// one hairline-separated row — a mono label that truncates plus whatever
// controls the context needs on the right — and addControl() the deliberate
// two-step add affordance. Compose per context; there is no monolithic list
// component on purpose.

export function itemList(cls?: string): HTMLDivElement {
  const el = document.createElement("div")
  el.className = `ui-items${cls ? ` ${cls}` : ""}`
  return el
}

export interface ItemOpts {
  /** Row label, rendered as truncating mono text. */
  label: string
  /** Tooltip; defaults to the label. */
  title?: string
  class?: string
}

export function item(opts: ItemOpts, ...controls: HTMLElement[]): HTMLDivElement {
  const row = document.createElement("div")
  row.className = `ui-item${opts.class ? ` ${opts.class}` : ""}`
  const label = document.createElement("code")
  label.className = "ui-item-label"
  label.textContent = opts.label
  label.title = opts.title || opts.label
  row.appendChild(label)
  for (const c of controls) row.appendChild(c)
  return row
}

// Rows that open: rowList() holds them, row() is a line that opens to whatever
// is appended to it. They read like item rows, with a +/– at the end. A list's
// rows share a details name, so one opens at a time, and while one is open
// the list shows only it (CSS, .ui-rows). A row goes on the end of its list
// itself; other lines you append.
let rowListSerial = 0

export function rowList(cls?: string): HTMLDivElement {
  const el = document.createElement("div")
  el.className = `ui-rows${cls ? ` ${cls}` : ""}`
  el.dataset.rows = `ui-rows-${rowListSerial++}`
  // The rest of the list unfolds when the open row closes, and only then: its
  // @starting-style would otherwise run whenever the list shows up again (a
  // space switched back to, a parent disclosure opened). A mutation callback
  // runs before the next frame, so the class is there when the rows come back.
  let settle = 0
  new MutationObserver(changes => {
    for (const c of changes) {
      const row = c.target as HTMLDetailsElement
      if (row.parentElement !== el || row.open || c.oldValue === null) continue
      if (el.querySelector(":scope > .ui-row[open]")) continue
      el.classList.add("ui-rows-unfolding")
      clearTimeout(settle)
      settle = window.setTimeout(() => el.classList.remove("ui-rows-unfolding"), 300)
    }
  }).observe(el, {
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
    attributeOldValue: true
  })
  return el
}

export function row(list: HTMLElement, ...summary: Array<string | Node>): HTMLDetailsElement {
  const el = document.createElement("details")
  el.className = "ui-row"
  el.setAttribute("name", list.dataset.rows || "")
  const line = document.createElement("summary")
  line.append(...summary)
  el.appendChild(line)
  list.append(el)
  return el
}

export interface AddControlOpts {
  /** Collapsed button label, e.g. "add a relay". */
  label: string
  placeholder?: string
  class?: string
  /** Return an error message to show it inline; return nothing on success —
   *  the input clears and stays open so several entries can be added in a row. */
  onAdd: (value: string) => string | void
}

// Collapsed: a single outline button. Clicked: an input + add button in its
// place (and focused), so adding is one deliberate step.
export function addControl(opts: AddControlOpts): HTMLDivElement {
  const wrap = document.createElement("div")
  wrap.className = `ui-add${opts.class ? ` ${opts.class}` : ""}`
  const error = document.createElement("div")
  error.className = "ui-add-error"
  const open = () => {
    const form = document.createElement("form")
    form.className = "ui-add-form"
    const inp = input({ placeholder: opts.placeholder, class: "ui-add-input", spellcheck: false })
    inp.setAttribute("autocomplete", "off")
    inp.addEventListener("input", () => (error.textContent = ""))
    form.append(inp, button({ label: "add", variant: "outline", type: "submit" }))
    form.addEventListener("submit", e => {
      e.preventDefault()
      const err = opts.onAdd(inp.value)
      error.textContent = typeof err === "string" ? err : ""
      if (typeof err !== "string") inp.value = ""
      inp.focus()
    })
    wrap.replaceChildren(form, error)
    inp.focus()
  }
  wrap.appendChild(button({ label: opts.label, variant: "outline", onClick: open }))
  return wrap
}

export interface ListOpts<T> {
  items?: T[]
  /** The row's label; String(item) if not given. */
  label?: (item: T) => string
  /** The label's tooltip; the label if not given. */
  title?: (item: T) => string
  /** The controls after the label: the context's pick. `row` is the element, for a class or a data attribute. */
  controls?: (item: T, row: HTMLDivElement) => HTMLElement[]
  /** The two-step add control under the rows. onAdd refuses with an error; otherwise it takes the value in with add(). */
  add?: AddControlOpts
  /** A dimmed line while there are no rows. */
  empty?: string
  class?: string
}

export type List<T> = HTMLDivElement & {
  add(item: T): HTMLDivElement
  delete(item: T): void
  /** The items, in order; assign to replace them all. */
  items: T[]
}

// A list of things (`.ui-list`): the rows column, the add control under it,
// and the operations, with each row built by item() from the label and the
// controls the context gives. Items are keyed by identity.
export function list<T>(opts: ListOpts<T> = {}): List<T> {
  const root = document.createElement("div") as List<T>
  root.className = `ui-list${opts.class ? ` ${opts.class}` : ""}`
  const rows = itemList()
  const entries = new Map<T, HTMLDivElement>()
  const empty = document.createElement("div")
  empty.className = "ui-list-empty"
  empty.textContent = opts.empty ?? ""
  const settle = () => (empty.hidden = !opts.empty || entries.size > 0)
  const add = (entry: T) => {
    const label = opts.label ? opts.label(entry) : String(entry)
    const r = item({ label, title: opts.title ? opts.title(entry) : undefined })
    if (opts.controls) r.append(...opts.controls(entry, r))
    entries.get(entry)?.remove()
    entries.set(entry, r)
    rows.append(r)
    settle()
    return r
  }
  root.add = add
  root.delete = (entry: T) => {
    entries.get(entry)?.remove()
    entries.delete(entry)
    settle()
  }
  Object.defineProperty(root, "items", {
    get: () => [...entries.keys()],
    set: (items: T[]) => {
      for (const r of entries.values()) r.remove()
      entries.clear()
      for (const entry of items) add(entry)
      settle()
    }
  })
  root.append(rows, empty)
  if (opts.add) root.append(addControl(opts.add))
  root.items = opts.items ?? []
  return root
}

// ─── glue ─────────────────────────────────────────────────────────
// Plain elements for what sits between the parts: el("p", "", "text"),
// el("div", "my-class", child, child).
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  e.append(...children)
  return e
}

// The two layouts every screen needs: stack() a column with a gap (grid),
// bar() a row of controls (flex, wrapping). Layout is the parent's; these are
// the parent.
export function stack(...children: Array<Node | string>): HTMLDivElement {
  return el("div", "ui-stack", ...children)
}

export function bar(...children: Array<Node | string>): HTMLDivElement {
  return el("div", "ui-bar", ...children)
}
