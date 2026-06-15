import * as persist from "./persistence.js"
import { NappWindowState } from "./types.js"

// action name → nappIds that can handle it
const actionMap = new Map<string, string[]>()

// nappId → actions for reverse lookup
const subs = new Set<() => void>()
let actionDispatcher:
  | ((
      callerNappId: string,
      name: string,
      payload: unknown,
      options?: { instance?: string }
    ) => Promise<unknown>)
  | null = null

function emit() {
  for (const fn of subs) fn()
}

function setAppActions(nappId: string, actions: string[]) {
  for (const action of actions) {
    const current = actionMap.get(action) || []
    if (!current.includes(nappId)) actionMap.set(action, [...current, nappId])
  }
}

export async function init() {
  actionMap.clear()
  for (const app of persist.getInstalledApps()) {
    setAppActions(app.nappId, app.actions)
  }
  emit()
}

export function addApp(nappId: string, actions: string[]) {
  if (!nappId) return
  const valid = Array.isArray(actions) ? actions.filter(a => typeof a === "string" && a.length) : []
  setAppActions(nappId, valid)
  emit()
}

export function removeApp(nappId: string) {
  for (const [_, nappIds] of actionMap.entries()) {
    const idx = nappIds.indexOf(nappId)
    if (idx !== -1) {
      nappIds[idx] = nappIds[nappIds.length - 1]
      nappIds.length--
    }
  }
  emit()
}

export function findHandlersForAction(action: string): [string[], NappWindowState[]] {
  const apps = actionMap.get(action) || []

  // special case
  if (action.startsWith("view:")) apps.push(...(actionMap.get("view") || []))

  const openCandidates = persist.readOpen().filter(w => apps.includes(w.nappId))
  return [apps, openCandidates]
}

export function setActionDispatcher(
  fn:
    | ((
        callerNappId: string,
        name: string,
        payload: unknown,
        options?: { instance?: string }
      ) => Promise<unknown>)
    | null
) {
  actionDispatcher = fn
}

export function dispatchAction(
  callerNappId: string,
  name: string,
  payload: unknown,
  options?: { instance?: string }
) {
  if (!actionDispatcher) {
    throw new Error("napp.action dispatch is not configured")
  }
  return actionDispatcher(callerNappId, name, payload, options)
}

export function snapshotActionMap(): Array<[string, string[]]> {
  return [...actionMap.entries()]
    .map(([action, nappIds]) => [action, [...nappIds].sort()] as [string, string[]])
    .sort(([a], [b]) => a.localeCompare(b))
}

export function subscribe(fn: () => void) {
  subs.add(fn)
  return () => subs.delete(fn)
}
