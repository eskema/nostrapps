// Shared UI primitives — the small design system for this app.
//
// CONVENTION: build interactive controls through these helpers, never by
// hand-rolling `document.createElement("button")` + bespoke CSS:
//   • button({ variant, label, onClick, … })  → a `.btn .btn-<variant>`
//   • chip({ label, active, icon, onClick, … }) → a `.btn .btn-chip` (selectable)
//   • icon(name)                                → an inline `<svg>` (currentColor)
//   • details({ summary, open, … })             → a `.ui-details` disclosure
//   • input({ type, placeholder, … })           → a `.ui-input` text field
// Variants: primary | outline | danger | warning | ghost. Layout (align-self,
// margins, placement) belongs on the parent/context, not the variant. CSS lives
// in launcher.css under "Design system".

export type ButtonVariant = "primary" | "outline" | "danger" | "warning" | "ghost" | "link"

export interface ButtonOpts {
  label?: string
  onClick?: (e: MouseEvent) => void
  variant?: ButtonVariant
  title?: string
  type?: "button" | "submit"
  disabled?: boolean
  /** Extra classes for layout/context (e.g. "apps-relays-save"). */
  class?: string
}

// ─── icons ────────────────────────────────────────────────────────
// Inline SVG glyphs (stroke = currentColor, 1em) so they sit consistently next
// to text and follow the theme — no more mismatched unicode characters.
const ICONS: Record<string, string> = {
  tile: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  pack: '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>',
  grid: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M8 2v12M2 8h12"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  save: '<path d="M8 2.5v6M5.5 6L8 8.5 10.5 6"/><path d="M3 11v1.5h10V11"/>',
  reset: '<path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5"/><path d="M3 3v2.7h2.7"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'
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
  svg.innerHTML = ICONS[name] || ""
  return svg
}

// Create a styled <button>. Variant drives appearance; layout stays on the
// parent (pass `class` for context-specific positioning if needed).
export function button(opts: ButtonOpts = {}): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = opts.type || "button"
  b.className = `btn btn-${opts.variant || "outline"}${opts.class ? ` ${opts.class}` : ""}`
  if (opts.label != null) b.textContent = opts.label
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
