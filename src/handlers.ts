// action name → set of nappIds that can handle it
const actionMap = new Map<string, Set<string>>()
// nappId → actions for reverse lookup
const nappActions = new Map<string, string[]>()

export function init() {
  actionMap.clear()
  nappActions.clear()
}

export function addApp(nappId: string, actions: string[]) {
  if (!nappId) return
  const valid = Array.isArray(actions) ? actions.filter(a => typeof a === "string" && a.length) : []
  const old = nappActions.get(nappId)
  if (old) {
    for (const a of old) {
      actionMap.get(a)?.delete(nappId)
    }
  }
  if (valid.length === 0) {
    nappActions.delete(nappId)
  } else {
    nappActions.set(nappId, valid)
    for (const action of valid) {
      if (!actionMap.has(action)) actionMap.set(action, new Set())
      actionMap.get(action)!.add(nappId)
    }
  }
}

export function removeApp(nappId: string) {
  const old = nappActions.get(nappId)
  if (old) {
    for (const a of old) {
      actionMap.get(a)?.delete(nappId)
    }
  }
  nappActions.delete(nappId)
}

export function findHandlersForAction(action: string): string[] {
  if (typeof action !== "string" || !action) return []
  return [...(actionMap.get(action) || [])]
}

export function getHandlers(nappId: string): string[] {
  if (typeof nappId !== "string" || !nappId) return []
  return nappActions.get(nappId) || []
}
