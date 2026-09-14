// Reusable modal dialog for the whole launcher — a single native <dialog>
// reused across callers. Build prompts/pickers on top of this rather than
// hand-rolling one-off modals. Buttons come from the design system (ui.ts).
//
// Opened with show(), not showModal(): the modality is ours. showModal() puts
// the dialog in the top layer, above every z-index, and makes all but its own
// descendants inert — nothing else can be live over it, not the toasts, not a
// popover opened meanwhile. Here the dialog is a z-index tier like the windows
// (.app-dialog), the toasts a tier above it, and the rest of the body goes
// inert by attribute while one is open. Esc is a keydown; the back gesture a
// CloseWatcher, the same thing showModal() uses underneath.
import { button, type ButtonVariant } from "./system-napps/ui.js"

export interface DialogAction<T> {
  label: string
  value: T
  variant?: ButtonVariant
  autofocus?: boolean
}

export interface DialogOptions<T> {
  title?: string
  // Body content: a prebuilt node/string, OR a builder that receives `resolve`
  // so interactive content (e.g. a picker list) can settle the dialog itself.
  body?: Node | string
  build?: (resolve: (value: T) => void) => Node
  actions?: DialogAction<T>[]
  // Returned when the dialog is dismissed via Esc or a backdrop click.
  dismissValue: T
  class?: string
  // Requests sharing a group key can be settled together from the queue bar:
  // its actions apply to the open dialog and every queued request in the group.
  group?: { key: string; label: (n: number) => string; actions: DialogAction<T>[] }
}

// One reusable modal element, created lazily and reused across calls.
let dialogEl: HTMLDialogElement | null = null
function ensureDialog(): HTMLDialogElement {
  if (!dialogEl) {
    dialogEl = document.createElement("dialog")
    document.body.appendChild(dialogEl)
  }
  return dialogEl
}

// Body children left live under an open dialog: the toasts (a tier above it)
// and popovers (top layer, above any tier). Everything else goes inert —
// only what we set, so an already-inert element stays that way after.
const LIVE = ".toasts, [popover]"
let inerted: Element[] = []
function inertOthers(el: HTMLDialogElement) {
  for (const c of document.body.children) {
    if (c === el || c.hasAttribute("inert") || c.matches(LIVE)) continue
    c.setAttribute("inert", "")
    inerted.push(c)
  }
}
function wakeOthers() {
  for (const c of inerted) c.removeAttribute("inert")
  inerted = []
}

interface Pending<T> {
  opts: DialogOptions<T>
  resolve: (value: T) => void
}

// Only one modal can be shown at a time (single <dialog>, and showModal() throws
// on an already-open one), so requests queue. The queue is an explicit array so
// the open dialog can surface "N more queued" and offer to dismiss the backlog.
const queue: Pending<any>[] = []
let showing = false
// The open request and its settle function (group actions reach it from the
// queue bar).
let current: { opts: DialogOptions<any>; finish: (value: any) => void } | null = null

export function openDialog<T = string>(opts: DialogOptions<T>): Promise<T> {
  return new Promise<T>(resolve => {
    queue.push({ opts, resolve })
    if (showing)
      renderQueueBar() // refresh the count on the open dialog
    else pump()
  })
}

function pump() {
  const item = queue.shift()
  if (!item) {
    showing = false
    return
  }
  showing = true
  showOne(item.opts).then(value => {
    item.resolve(value)
    pump()
  })
}

// Resolve every still-queued request (the ones behind the open dialog) with its
// own dismissValue, clearing the backlog in one click. The open dialog is left
// for the user to act on explicitly.
function dismissAllQueued() {
  const items = queue.splice(0)
  for (const it of items) it.resolve(it.opts.dismissValue)
  renderQueueBar()
}

function renderQueueBar() {
  const el = dialogEl
  if (!el) return
  const titles = queue.map(q => q.opts.title || "Request")
  let panel = el.querySelector(".app-dialog-queue") as HTMLElement | null
  if (titles.length === 0) {
    panel?.remove()
    return
  }
  // Collapsed by default (count only); preserve the user's expand state across
  // rebuilds when new requests arrive.
  const collapsed = panel ? panel.classList.contains("collapsed") : true
  if (!panel) {
    panel = document.createElement("div")
    panel.className = "app-dialog-queue"
    el.querySelector(".app-dialog-cards")?.appendChild(panel)
  }
  panel.classList.toggle("collapsed", collapsed)

  // Head: count (always visible) toggles collapse; "Dismiss all" only shows when
  // expanded (CSS) and must not toggle the panel.
  const head = document.createElement("div")
  head.className = "app-dialog-queue-head"
  head.addEventListener("click", () => panel!.classList.toggle("collapsed"))
  const count = document.createElement("span")
  count.className = "app-dialog-queue-count"
  count.textContent = `${titles.length} queued`
  const dismiss = button({
    label: "Dismiss all",
    variant: "ghost",
    class: "app-dialog-queue-dismiss"
  })
  dismiss.addEventListener("click", e => {
    e.stopPropagation()
    dismissAllQueued()
  })
  head.append(count, dismiss)
  // Group actions: settle the open request and every queued one in its group.
  // Its own row, visible even when the panel is collapsed.
  let groupRow: HTMLElement | null = null
  const g = current?.opts.group
  const members = g ? queue.filter(q => q.opts.group?.key === g.key) : []
  if (g && members.length > 0) {
    groupRow = document.createElement("div")
    groupRow.className = "app-dialog-queue-group"
    const label = document.createElement("span")
    label.textContent = g.label(members.length + 1)
    groupRow.appendChild(label)
    for (const a of g.actions) {
      groupRow.appendChild(
        button({
          label: a.label,
          variant: a.variant,
          onClick: () => {
            for (const m of members) {
              const i = queue.indexOf(m)
              if (i >= 0) queue.splice(i, 1)
              m.resolve(a.value)
            }
            current?.finish(a.value)
          }
        })
      )
    }
  }

  const list = document.createElement("ul")
  list.className = "app-dialog-queue-list"
  for (const t of titles) {
    const li = document.createElement("li")
    li.textContent = t
    list.appendChild(li)
  }
  panel.replaceChildren(...(groupRow ? [head, groupRow, list] : [head, list]))
}

function showOne<T>(opts: DialogOptions<T>): Promise<T> {
  const el = ensureDialog()
  return new Promise<T>(resolve => {
    let settled = false
    const prev = document.activeElement
    let watcher: CloseWatcher | null = null
    const finish = (value: T) => {
      if (settled) return
      settled = true
      current = null
      watcher?.destroy()
      document.removeEventListener("keydown", onKey)
      el.removeEventListener("close", onClose)
      el.removeEventListener("mousedown", onMouseDown)
      el.removeEventListener("click", onClick)
      wakeOthers() // before close(): focus can't go back to an inert element
      el.close()
      // close() hands focus back only while it is still in the dialog; a scrim
      // click has dropped it on the body.
      if (document.activeElement === document.body && prev instanceof HTMLElement) prev.focus()
      resolve(value)
    }
    const onClose = () => finish(opts.dismissValue) // closed by anything else
    // Esc. Not if a card handled it, and an open popover takes the key first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      if (!document.body.classList.contains("popover-open")) finish(opts.dismissValue)
    }
    // Scrim dismiss: the dialog is the whole viewport and the cards its
    // children, so an event on the dialog itself is one on the scrim — and
    // only when BOTH the press AND the release land there. Tracking mousedown
    // (not just the click, which fires on mouseup) means a text selection that
    // starts in a card and is released on the scrim does NOT close the dialog.
    let pressedScrim = false
    const onMouseDown = (e: MouseEvent) => {
      pressedScrim = e.target === el
    }
    const onClick = (e: MouseEvent) => {
      if (pressedScrim && e.target === el) finish(opts.dismissValue)
    }

    el.className = `app-dialog${opts.class ? ` ${opts.class}` : ""}`
    el.replaceChildren()

    // The centred column: the prompt is one surface card; the queue panel is a
    // sibling card (appended by renderQueueBar). The scrim shows between them.
    const cards = document.createElement("div")
    cards.className = "app-dialog-cards"
    const card = document.createElement("div")
    card.className = "app-dialog-body"

    if (opts.title) {
      const h = document.createElement("h3")
      h.className = "app-dialog-title"
      h.textContent = opts.title
      card.appendChild(h)
    }

    const content = document.createElement("div")
    content.className = "app-dialog-content"
    if (opts.build) content.appendChild(opts.build(finish))
    else if (typeof opts.body === "string") content.textContent = opts.body
    else if (opts.body) content.appendChild(opts.body)
    card.appendChild(content)

    if (opts.actions?.length) {
      const menu = document.createElement("menu")
      menu.className = "app-dialog-actions"
      for (const a of opts.actions) {
        const btn = button({
          label: a.label,
          variant: a.variant || "outline",
          onClick: () => finish(a.value)
        })
        if (a.autofocus) btn.autofocus = true
        menu.appendChild(btn)
      }
      card.appendChild(menu)
    }

    cards.appendChild(card)
    el.appendChild(cards)

    el.addEventListener("close", onClose)
    el.addEventListener("mousedown", onMouseDown)
    el.addEventListener("click", onClick)
    current = { opts, finish }
    renderQueueBar() // show the queue panel if requests are waiting behind this one
    // show() notes the focused element and moves focus in; only then can the
    // rest go inert without blurring it first.
    el.show()
    inertOthers(el)
    document.addEventListener("keydown", onKey)
    if ("CloseWatcher" in window) {
      watcher = new CloseWatcher()
      watcher.onclose = () => finish(opts.dismissValue)
    }
  })
}
