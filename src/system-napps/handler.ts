import type { InstalledApp, NappWindowState } from "../types.js"
import * as persist from "../persistence.js"
import * as handlers from "../handlers.js"
import { nappNameText } from "../napp-name.js"
import { formatPayload } from "../utils.js"
import { button, code, codeBlock, empty, appIcon, icon, author, el as node } from "./ui.js"

export interface HandlerBodyOpts {
  showRequest?: boolean
  actionName: string
  payload: unknown
  candidates: string[]
  openCandidates: NappWindowState[]
  apps: { list(): InstalledApp[]; get(nappId: string): InstalledApp | undefined }
  onSelect: (nappId: string, instanceId?: string) => void
}

// The request being opened: "action: <name>" on one line, then the payload.
export function buildHandlerRequest(actionName: string, payload: unknown): HTMLElement {
  const request = document.createElement("div")
  request.className = "handler-request"
  const actionLine = document.createElement("div")
  actionLine.className = "handler-action"
  const lbl = document.createElement("span")
  lbl.className = "handler-request-label"
  lbl.textContent = "action:"
  actionLine.append(lbl, code(actionName || "(none)"))
  request.append(actionLine, codeBlock(formatPayload(payload), "handler-payload"))
  return request
}

// Builds the action-handler picker body shown inside a launcher shell (the
// cursor popover via openPopover, or openDialog). Selecting an already-open
// instance or a candidate calls onSelect; cancel / dismiss is up to the shell.
export function buildHandlerBody(o: HandlerBodyOpts): HTMLElement {
  const root = document.createElement("div")
  root.className = "handler-panel"

  if (o.showRequest !== false) root.appendChild(buildHandlerRequest(o.actionName, o.payload))

  const appLabel = (app: InstalledApp | undefined, nappId: string) =>
    app?.petname || app?.title || nappNameText(nappId)

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
        handlerItem(appLabel(app, win.nappId), app, n, () => o.onSelect(win.nappId, win.instanceId))
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
    candidatesEl.appendChild(empty("No installed app declares this action."))
  } else {
    const byId = new Map(o.apps.list().map(app => [app.nappId, app]))
    const list = document.createElement("ul")
    list.className = "handler-list"
    for (const nappId of o.candidates) {
      const app = byId.get(nappId)
      list.appendChild(handlerItem(appLabel(app, nappId), app, null, () => o.onSelect(nappId)))
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
function handlerItem(
  text: string,
  app: InstalledApp | undefined,
  num: number | null,
  onClick: () => void
): HTMLLIElement {
  const item = document.createElement("li")
  const btn = handlerChoice({
    title: text,
    pubkey: app?.event?.pubkey,
    iconSources: app
      ? () => import("../nsite/icon.js").then(m => m.installedIconSources(app))
      : undefined,
    onSelect: onClick
  })
  btn.classList.add("handler-item")
  if (num != null) {
    const badge = document.createElement("span")
    badge.className = "handler-num"
    badge.textContent = `#${num}`
    btn.appendChild(badge)
  }
  item.appendChild(btn)
  return item
}

// Both action and intent pickers use the same accessible, full-width app row.
export function handlerChoice(opts: {
  title: string
  pubkey?: string
  iconSources?: () => Promise<string[]>
  onSelect(): void
}): HTMLButtonElement {
  const picture = appIcon({ size: "m", fade: true })
  picture.append(icon("tile"))
  picture.setAttribute("aria-hidden", "true")
  if (opts.iconSources)
    void opts
      .iconSources()
      .then(sources => {
        if (!sources.length) return
        let next = 0
        picture.img.addEventListener("error", () => {
          if (++next < sources.length) picture.img.src = sources[next]
        })
        picture.img.src = sources[0]
      })
      .catch(() => {})
  const row = button({ class: "intent-handler-choice", onClick: opts.onSelect })
  row.setAttribute("aria-label", opts.title)
  row.append(
    picture,
    node(
      "span",
      "intent-handler-copy",
      node("span", "intent-handler-title", opts.title),
      ...(opts.pubkey
        ? [node("span", "intent-handler-author", author(opts.pubkey, { link: false }))]
        : [])
    )
  )
  return row
}

export function buildNappHandlerChoices(
  name: string,
  payload: unknown,
  select: (target: handlers.ActionTarget) => void
): HTMLElement | undefined {
  const [candidates, openCandidates] = handlers.findHandlersForAction(name)
  if (!handlers.hasUserActionHandler(name)) return
  return buildHandlerBody({
    showRequest: false,
    actionName: name,
    payload,
    candidates,
    openCandidates,
    apps: { list: persist.getInstalledApps, get: persist.getInstalledApp },
    onSelect: (nappId, instanceId) => select({ nappId, instanceId })
  })
}
