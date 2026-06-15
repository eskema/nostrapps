import type { InstalledApp, NappWindowState } from "../types.js"

export interface HandlerBodyOpts {
  actionName: string
  payload: unknown
  candidates: string[]
  openCandidates: NappWindowState[]
  apps: { list(): InstalledApp[]; get(nappId: string): InstalledApp | undefined }
  onSelect: (nappId: string, instanceId?: string) => void
}

// Builds the action-handler picker body shown inside a launcher shell (the
// cursor popover via openPopover, or openDialog). Selecting a candidate or an
// already-open instance calls onSelect; cancel / dismiss is handled by the shell.
export function buildHandlerBody(o: HandlerBodyOpts): HTMLElement {
  const root = document.createElement("div")
  root.className = "handler-panel"

  // ── request summary ──
  const request = document.createElement("div")
  request.className = "handler-request"
  request.append(
    label("action"),
    el("code", "handler-action-name", o.actionName || "(none)"),
    label("value"),
    el("pre", "handler-payload", formatPayload(o.payload))
  )
  root.appendChild(request)

  const appLabel = (app: InstalledApp | undefined, nappId: string) =>
    app?.petname || app?.title || nappId

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
      list.appendChild(handlerItem(appLabel(app, nappId), nappId, () => o.onSelect(nappId)))
    }
    candidatesEl.appendChild(list)
  }
  root.appendChild(candidatesEl)

  // ── already-open instances ──
  if (o.openCandidates.length) {
    const openEl = document.createElement("div")
    openEl.className = "handler-open-instances"
    openEl.appendChild(el("h3", "", "Already open"))
    const list = document.createElement("ul")
    list.className = "handler-list"
    for (const win of o.openCandidates) {
      const app = o.apps.get(win.nappId)
      list.appendChild(
        handlerItem(appLabel(app, win.nappId), app?.title || win.nappId, () =>
          o.onSelect(win.nappId, win.instanceId)
        )
      )
    }
    openEl.appendChild(list)
    root.appendChild(openEl)
  }

  return root
}

function label(text: string): HTMLElement {
  return el("div", "handler-request-label", text)
}

function el(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = text
  return node
}

function handlerItem(text: string, idText: string, onClick: () => void): HTMLLIElement {
  const item = document.createElement("li")
  const btn = document.createElement("button")
  btn.type = "button"
  const title = document.createElement("span")
  title.className = "handler-pet"
  title.textContent = text
  const idEl = document.createElement("code")
  idEl.className = "handler-id"
  idEl.textContent = idText
  btn.append(title, idEl)
  btn.addEventListener("click", onClick)
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
