import { NostrEvent } from "@nostr/tools"
import { InstalledApp, NappWindowState } from "./types"

const OPEN_KEY = "nostrapps:open"
const INSTALLED_KEY = "nostrapps:installed"
const HANDLER_PREFS_KEY = "nostrapps:handlerPrefs" // { '<caller>|<type>|<key>': nappId }

function readJson(key: string, fallback: any): any {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: any) {
  localStorage.setItem(key, JSON.stringify(value))
}

function sanitizeString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// ─── Dev open entries (in-memory only) ──────────────────
const devOpenEntries: NappWindowState[] = []

function isDevNappId(nappId: string): boolean {
  return nappId.startsWith("dev~")
}

function readOpenFromStorage(): NappWindowState[] {
  return readJson(OPEN_KEY, [])
}

function writeOpenToStorage(napps: NappWindowState[]) {
  writeJson(OPEN_KEY, napps)
}

export function readOpen(): NappWindowState[] {
  return [...readOpenFromStorage(), ...devOpenEntries]
}

export function writeOpen(napps: NappWindowState[]) {
  const stored: NappWindowState[] = []
  devOpenEntries.length = 0
  for (const n of napps) {
    if (isDevNappId(n.nappId)) {
      devOpenEntries.push(n)
    } else {
      stored.push(n)
    }
  }
  writeOpenToStorage(stored)
}

export function updateOpen(instanceId: string, state: NappWindowState) {
  // Check dev entries first
  const devIdx = devOpenEntries.findIndex(n => n.instanceId === instanceId)
  if (devIdx >= 0) {
    devOpenEntries[devIdx] = { ...devOpenEntries[devIdx], ...state }
    return
  }
  // Check if this is a dev nappId — if so, add to in-memory
  if (isDevNappId(state.nappId)) {
    devOpenEntries.push(state)
    return
  }
  // Otherwise use localStorage
  const stored = readOpenFromStorage()
  const idx = stored.findIndex(n => n.instanceId === instanceId)
  if (idx >= 0) {
    stored[idx] = { ...stored[idx], ...state }
  } else {
    stored.push(state)
  }
  writeOpenToStorage(stored)
}

export function removeOpen(instanceId: string) {
  const devIdx = devOpenEntries.findIndex(n => n.instanceId === instanceId)
  if (devIdx >= 0) {
    devOpenEntries.splice(devIdx, 1)
    return
  }
  writeOpenToStorage(readOpenFromStorage().filter(n => n.instanceId !== instanceId))
}

export function getLoadedActions(instanceId: string): Array<{ name: string; payload: unknown }> {
  return readOpen().find(n => n.instanceId === instanceId)?.loadedActions || []
}

export function appendLoadedAction(instanceId: string, name: string, payload: unknown) {
  // Check dev entries
  const devIdx = devOpenEntries.findIndex(n => n.instanceId === instanceId)
  if (devIdx >= 0) {
    const current = Array.isArray(devOpenEntries[devIdx].loadedActions)
      ? devOpenEntries[devIdx].loadedActions
      : []
    devOpenEntries[devIdx] = {
      ...devOpenEntries[devIdx],
      loadedActions: [...current, { name, payload }]
    }
    return
  }
  // Otherwise use localStorage
  const stored = readOpenFromStorage()
  const idx = stored.findIndex(n => n.instanceId === instanceId)
  if (idx < 0) return
  const current = Array.isArray(stored[idx].loadedActions) ? stored[idx].loadedActions : []
  stored[idx] = {
    ...stored[idx],
    loadedActions: [...current, { name, payload }]
  }
  writeOpenToStorage(stored)
}

export function findSessionByPetname(petname: string): NappWindowState | null {
  const all = readOpen()
  return all.find(n => !n.system && n.petname === petname) ?? null
}

export function computeNappId(event: { kind: number; pubkey: string; tags: string[][] }): string {
  const source = event.tags.find(t => t[0] === "source")?.[1]
  if (source === "local") {
    const dTag = event.tags.find(t => t[0] === "d")?.[1]
    return `local-${dTag || ""}`
  }
  const dTag = event.tags.find(t => t[0] === "d")?.[1]
  return `${event.pubkey.slice(0, 16)}~${dTag || ""}`
}

function writeInstalled(all: Record<string, Omit<InstalledApp, "nappId">>) {
  writeJson(INSTALLED_KEY, all)
}

function readInstalled(): Record<string, InstalledApp> {
  return readJson(INSTALLED_KEY, {})
}

export function storeInstalledEvent(event: NostrEvent, petname?: string) {
  if (!event?.id) return
  const all = readInstalled()
  const nappId = computeNappId(event)
  const existing = all[nappId]

  const title = event.tags.find(t => t[0] === "title")?.[1] || ""
  all[nappId] = {
    nappId,
    icon: event.tags.find(t => t[0] === "icon")?.[1] || "",
    title,
    petname: petname || existing?.petname || title || nappId,
    singleton: event.tags.some(t => t[0] === "singleton"),
    actions: event.tags.filter(t => t[0] === "action" && t[1]).map(t => t[1]),
    event
  }
  writeInstalled(
    Object.fromEntries(Object.entries(all).map(([id, entry]) => [id, stripNappId(entry)]))
  )
}

export function storeInstalledLocalApp(app: {
  nappId: string
  title?: string | null
  icon?: string | null
  petname?: string | null
  singleton?: boolean
  actions?: string[]
}) {
  if (!app?.nappId) return
  const all = readInstalled()

  all[app.nappId] = {
    nappId: app.nappId,
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    actions: app.actions || [],
    singleton: !!app.singleton
  }
  writeInstalled(
    Object.fromEntries(Object.entries(all).map(([id, entry]) => [id, stripNappId(entry)]))
  )
}

export function getInstalledNappIds(): string[] {
  const ids = Object.keys(readInstalled())
  for (const nappId of devApps.keys()) {
    if (!ids.includes(nappId)) ids.push(nappId)
  }
  return ids
}

export function getInstalledApps(): InstalledApp[] {
  const apps = Object.values(readInstalled())
  for (const dev of devApps.values()) {
    apps.push({
      nappId: dev.nappId,
      icon: dev.icon,
      title: dev.title,
      petname: dev.petname,
      singleton: dev.singleton,
      actions: dev.actions
    })
  }
  return apps
}

export function getInstalledEvents(): NostrEvent[] {
  return getInstalledApps()
    .map(app => app.event)
    .filter((event): event is NostrEvent => !!event)
}

export function forgetInstalledNapp(nappId: string) {
  const all = readInstalled()
  if (nappId in all) {
    delete all[nappId]
    writeInstalled(
      Object.fromEntries(Object.entries(all).map(([id, entry]) => [id, stripNappId(entry)]))
    )
  }
  forgetDevApp(nappId)
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
  return readInstalled()[nappId]?.event || null
}

export function getInstalledAppForNappId(nappId: string): InstalledApp | null {
  const fromStorage = readInstalled()[nappId]
  if (fromStorage) return fromStorage
  const dev = devApps.get(nappId)
  if (dev) {
    return {
      nappId: dev.nappId,
      icon: dev.icon,
      title: dev.title,
      petname: dev.petname,
      singleton: dev.singleton,
      actions: dev.actions
    }
  }
  return null
}

export function setInstalledPetname(nappId: string, petname: string) {
  if (!nappId || !petname) return

  const all = readInstalled()
  if (!all[nappId]) return

  all[nappId].petname = petname
  writeInstalled(
    Object.fromEntries(Object.entries(all).map(([id, value]) => [id, stripNappId(value)]))
  )
}

// "I last picked nappId X to handle <action 'edit:30023'> from <caller Y>".
// The caller pin makes prefs scoped, so picking an editor for napp A doesn't
// automatically apply when napp B asks for the same action.

function readHandlerPrefs() {
  const raw = readJson(HANDLER_PREFS_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

function prefKey(callerNappId: string | null, type: string, key: string) {
  return `${callerNappId || "*"}|${type}|${key}`
}

export function getHandlerPref(callerNappId: string | null, type: string, key: string) {
  return readHandlerPrefs()[prefKey(callerNappId, type, key)] ?? null
}

export function setHandlerPref(
  callerNappId: string | null,
  type: string,
  key: string,
  nappId: string | null
) {
  const all = readHandlerPrefs()
  const k = prefKey(callerNappId, type, key)
  if (nappId) all[k] = nappId
  else delete all[k]
  writeJson(HANDLER_PREFS_KEY, all)
}

export function readHandlerPrefsAll() {
  return readHandlerPrefs()
}

export function clearHandlerPrefs() {
  writeJson(HANDLER_PREFS_KEY, {})
}

export function getNappIdForPetname(petname: string) {
  if (!petname) return null
  const app = getInstalledApps().find(app => app.petname === petname)
  return app?.nappId || null
}

function stripNappId(app: InstalledApp): Omit<InstalledApp, "nappId"> {
  const { nappId: _nappId, ...entry } = app
  return entry
}

// ─── Dev apps (in-memory only) ──────────────────────────

export interface DevAppData {
  nappId: string
  title: string
  icon: string
  petname: string
  singleton: boolean
  actions: string[]
}

const devApps = new Map<string, DevAppData>()

export function storeDevApp(app: {
  nappId: string
  title?: string | null
  icon?: string | null
  petname?: string | null
  singleton?: boolean
  actions?: string[]
}) {
  if (!app?.nappId) return
  devApps.set(app.nappId, {
    nappId: app.nappId,
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    singleton: !!app.singleton,
    actions: app.actions || []
  })
}

export function forgetDevApp(nappId: string) {
  devApps.delete(nappId)
}
