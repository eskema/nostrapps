import type { InstalledApp, NappWindowState } from "../types.js"
import { button } from "./ui.js"

export interface HandlerBodyOpts {
  actionName: string
  payload: unknown
  candidates: string[]
  openCandidates: NappWindowState[]
  apps: { list(): InstalledApp[]; get(nappId: string): InstalledApp | undefined }
  onSelect: (nappId: string, instanceId?: string) => void
}

// Builds the action-handler picker body shown inside a launcher shell (the
// cursor popover via openPopover, or openDialog). Selecting an already-open
// instance or a candidate calls onSelect; cancel / dismiss is up to the shell.
export function buildHandlerBody(o: HandlerBodyOpts): HTMLElement {
  const root = document.createElement("div")
  root.className = "handler-panel"

  // ── request: "action: <name>" on one line, then the payload ──
  const request = document.createElement("div")
  request.className = "handler-request"
  const actionLine = document.createElement("div")
  actionLine.className = "handler-action"
  const lbl = document.createElement("span")
  lbl.className = "handler-request-label"
  lbl.textContent = "action:"
  actionLine.append(lbl, el("code", "handler-action-name", o.actionName || "(none)"))
  request.append(actionLine, el("pre", "handler-payload", formatPayload(o.payload)))
  root.appendChild(request)

  const appLabel = (app: InstalledApp | undefined, nappId: string) =>
    app?.petname || app?.title || nappId

  // ── already-open instances first (route to an existing window) ──
  if (o.openCandidates.length) {
    const openEl = document.createElement("div")
    openEl.className = "handler-open-instances"
    openEl.appendChild(el("h3", "", "Already open"))
    const list = document.createElement("ul")
    list.className = "handler-list"
    const counts = new Map<string, number>()
    for (const win of o.openCandidates) {
      const app = o.apps.get(win.nappId)
      const n = (counts.get(win.nappId) || 0) + 1
      counts.set(win.nappId, n)
      list.appendChild(
        handlerItem(appLabel(app, win.nappId), n, () => o.onSelect(win.nappId, win.instanceId))
      )
    }
    openEl.appendChild(list)
    root.appendChild(openEl)
  }

  // ── candidates (open a new app) ──
  const candidatesEl = document.createElement("div")
  candidatesEl.className = "handler-candidates"
  candidatesEl.appendChild(el("h3", "", "Open new app"))
  if (o.candidates.length === 0) {
    candidatesEl.appendChild(el("div", "handler-empty", "No installed app declares this action."))
  } else {
    const byId = new Map(o.apps.list().map(app => [app.nappId, app]))
    const list = document.createElement("ul")
    list.className = "handler-list"
    for (const nappId of o.candidates) {
      const app = byId.get(nappId)
      list.appendChild(handlerItem(appLabel(app, nappId), null, () => o.onSelect(nappId)))
    }
    candidatesEl.appendChild(list)
  }
  root.appendChild(candidatesEl)

  return root
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = text
  return node
}

// A picker row, built on the design-system button. `num` (the per-app window
// number) is shown only for already-open instances.
function handlerItem(text: string, num: number | null, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li")
  const btn = button({ variant: "outline", class: "handler-item", onClick })
  const title = document.createElement("span")
  title.className = "handler-pet"
  title.textContent = text
  btn.appendChild(title)
  if (num != null) {
    const badge = document.createElement("span")
    badge.className = "handler-num"
    badge.textContent = `#${num}`
    btn.appendChild(badge)
  }
  item.appendChild(btn)
  return item
}

function formatPayload(payload: unknown) {
  if (payload === undefined) return "undefined"
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
