import { NostrEvent } from "@nostr/tools"
import { NappWindowState } from "./types"

const OPEN_KEY = "nostrapps:open"
const HISTORY_KEY = "nostrapps:history"
const PETNAMES_KEY = "nostrapps:petnames"
const INSTALLED_KEY = "nostrapps:installed"
const HANDLER_PREFS_KEY = "nostrapps:handlerPrefs" // { '<caller>|<type>|<key>': nappId }
const LEGACY_KNOWN_KEY = "nostrapps:known"
const LEGACY_INSTALL_LOG_KEY = "nostrapps:installLog"
const HISTORY_LIMIT = 20

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

export function readOpen(): NappWindowState[] {
  const raw = readJson(OPEN_KEY, [])
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
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

export function findSessionByPetname(petname: string): NappWindowState | null {
  const all = readOpen()
  return all.find(n => !n.system && n.petname === petname) ?? null
}

export function readHistory() {
  return readJson(HISTORY_KEY, [])
}

export function pushHistory(entry: string) {
  const prev = readHistory().filter((e: string) => e !== entry)
  prev.unshift(entry)
  writeJson(HISTORY_KEY, prev.slice(0, HISTORY_LIMIT))
}

export function forgetHistory(value: string) {
  writeJson(
    HISTORY_KEY,
    readHistory().filter((e: string) => e !== value)
  )
}

export function computeNappId(event: { kind: number; pubkey: string; tags: string[][] }): string {
  const dTag = event.tags.find(t => t[0] === "d")?.[1]
  return `${event.pubkey.slice(0, 16)}~${dTag || ""}`
}

export function isSingletonEvent(event: { tags?: string[][] } | null | undefined): boolean {
  if (!event?.tags) return false
  return event.tags.some(t => t[0] === "singleton")
}

// Full events keyed by event.id, used to detect updates and re-fetch.
function readInstalled() {
  dropLegacyInstallKeys()
  const raw = readJson(INSTALLED_KEY, {})
  if (!raw || typeof raw !== "object") return {}
  const normalized: Record<string, NostrEvent> = {}
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== "object") continue
    const event = value as NostrEvent
    if (!event.pubkey || !Array.isArray(event.tags)) continue
    normalized[computeNappId(event)] = event
  }
  return normalized
}

export function storeInstalledEvent(event: NostrEvent) {
  if (!event?.id) return
  const all = readInstalled()
  all[computeNappId(event)] = event
  writeJson(INSTALLED_KEY, all)
}

export function getInstalledNappIds(): string[] {
  return Object.keys(readInstalled())
}

export function getInstalledEvents(): any[] {
  return Object.values(readInstalled())
}

export function forgetInstalledNapp(nappId: string) {
  const all = readInstalled()
  if (nappId in all) {
    delete all[nappId]
    writeJson(INSTALLED_KEY, all)
  }
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
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
