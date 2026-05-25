import { NostrEvent } from "@nostr/tools"
import { NappWindowState } from "./types"

export type LocalInstalledApp = {
  local: true
  nappId: string
  title: string | null
  icon: string | null
  actions: string[]
  created_at: number
}

export type InstalledApp = NostrEvent | LocalInstalledApp

const OPEN_KEY = "nostrapps:open"
const PETNAMES_KEY = "nostrapps:petnames"
const INSTALLED_KEY = "nostrapps:installed"
const HANDLER_PREFS_KEY = "nostrapps:handlerPrefs" // { '<caller>|<type>|<key>': nappId }
const LEGACY_KNOWN_KEY = "nostrapps:known"
const LEGACY_INSTALL_LOG_KEY = "nostrapps:installLog"

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

function dropLegacyInstallKeys() {
  localStorage.removeItem(LEGACY_KNOWN_KEY)
  localStorage.removeItem(LEGACY_INSTALL_LOG_KEY)
}

function dropLegacyLoadedKey() {
  localStorage.removeItem("nostrapps:loaded")
}

export function readOpen(): NappWindowState[] {
  dropLegacyLoadedKey()
  const raw = readJson(OPEN_KEY, [])
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.map((entry: any) => ({
    ...entry,
    loadedActions: Array.isArray(entry?.loadedActions) ? entry.loadedActions : []
  }))
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

export function isSingletonEvent(event: { tags?: string[][] } | null | undefined): boolean {
  if (!event?.tags) return false
  return event.tags.some(t => t[0] === "singleton")
}

function isNostrEvent(value: unknown): value is NostrEvent {
  return (
    !!value &&
    typeof value === "object" &&
    !!(value as NostrEvent).pubkey &&
    Array.isArray((value as NostrEvent).tags)
  )
}

function isLocalInstalledApp(value: unknown): value is LocalInstalledApp {
  return (
    !!value &&
    typeof value === "object" &&
    (value as LocalInstalledApp).local === true &&
    typeof (value as LocalInstalledApp).nappId === "string"
  )
}

// Installed apps keyed by nappId. Remote apps store full manifest events.
// Local folder apps store a small launcher-side record instead.
function readInstalled() {
  dropLegacyInstallKeys()
  const raw = readJson(INSTALLED_KEY, {})
  if (!raw || typeof raw !== "object") return {}
  const normalized: Record<string, InstalledApp> = {}
  for (const value of Object.values(raw)) {
    if (isLocalInstalledApp(value)) {
      normalized[value.nappId] = {
        local: true,
        nappId: value.nappId,
        title: typeof value.title === "string" && value.title ? value.title : null,
        icon: typeof value.icon === "string" && value.icon ? value.icon : null,
        actions: Array.isArray(value.actions)
          ? [...new Set(value.actions.filter(a => typeof a === "string" && a))]
          : [],
        created_at:
          typeof value.created_at === "number" && Number.isFinite(value.created_at)
            ? value.created_at
            : Math.floor(Date.now() / 1000)
      }
      continue
    }
    if (!isNostrEvent(value)) continue
    normalized[computeNappId(value)] = value
  }
  return normalized
}

export function storeInstalledEvent(event: NostrEvent) {
  if (!event?.id) return
  const all = readInstalled()
  all[computeNappId(event)] = event
  writeJson(INSTALLED_KEY, all)
}

export function storeInstalledLocalApp(app: {
  nappId: string
  title?: string | null
  icon?: string | null
  actions?: string[]
}) {
  if (!app?.nappId) return
  const all = readInstalled()
  all[app.nappId] = {
    local: true,
    nappId: app.nappId,
    title: typeof app.title === "string" && app.title ? app.title : null,
    icon: typeof app.icon === "string" && app.icon ? app.icon : null,
    actions: Array.isArray(app.actions)
      ? [...new Set(app.actions.filter(a => typeof a === "string" && a))]
      : [],
    created_at: Math.floor(Date.now() / 1000)
  }
  writeJson(INSTALLED_KEY, all)
}

export function getInstalledNappIds(): string[] {
  return Object.keys(readInstalled())
}

export function getInstalledApps(): InstalledApp[] {
  return Object.values(readInstalled())
}

export function getInstalledEvents(): NostrEvent[] {
  return getInstalledApps().filter(isNostrEvent)
}

export function forgetInstalledNapp(nappId: string) {
  const all = readInstalled()
  if (nappId in all) {
    delete all[nappId]
    writeJson(INSTALLED_KEY, all)
  }
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
  const entry = readInstalled()[nappId]
  return isNostrEvent(entry) ? entry : null
}

export function getInstalledAppForNappId(nappId: string): InstalledApp | null {
  return readInstalled()[nappId] || null
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

export function readPetnames() {
  const raw = readJson(PETNAMES_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

export function setPetname(petname: string, nappId: string) {
  if (!petname || !nappId) return
  const all = readPetnames()
  all[petname] = nappId
  writeJson(PETNAMES_KEY, all)
}

export function forgetPetnamesForNapp(nappId: string) {
  const all = readPetnames()
  let changed = false
  for (const [petname, mapped] of Object.entries(all)) {
    if (mapped === nappId) {
      delete all[petname]
      changed = true
    }
  }
  if (changed) writeJson(PETNAMES_KEY, all)
}

export function getNappIdForPetname(petname: string) {
  return readPetnames()[petname] ?? null
}
