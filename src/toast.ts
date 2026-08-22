// Non-modal prompts for the whole launcher — one fixed stack at the bottom
// right. Like openDialog, actions resolve a value, but several can show at
// once: the list scrolls (sized for ~3 cards). Toasts sharing a `group` get one
// bar pinned above the list whose actions settle every toast in the group.
import { button } from "./system-napps/ui.js"
import type { DialogAction } from "./dialog.js"

export interface ToastGroup<T> {
  key: string
  // Bar text for n toasts in the group, e.g. n => `${n} relays asking`
  label: (n: number) => string
  actions: DialogAction<T>[]
}

export interface ToastOptions<T> {
  title: string
  // A monospace line under the title (a relay url, a key).
  code?: string
  hint?: string
  actions: DialogAction<T>[]
  group?: ToastGroup<T>
}

interface Item<T> {
  opts: ToastOptions<T>
  resolve: (value: T) => void
  el: HTMLDivElement | null
}

const items: Item<any>[] = []
let stack: HTMLDivElement | null = null
let list: HTMLDivElement | null = null

function ensureStack(): HTMLDivElement {
  if (!stack || !stack.isConnected) {
    stack = document.createElement("div")
    stack.className = "toasts"
    list = document.createElement("div")
    list.className = "toasts-list"
    stack.appendChild(list)
    document.body.appendChild(stack)
  }
  return stack
}

export function openToast<T = string>(opts: ToastOptions<T>): Promise<T> {
  return new Promise<T>(resolve => {
    items.push({ opts, resolve, el: null })
    render()
  })
}

function settle<T>(item: Item<T>, value: T) {
  const i = items.indexOf(item)
  if (i < 0) return
  items.splice(i, 1)
  item.el?.remove()
  item.resolve(value)
  render()
}

function settleGroup<T>(key: string, value: T) {
  for (const it of items.filter(it => it.opts.group?.key === key)) settle(it, value)
}

function card<T>(item: Item<T>): HTMLDivElement {
  const { opts } = item
  const el = document.createElement("div")
  el.className = "toast"
  const text = document.createElement("div")
  text.className = "toast-text"
  const title = document.createElement("div")
  title.textContent = opts.title
  text.appendChild(title)
  if (opts.code) {
    const code = document.createElement("code")
    code.textContent = opts.code
    text.appendChild(code)
  }
  if (opts.hint) {
    const hint = document.createElement("div")
    hint.className = "toast-hint"
    hint.textContent = opts.hint
    text.appendChild(hint)
  }
  const actions = document.createElement("div")
  actions.className = "toast-actions"
  for (const a of opts.actions) {
    actions.appendChild(
      button({ label: a.label, variant: a.variant, onClick: () => settle(item, a.value) })
    )
  }
  el.append(text, actions)
  return el
}

function render() {
  const el = ensureStack()
  if (items.length === 0) {
    el.remove()
    stack = list = null
    return
  }
  // Group bars, pinned above the scrolling list: one per group with 2+ members.
  const groups = new Map<string, Item<any>[]>()
  for (const it of items) if (it.opts.group) {
    const members = groups.get(it.opts.group.key) || []
    members.push(it)
    groups.set(it.opts.group.key, members)
  }
  for (const old of el.querySelectorAll(".toast-group")) old.remove()
  for (const [key, members] of groups) {
    if (members.length < 2) continue
    const g = members[0].opts.group!
    const bar = document.createElement("div")
    bar.className = "toast-group"
    const label = document.createElement("span")
    label.textContent = g.label(members.length)
    const actions = document.createElement("div")
    actions.className = "toast-actions"
    for (const a of g.actions) {
      actions.appendChild(
        button({ label: a.label, variant: a.variant, onClick: () => settleGroup(key, a.value) })
      )
    }
    bar.append(label, actions)
    el.prepend(bar)
  }
  for (const it of items) {
    if (!it.el) {
      it.el = card(it)
      list!.appendChild(it.el)
    }
  }
}
