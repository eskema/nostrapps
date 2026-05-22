import { NappWindowState } from "./types"

const OPEN_KEY = "nostrapps:open"
const HISTORY_KEY = "nostrapps:history"
const KNOWN_KEY = "nostrapps:known"
const PETNAMES_KEY = "nostrapps:petnames"
const INSTALL_LOG_KEY = "nostrapps:installLog"
const INSTALLED_MANIFESTS_KEY = "nostrapps:installedManifests"
const HANDLERS_KEY = "nostrapps:handlers" // { nappId: string[] }
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

// Per-nappId info about *which* manifest version is currently installed,
// used to detect when a relay has a newer one and offer an update.
// info shape: { pubkey, kind, dTag?: string|null, eventId, createdAt }
function readInstalledManifests() {
  const raw = readJson(INSTALLED_MANIFESTS_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

export function getInstalledManifest(nappId: string) {
  return readInstalledManifests()[nappId] || null
}

export function setInstalledManifest(nappId: string, info: any) {
  if (!nappId || !info) return
  const all = readInstalledManifests()
  all[nappId] = info
  writeJson(INSTALLED_MANIFESTS_KEY, all)
}

export function forgetInstalledManifest(nappId: string) {
  const all = readInstalledManifests()
  if (nappId in all) {
    delete all[nappId]
    writeJson(INSTALLED_MANIFESTS_KEY, all)
  }
}

// ─── handler registry (actions) ──

function readHandlers() {
  const raw = readJson(HANDLERS_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

export function setHandlers(nappId: string, actions: string[]) {
  if (!nappId) return
  const all = readHandlers()
  const valid = Array.isArray(actions) ? actions.filter(a => typeof a === "string" && a.length) : []
  if (valid.length === 0) {
    delete all[nappId]
  } else {
    all[nappId] = [...new Set(valid)]
  }
  writeJson(HANDLERS_KEY, all)
}

export function forgetHandlers(nappId: string) {
  const all = readHandlers()
  if (nappId in all) {
    delete all[nappId]
    writeJson(HANDLERS_KEY, all)
  }
}

export function findHandlersForAction(action: string) {
  if (typeof action !== "string" || !action) return []
  const all = readHandlers()
  const out = []
  for (const [nappId, actions] of Object.entries(all)) {
    if (Array.isArray(actions) && actions.includes(action)) out.push(nappId)
  }
  return out
}

export function getHandlers(nappId: string) {
  if (typeof nappId !== "string" || !nappId) return []
  const actions = readHandlers()[nappId]
  return Array.isArray(actions) ? actions : []
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
