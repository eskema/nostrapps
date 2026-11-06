import type { InstalledApp, SuggestionItem } from "../types.js"
import type { OpenCandidate } from "../handlers.js"
import { nappNameText } from "../napp-name.js"
import { suggestionRow } from "../suggestion-row.js"
import { formatPayload } from "../utils.js"
import { check, code, codeBlock, empty } from "./ui.js"

export interface HandlerBodyOpts {
  actionName: string
  // Absent: a choice made from settings, with no action in flight.
  payload?: unknown
  candidates: string[]
  openCandidates: OpenCandidate[]
  // Windows in another space say which; reaching one switches there.
  currentSpaceId?: string
  apps: {
    list(): InstalledApp[]
    get(nappId: string): InstalledApp | undefined
    // What the launcher's row shows of an app: its type, author and icon.
    describe(app: InstalledApp | undefined): Partial<SuggestionItem>
  }
  // A "remember this choice" check under the lists, off to start with.
  remember?: boolean
  onSelect: (nappId: string, instanceId: string | undefined, remember: boolean) => void
}

// Builds the action-handler picker body shown inside a launcher shell (the
// cursor popover via openPopover, or openDialog): the request, then the
// launcher's own rows, open windows first, a divider, the apps to open new.
// Selecting one calls onSelect; cancel / dismiss is up to the shell.
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
  actionLine.append(lbl, code(o.actionName || "(none)"))
  request.append(actionLine)
  if (o.payload !== undefined)
    request.append(codeBlock(formatPayload(o.payload), "handler-payload"))
  root.appendChild(request)

  const remember = o.remember
    ? check({ label: "remember this choice", class: "handler-remember" })
    : null
  const box = remember?.querySelector("input") as HTMLInputElement | null

  const appLabel = (app: InstalledApp | undefined, nappId: string) =>
    app?.petname || app?.title || nappNameText(nappId)

  const rows = document.createElement("div")
  rows.className = "handler-rows"
  const add = (item: SuggestionItem, pick: () => void) => {
    const el = suggestionRow(item)
    el.addEventListener("click", pick)
    rows.appendChild(el)
  }

  // ── already-open windows first (route to an existing one) ──
  for (const { window: win, spaceId, spaceName } of o.openCandidates) {
    const app = o.apps.get(win.nappId)
    add(
      {
        source: "open",
        nappId: win.nappId,
        instanceId: win.instanceId,
        petname: appLabel(app, win.nappId),
        ...o.apps.describe(app),
        spaceId,
        spaceName,
        spaceCurrent: spaceId === o.currentSpaceId
      },
      () => o.onSelect(win.nappId, win.instanceId, !!box?.checked)
    )
  }

  // ── then the apps, each opening new ──
  if (o.openCandidates.length && o.candidates.length) {
    const divider = document.createElement("div")
    divider.className = "sugg-divider"
    rows.appendChild(divider)
  }
  if (o.candidates.length === 0) {
    rows.appendChild(empty("No installed app declares this action."))
  } else {
    const byId = new Map(o.apps.list().map(app => [app.nappId, app]))
    for (const nappId of o.candidates) {
      const app = byId.get(nappId)
      add({ source: "napp", nappId, petname: appLabel(app, nappId), ...o.apps.describe(app) }, () =>
        o.onSelect(nappId, undefined, !!box?.checked)
      )
    }
  }
  root.appendChild(rows)
  if (remember) root.appendChild(remember)

  return root
}
