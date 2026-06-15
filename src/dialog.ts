// Reusable modal dialog for the whole launcher — a single native <dialog>
// (showModal) reused across callers. Build prompts/pickers on top of this rather
// than hand-rolling one-off modals. Buttons come from the design system (ui.ts).
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

interface Pending<T> {
  opts: DialogOptions<T>
  resolve: (value: T) => void
}

// Only one modal can be shown at a time (single <dialog>, and showModal() throws
// on an already-open one), so requests queue. The queue is an explicit array so
// the open dialog can surface "N more queued" and offer to dismiss the backlog.
const queue: Pending<any>[] = []
let showing = false

export function openDialog<T = string>(opts: DialogOptions<T>): Promise<T> {
  return new Promise<T>(resolve => {
    queue.push({ opts, resolve })
    if (showing) renderQueueBar() // refresh the count on the open dialog
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
    el.appendChild(panel)
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

  const list = document.createElement("ul")
  list.className = "app-dialog-queue-list"
  for (const t of titles) {
    const li = document.createElement("li")
    li.textContent = t
    list.appendChild(li)
  }
  panel.replaceChildren(head, list)
}

function showOne<T>(opts: DialogOptions<T>): Promise<T> {
  const el = ensureDialog()
  return new Promise<T>(resolve => {
    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      el.removeEventListener("close", onClose)
      el.removeEventListener("mousedown", onMouseDown)
      el.removeEventListener("click", onClick)
      el.close()
      resolve(value)
    }
    const onClose = () => finish(opts.dismissValue) // Esc
    // Backdrop dismiss: only when BOTH the press AND the release land outside the
    // dialog box. Tracking mousedown (not just the click, which fires on mouseup)
    // means a text selection that starts inside and is released on the backdrop
    // does NOT close the dialog.
    const outside = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    let pressedOutside = false
    const onMouseDown = (e: MouseEvent) => {
      pressedOutside = outside(e)
    }
    const onClick = (e: MouseEvent) => {
      if (pressedOutside && outside(e)) finish(opts.dismissValue)
    }

    el.className = `app-dialog${opts.class ? ` ${opts.class}` : ""}`
    el.replaceChildren()

    // The prompt itself is one surface card; the queue panel is a sibling card
    // (appended by renderQueueBar). The transparent dialog just stacks them.
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

    el.appendChild(card)

    el.addEventListener("close", onClose)
    el.addEventListener("mousedown", onMouseDown)
    el.addEventListener("click", onClick)
    renderQueueBar() // show the queue panel if requests are waiting behind this one
    el.showModal()
  })
}
