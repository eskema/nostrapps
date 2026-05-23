import { NostrEvent } from "@nostr/tools"
import { NappWindowState } from "./types"

const OPEN_KEY = "nostrapps:open"
const HISTORY_KEY = "nostrapps:history"
const KNOWN_KEY = "nostrapps:known"
const PETNAMES_KEY = "nostrapps:petnames"
const INSTALL_LOG_KEY = "nostrapps:installLog"
const INSTALLED_KEY = "nostrapps:installed"
const HANDLER_PREFS_KEY = "nostrapps:handlerPrefs" // { '<caller>|<type>|<key>': nappId }
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

export function readKnown() {
  return readJson(KNOWN_KEY, [])
}

export function rememberKnown(nappId: string) {
  const prev = readKnown().filter((n: string) => n !== nappId)
  prev.unshift(nappId)
  writeJson(KNOWN_KEY, prev.slice(0, 100))
  // Also append to the permanent install log (never pruned by uninstall),
  // so the store can show "ever installed" history.
  const log = readInstallLog()
  if (!log.includes(nappId)) {
    log.push(nappId)
    writeJson(INSTALL_LOG_KEY, log)
  }
}

export function readInstallLog() {
  const raw = readJson(INSTALL_LOG_KEY, [])
  return Array.isArray(raw) ? raw : []
}

export function computeNappId(event: { kind: number; pubkey: string; tags: string[][] }): string {
  const dTag = event.tags.find(t => t[0] === "d")?.[1]
  if (event.kind === 35128 && dTag) return `${event.pubkey.slice(0, 40)}-${dTag}`
  return event.pubkey.slice(0, 40)
}

// Full events keyed by event.id, used to detect updates and re-fetch.
function readInstalled() {
  const raw = readJson(INSTALLED_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

export function storeInstalledEvent(event: { id: string }) {
  if (!event?.id) return
  const all = readInstalled()
  all[event.id] = event
  writeJson(INSTALLED_KEY, all)
}

export function getInstalledEvent(eventId: string) {
  return readInstalled()[eventId] || null
}

export function getInstalledEvents(): any[] {
  return Object.values(readInstalled())
}

export function forgetInstalledEvent(eventId: string) {
  const all = readInstalled()
  if (eventId in all) {
    delete all[eventId]
    writeJson(INSTALLED_KEY, all)
  }
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
  for (const event of getInstalledEvents()) {
    if (computeNappId(event) === nappId) return event
  }
  return null
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

export function forgetKnown(nappId: string) {
  writeJson(
    KNOWN_KEY,
    readKnown().filter((n: string) => n !== nappId)
  )
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
