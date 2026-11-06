// Remembered action handlers. A route is what a napp (the caller) chose in the
// picker and asked to keep: the napp that takes the action, and the window it
// goes to when a window was chosen (absent: a new window every time). A
// default is the napp set in settings for an action, for every caller without
// a route. Both are local, like the window layout.

const ROUTES_KEY = "nostrapps:action-routes"
const DEFAULTS_KEY = "nostrapps:action-defaults"

export type Route = {
  nappId: string
  // The chosen window. Gone, the next dispatch opens a new one and keeps that.
  instanceId?: string
  // Chosen for an auxiliary call: those only consider auxiliary apps.
  auxiliary?: boolean
}

// caller → action → route
type Routes = Record<string, Record<string, Route>>
// action → nappId
type Defaults = Record<string, string>

// The launcher input and links are one caller.
export function callerKey(callerNappId: string): string {
  return callerNappId === "link" ? "launcher" : callerNappId
}

function readJSON<T extends object>(key: string): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "{}")
    return raw && typeof raw === "object" ? raw : ({} as T)
  } catch {
    return {} as T
  }
}

function writeJSON(key: string, value: object) {
  if (Object.keys(value).length) localStorage.setItem(key, JSON.stringify(value))
  else localStorage.removeItem(key)
}

const readRoutes = () => readJSON<Routes>(ROUTES_KEY)
const readDefaults = () => readJSON<Defaults>(DEFAULTS_KEY)

// ─── routes ──────────────────────────────────────────────────────

export function getRoute(caller: string, action: string): Route | undefined {
  const r = readRoutes()[callerKey(caller)]?.[action]
  return r && typeof r.nappId === "string" ? r : undefined
}

export function setRoute(caller: string, action: string, route: Route) {
  const all = readRoutes()
  const key = callerKey(caller)
  all[key] ??= {}
  const r: Route = { nappId: route.nappId }
  if (route.instanceId) r.instanceId = route.instanceId
  if (route.auxiliary) r.auxiliary = true
  all[key][action] = r
  writeJSON(ROUTES_KEY, all)
  notify()
}

export function forgetRoute(caller: string, action?: string) {
  const all = readRoutes()
  const key = callerKey(caller)
  if (!all[key]) return
  if (action) {
    delete all[key][action]
    if (Object.keys(all[key]).length === 0) delete all[key]
  } else {
    delete all[key]
  }
  writeJSON(ROUTES_KEY, all)
  notify()
}

// Drop every route at once (settings' "forget all"). One write, one notify.
export function forgetAllRoutes() {
  if (Object.keys(readRoutes()).length === 0) return
  writeJSON(ROUTES_KEY, {})
  notify()
}

export function listRoutes(): Routes {
  return readRoutes()
}

// Routes to a napp that's gone, dropped together (an uninstall).
export function forgetRoutesTo(nappId: string) {
  const all = readRoutes()
  let changed = false
  for (const [caller, actions] of Object.entries(all)) {
    for (const [action, r] of Object.entries(actions)) {
      if (r.nappId !== nappId) continue
      delete actions[action]
      changed = true
    }
    if (Object.keys(actions).length === 0) delete all[caller]
  }
  if (!changed) return
  writeJSON(ROUTES_KEY, all)
  notify()
}

// ─── defaults ────────────────────────────────────────────────────

// The default for an action; a view:<kind> without one falls back to the
// generic "view" default, as the handler lookup does with the handlers.
export function getDefault(action: string): string | undefined {
  const all = readDefaults()
  return all[action] ?? (action.startsWith("view:") ? all["view"] : undefined)
}

export function listDefaults(): Defaults {
  return readDefaults()
}

export function setDefault(action: string, nappId: string | null) {
  const all = readDefaults()
  if (nappId) all[action] = nappId
  else delete all[action]
  writeJSON(DEFAULTS_KEY, all)
  notify()
}

export function forgetDefaultsTo(nappId: string) {
  const all = readDefaults()
  const keep = Object.fromEntries(Object.entries(all).filter(([, id]) => id !== nappId))
  if (Object.keys(keep).length === Object.keys(all).length) return
  writeJSON(DEFAULTS_KEY, keep)
  notify()
}

// ─── subscribers (settings refreshes) ────────────────────────────

const subs = new Set<() => void>()

function notify() {
  for (const fn of subs) {
    try {
      fn()
    } catch {}
  }
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}
