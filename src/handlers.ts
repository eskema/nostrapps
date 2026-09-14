import * as persist from "./persistence.js"
import { NappWindowState } from "./types.js"

// napp.action() options: `instance` targets an existing window;
// `auxiliary` restricts the dispatch to apps advertising the "auxiliary"
// mode (their window is ephemeral — see runNappAction in main.ts).
export type ActionOptions = { instance?: string; auxiliary?: boolean }

// action name → nappIds that can handle it
const actionMap = new Map<string, string[]>()

// nappId → actions for reverse lookup
const subs = new Set<() => void>()
let actionDispatcher:
  | ((
      callerNappId: string,
      name: string,
      payload: unknown,
      options?: ActionOptions
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

export function findHandlersForAction(
  action: string,
  options?: ActionOptions
): [string[], NappWindowState[]] {
  // Copy — actionMap.get returns the stored array by reference, and the view:
  // push below would otherwise mutate it (appending "view" handlers on every
  // call, so the candidate list grows by duplicates each dispatch).
  let apps = [...(actionMap.get(action) || [])]

  // special case
  if (action.startsWith("view:")) apps.push(...(actionMap.get("view") || []))

  // Mode-gated dispatch: auxiliary calls only consider apps advertising
  // "auxiliary"; normal calls only consider apps advertising "normal" (absent
  // modes imply ["normal"] — see modesOfApp). An app listing both appears in
  // both; headless-only apps are reachable solely via an explicit instance.
  const wantAuxiliary = !!options?.auxiliary
  apps = apps.filter(nappId =>
    persist
      .modesOfApp(persist.getInstalledApp(nappId))
      .includes(wantAuxiliary ? "auxiliary" : "normal")
  )

  // An auxiliary dispatch always opens a fresh ephemeral window that closes
  // itself on response — never route it into an already-open window.
  const openCandidates = options?.auxiliary
    ? []
    : persist.readOpen().filter(w => apps.includes(w.nappId))
  return [apps, openCandidates]
}

// Whether any installed app handles this action (the "view" wildcard included).
export function hasAction(name: string): boolean {
  return actionMap.has(name) || (name.startsWith("view:") && actionMap.has("view"))
}

export function setActionDispatcher(
  fn:
    | ((
        callerNappId: string,
        name: string,
        payload: unknown,
        options?: ActionOptions
      ) => Promise<unknown>)
    | null
) {
  actionDispatcher = fn
}

export function dispatchAction(
  callerNappId: string,
  name: string,
  payload: unknown,
  options?: ActionOptions
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
