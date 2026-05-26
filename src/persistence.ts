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

export function readOpen(): NappWindowState[] {
  return readJson(OPEN_KEY, [])
}

export function writeOpen(napps: NappWindowState[]) {
  writeJson(OPEN_KEY, napps)
}

export function updateOpen(instanceId: string, state: NappWindowState) {
  const all = readOpen()
  const idx = all.findIndex(n => n.instanceId === instanceId)
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...state }
  } else {
    all.push(state)
  }
  writeOpen(all)
}

export function removeOpen(instanceId: string) {
  writeOpen(readOpen().filter(n => n.instanceId !== instanceId))
}

export function getLoadedActions(instanceId: string): Array<{ name: string; payload: unknown }> {
  return readOpen().find(n => n.instanceId === instanceId)?.loadedActions || []
}

export function appendLoadedAction(instanceId: string, name: string, payload: unknown) {
  const all = readOpen()
  const idx = all.findIndex(n => n.instanceId === instanceId)
  if (idx < 0) return
  const current = Array.isArray(all[idx].loadedActions) ? all[idx].loadedActions : []
  all[idx] = {
    ...all[idx],
    loadedActions: [...current, { name, payload }]
  }
  writeOpen(all)
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
  return Object.keys(readInstalled())
}

export function getInstalledApps(): InstalledApp[] {
  return Object.values(readInstalled())
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
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
  return readInstalled()[nappId]?.event || null
}

export function getInstalledAppForNappId(nappId: string): InstalledApp | null {
  return readInstalled()[nappId] || null
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
