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
import { button, icon, overline, type ButtonVariant } from "./system-napps/ui.js"

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
  // How this request reads while it waits behind another one. Whatever is here
  // is all the user gets to judge it by, so it has to carry enough to settle it
  // unseen. Without it the queue can only say `title`.
  queue?: DialogQueueInfo
}

export interface DialogQueueInfo {
  // What is being asked: "install", "permission", "log in", "settings".
  kind: string
  // Who is asking. A node so an app's line can fill its author in when the
  // profile lands (nappNameEl); a string for what isn't an app.
  name?: Node | string
  // What kind of thing is being asked about, at the line's end: an app's
  // nsite / napp / napplet, the method a permission wants.
  type?: string
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
  // The row this request shows as while it waits. Built once and reused: the
  // list is reordered by moving nodes, never rebuilt.
  row?: HTMLElement
}

// Only one modal can be shown at a time (single <dialog>, and showModal() throws
// on an already-open one), so requests queue. The queue is an explicit array so
// the open dialog can surface the ones waiting behind it and settle them.
const queue: Pending<any>[] = []
let showing = false
// The open request and its settle function (group actions reach it from the
// queue bar).
let current: { opts: DialogOptions<any>; finish: (value: any) => void } | null = null

export function openDialog<T = string>(opts: DialogOptions<T>): Promise<T> {
  return new Promise<T>(resolve => {
    queue.push({ opts, resolve })
    if (showing)
      renderQueueBar() // the open dialog lists the new request
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

// Settle one waiting request without ever showing it: it leaves the queue with
// the value a dismissal would have given it.
function dropQueued(p: Pending<any>) {
  const i = queue.indexOf(p)
  if (i < 0) return
  queue.splice(i, 1)
  p.resolve(p.opts.dismissValue)
  renderQueueBar()
}

// The same for the whole backlog, in one click. The open dialog is left for the
// user to act on explicitly.
function dismissAllQueued() {
  for (const it of queue.splice(0)) it.resolve(it.opts.dismissValue)
  renderQueueBar()
}

// Settle the open request and every queued one sharing its group key.
function settleGroup(key: string, value: any) {
  for (const m of [...queue]) {
    if (m.opts.group?.key !== key) continue
    queue.splice(queue.indexOf(m), 1)
    m.resolve(value)
  }
  current?.finish(value)
}

// One waiting request, on one line: what is being asked and by whom, the kinds
// at each end, and an x to settle this one alone.
function queueRow(p: Pending<any>): HTMLElement {
  const q = p.opts.queue
  const row = document.createElement("li")
  row.className = "app-dialog-queue-item"

  const line = document.createElement("div")
  line.className = "app-dialog-queue-line"
  const kind = q?.kind || "request"
  line.appendChild(overline(kind))
  const name = document.createElement("span")
  name.className = "app-dialog-queue-name"
  name.append(q?.name || p.opts.title || "")
  line.appendChild(name)
  if (q?.type) line.appendChild(overline(q.type))

  const drop = button({
    variant: "ghost",
    title: `Dismiss this ${kind}`,
    class: "app-dialog-queue-drop",
    onClick: () => dropQueued(p)
  })
  drop.appendChild(icon("close"))
  row.append(line, drop)
  return row
}

// The queue card's live parts. It is built with the dialog it sits on (showOne
// empties the element) and then updated in place as requests arrive and leave —
// a rebuild under a finger is a dropped tap.
let bar: {
  panel: HTMLElement
  count: HTMLElement
  group: HTMLElement
  groupLabel: HTMLElement
  list: HTMLElement
} | null = null

function buildQueueBar(el: HTMLDialogElement): NonNullable<typeof bar> {
  const panel = document.createElement("div")
  panel.className = "app-dialog-queue"
  // Head: the count toggles the card; "Dismiss all" only shows while it is open
  // (CSS) and must not toggle it.
  const head = document.createElement("div")
  head.className = "app-dialog-queue-head"
  head.addEventListener("click", () => panel.classList.toggle("collapsed"))
  const count = document.createElement("span")
  count.className = "app-dialog-queue-count"
  const dismiss = button({
    label: "Dismiss all",
    variant: "ghost",
    class: "app-dialog-queue-dismiss",
    onClick: e => {
      e.stopPropagation()
      dismissAllQueued()
    }
  })
  head.append(count, dismiss)
  // Group actions: settle the open request and every queued one in its group.
  // Its own row, visible even when the card is collapsed. The open request
  // can't change under this panel, so the buttons are built with it.
  const group = document.createElement("div")
  group.className = "app-dialog-queue-group"
  const groupLabel = document.createElement("span")
  group.appendChild(groupLabel)
  const g = current?.opts.group
  if (g)
    for (const a of g.actions)
      group.appendChild(
        button({ label: a.label, variant: a.variant, onClick: () => settleGroup(g.key, a.value) })
      )
  const list = document.createElement("ul")
  list.className = "app-dialog-queue-list"
  panel.append(head, group, list)
  el.querySelector(".app-dialog-cards")?.appendChild(panel)
  return { panel, count, group, groupLabel, list }
}

function renderQueueBar() {
  const el = dialogEl
  if (!el) return
  if (queue.length === 0) {
    bar?.panel.remove()
    bar = null
    return
  }
  // A new dialog empties the element, taking the old panel with it.
  if (!bar?.panel.isConnected) bar = buildQueueBar(el)
  bar.count.textContent = `${queue.length} waiting`
  const g = current?.opts.group
  const members = g ? queue.filter(q => q.opts.group?.key === g.key).length : 0
  bar.group.hidden = members === 0
  if (g && members) bar.groupLabel.textContent = g.label(members + 1)
  // Each request keeps its row, so the list is put in order by moving only what
  // is out of place — nothing under the pointer is replaced.
  const rows = queue.map(p => (p.row ||= queueRow(p)))
  for (let i = 0; i < rows.length; i++)
    if (bar.list.children[i] !== rows[i])
      bar.list.insertBefore(rows[i], bar.list.children[i] || null)
  while (bar.list.children.length > rows.length) bar.list.lastElementChild!.remove()
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
    // Closed by anything else. close() QUEUES its event rather than firing it,
    // so the one from the dialog before this can land after pump() has already
    // reshown the same element for this request — which would settle this one
    // at dismissValue the moment it appears. A real close clears .open before
    // its event fires, so an open dialog means the event belongs to the last.
    const onClose = () => {
      if (!el.open) finish(opts.dismissValue)
    }
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
