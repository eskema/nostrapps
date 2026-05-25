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

function actionsFromInstalledApp(app: any): string[] {
  if (!app) return []
  if (Array.isArray(app.actions)) {
    return [...new Set(app.actions.filter((a: unknown) => typeof a === "string" && a.length))]
  }
  if (!Array.isArray(app.tags)) return []
  const out = []
  for (const t of app.tags) {
    if (t[0] === "action" && typeof t[1] === "string" && t[1]) out.push(t[1])
  }
  return [...new Set(out)]
}

function nappIdFromInstalledApp(app: persist.InstalledApp): string {
  if ("nappId" in app && typeof app.nappId === "string" && app.nappId) return app.nappId
  return persist.computeNappId(app)
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
    setAppActions(nappIdFromInstalledApp(app), actionsFromInstalledApp(app))
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
