const OPEN_KEY = "nostrapps:open"
const HISTORY_KEY = "nostrapps:history"
const KNOWN_KEY = "nostrapps:known"
const PETNAMES_KEY = "nostrapps:petnames"
const INSTALL_LOG_KEY = "nostrapps:installLog"
const INSTALLED_MANIFESTS_KEY = "nostrapps:installedManifests"
const HANDLERS_KEY = "nostrapps:handlers" // { nappId: string[] }
const HANDLER_PREFS_KEY = "nostrapps:handlerPrefs" // { '<caller>|<type>|<key>': nappId }
const HISTORY_LIMIT = 20

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function readOpen() {
  const raw = readJson(OPEN_KEY, [])
  if (!Array.isArray(raw)) {
    writeOpen([])
    return []
  }
  const byId = new Map()
  let dirty = false
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || !entry.instanceId) {
      dirty = true
      continue
    }
    if (byId.has(entry.instanceId)) dirty = true
    byId.set(entry.instanceId, entry)
  }
  const clean = [...byId.values()]
  if (dirty) writeOpen(clean)
  return clean
}

export function writeOpen(napps) {
  writeJson(OPEN_KEY, napps)
}

export function updateOpen(instanceId, state) {
  const all = readOpen()
  const idx = all.findIndex(n => n.instanceId === instanceId)
  if (idx >= 0) {
    if (state) {
      all[idx] = { ...all[idx], ...state }
    } else {
      all.splice(idx, 1)
    }
  } else if (state) {
    all.push(state)
  }
  writeOpen(all)
}

export function removeOpen(instanceId) {
  writeOpen(readOpen().filter(n => n.instanceId !== instanceId))
}

export function setOpenClosed(instanceId, closed) {
  const all = readOpen()
  const entry = all.find(n => n.instanceId === instanceId)
  if (!entry) return
  entry.closed = closed
  writeOpen(all)
}

export function readActiveSessions() {
  return readOpen().filter(n => !n.closed)
}

export function findSessionByPetname(petname) {
  const all = readOpen()
  return all.find(n => !n.system && n.petname === petname) ?? null
}

export function readHistory() {
  return readJson(HISTORY_KEY, [])
}

export function pushHistory(entry) {
  const prev = readHistory().filter(e => e !== entry)
  prev.unshift(entry)
  writeJson(HISTORY_KEY, prev.slice(0, HISTORY_LIMIT))
}

export function forgetHistory(value) {
  writeJson(
    HISTORY_KEY,
    readHistory().filter(e => e !== value)
  )
}

export function readKnown() {
  return readJson(KNOWN_KEY, [])
}

export function rememberKnown(nappId) {
  const prev = readKnown().filter(n => n !== nappId)
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

export function getInstalledManifest(nappId) {
  return readInstalledManifests()[nappId] || null
}

export function setInstalledManifest(nappId, info) {
  if (!nappId || !info) return
  const all = readInstalledManifests()
  all[nappId] = info
  writeJson(INSTALLED_MANIFESTS_KEY, all)
}

export function forgetInstalledManifest(nappId) {
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

export function setHandlers(nappId, actions) {
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

export function forgetHandlers(nappId) {
  const all = readHandlers()
  if (nappId in all) {
    delete all[nappId]
    writeJson(HANDLERS_KEY, all)
  }
}

export function findHandlersForAction(action) {
  if (typeof action !== "string" || !action) return []
  const all = readHandlers()
  const out = []
  for (const [nappId, actions] of Object.entries(all)) {
    if (Array.isArray(actions) && actions.includes(action)) out.push(nappId)
  }
  return out
}

export function getHandlers(nappId) {
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

function prefKey(callerNappId, type, key) {
  return `${callerNappId || "*"}|${type}|${key}`
}

export function getHandlerPref(callerNappId, type, key) {
  return readHandlerPrefs()[prefKey(callerNappId, type, key)] ?? null
}

export function setHandlerPref(callerNappId, type, key, nappId) {
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

export function forgetKnown(nappId) {
  writeJson(
    KNOWN_KEY,
    readKnown().filter(n => n !== nappId)
  )
}

export function readPetnames() {
  const raw = readJson(PETNAMES_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

export function setPetname(petname, nappId) {
  if (!petname || !nappId) return
  const all = readPetnames()
  all[petname] = nappId
  writeJson(PETNAMES_KEY, all)
}

export function forgetPetnamesForNapp(nappId) {
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

export function getNappIdForPetname(petname) {
  return readPetnames()[petname] ?? null
}
