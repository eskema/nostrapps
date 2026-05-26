import * as persist from "./persistence.js"

// action name → nappIds that can handle it
const actionMap = new Map<string, string[]>()
// nappId → actions for reverse lookup
const nappActions = new Map<string, string[]>()
const subs = new Set<() => void>()
let actionDispatcher:
  | ((callerNappId: string, name: string, payload: unknown) => Promise<unknown>)
  | null = null

function emit() {
  for (const fn of subs) fn()
}

function setAppActions(nappId: string, actions: string[]) {
  const old = nappActions.get(nappId)
  if (old) {
    for (const a of old) {
      const apps = actionMap.get(a)
      if (!apps) continue
      const next = apps.filter(id => id !== nappId)
      if (next.length === 0) actionMap.delete(a)
      else actionMap.set(a, next)
    }
  }
  if (actions.length === 0) {
    nappActions.delete(nappId)
    return
  }
  nappActions.set(nappId, actions)
  for (const action of actions) {
    const current = actionMap.get(action) || []
    if (!current.includes(nappId)) actionMap.set(action, [...current, nappId])
  }
}

export async function init() {
  actionMap.clear()
  nappActions.clear()
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
  const old = nappActions.get(nappId)
  if (old) {
    for (const a of old) {
      const apps = actionMap.get(a)
      if (!apps) continue
      const next = apps.filter(id => id !== nappId)
      if (next.length === 0) actionMap.delete(a)
      else actionMap.set(a, next)
    }
  }
  nappActions.delete(nappId)
  emit()
}

export function findHandlersForAction(action: string): string[] {
  if (typeof action !== "string" || !action) return []
  return [...(actionMap.get(action) || [])]
}

export function setActionDispatcher(
  fn: ((callerNappId: string, name: string, payload: unknown) => Promise<unknown>) | null
) {
  actionDispatcher = fn
}

export function dispatchAction(callerNappId: string, name: string, payload: unknown) {
  if (!actionDispatcher) {
    throw new Error("napp.action dispatch is not configured")
  }
  return actionDispatcher(callerNappId, name, payload)
}

export function getHandlers(nappId: string): string[] {
  if (typeof nappId !== "string" || !nappId) return []
  return nappActions.get(nappId) || []
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
