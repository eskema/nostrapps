export const id = "logs"
export const title = "Logs"
export const slash = "/logs"
// Any view:<kind> no app handles. Routing an action already logs it with its
// payload, so taking it is all there is to do.
export const actions = ["view"]
// Entries arrive over time, so there's nothing to measure at mount: open at the
// standard height and let them scroll.
export const height = START_HEIGHT

import type { SystemCtx } from "../types.js"
import { START_HEIGHT } from "../sandbox/napp-window.js"
import { bar, button, el, sticky } from "./ui.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  const list = el("ul", "logs-view")
  const clearBtn = button({
    label: "clear",
    icon: "trash",
    variant: "ghost",
    onClick: () => ctx.logs.clear()
  })
  // Held at the top of the window while the entries scroll under it.
  const actions = sticky(bar(clearBtn))
  actions.classList.add("logs-actions")
  container.replaceChildren(actions, list)

  function fmtTime(at: number) {
    return new Date(at).toLocaleTimeString(undefined, { hour12: false })
  }

  // Append what is new and drop what was evicted; the list is never rebuilt.
  const rows = new Map<number, HTMLLIElement>()
  function render() {
    const entries = ctx.logs.history()
    const kept = new Set(entries.map(e => e.seq))
    for (const [seq, li] of rows) {
      if (kept.has(seq)) continue
      li.remove()
      rows.delete(seq)
    }
    for (const entry of entries) {
      if (rows.has(entry.seq)) continue
      const li = document.createElement("li")
      const time = document.createElement("time")
      const d = new Date(entry.at)
      time.dateTime = d.toISOString()
      time.textContent = fmtTime(entry.at)
      li.append(time, el("pre", "ui-code", entry.msg))
      list.appendChild(li)
      rows.set(entry.seq, li)
    }
    clearBtn.disabled = entries.length === 0
    const scroller = list.closest(".napp-body")
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  render()
  const unsub = ctx.logs.subscribe(render)

  return {
    unmount() {
      unsub()
    },
    action() {}
  }
}
