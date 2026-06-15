import { NostrEvent } from "@nostr/tools"
import { InstalledApp, NappWindowState, SpaceData, SpacesState } from "./types"

const INSTALLED_KEY = "nostrapps:installed"
const SPACES_KEY = "nostrapps:spaces"
// Legacy keys — read once to migrate into the spaces document, then removed.
const LEGACY_OPEN_KEY = "nostrapps:open"
const LEGACY_PACK_MODE_KEY = "nostrapps:packMode"

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

// ─── Open windows: a view onto the current space ────────────────
// Window state lives in the spaces document (nostrapps:spaces). The "current
// space's open windows" is just spaces.list[current].open, and readOpen() is a
// view onto it — so the whole app keeps calling readOpen()/updateOpen() while
// the spaces document stays the single source of truth. Ephemeral dev~/temp~
// windows can't be restored, so they're kept in memory only, per space.
const devOpenBySpace = new Map<string, NappWindowState[]>()

function isEphemeralNappId(nappId: string): boolean {
  return nappId.startsWith("dev~") || nappId.startsWith("temp~")
}

function ephemeralFor(spaceId: string): NappWindowState[] {
  let arr = devOpenBySpace.get(spaceId)
  if (!arr) {
    arr = []
    devOpenBySpace.set(spaceId, arr)
  }
  return arr
}

function currentSpace(state: SpacesState): SpaceData {
  return state.list.find(s => s.id === state.current) ?? state.list[0]
}

export function readOpen(): NappWindowState[] {
  const state = ensureSpaces()
  return [...currentSpace(state).open, ...ephemeralFor(state.current)]
}

export function writeOpen(napps: NappWindowState[]) {
  const state = ensureSpaces()
  const sp = currentSpace(state)
  const stored: NappWindowState[] = []
  const eph: NappWindowState[] = []
  for (const n of napps) (isEphemeralNappId(n.nappId) ? eph : stored).push(n)
  sp.open = stored
  devOpenBySpace.set(state.current, eph)
  writeJson(SPACES_KEY, state)
}

// Update a window's state wherever it lives — any space, or ephemeral. A
// brand-new window with no home yet lands in the current space. Space-agnostic
// so a hidden background-space window updates its own space, never the current.
export function updateOpen(instanceId: string, state: NappWindowState) {
  for (const arr of devOpenBySpace.values()) {
    const i = arr.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      arr[i] = { ...arr[i], ...state }
      return
    }
  }
  if (isEphemeralNappId(state.nappId)) {
    ephemeralFor(ensureSpaces().current).push(state)
    return
  }
  const spaces = ensureSpaces()
  for (const sp of spaces.list) {
    const i = sp.open.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      sp.open[i] = { ...sp.open[i], ...state }
      writeJson(SPACES_KEY, spaces)
      return
    }
  }
  currentSpace(spaces).open.push(state)
  writeJson(SPACES_KEY, spaces)
}

// Remove a window wherever it lives — any space, or ephemeral.
export function removeOpen(instanceId: string) {
  for (const arr of devOpenBySpace.values()) {
    const i = arr.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      arr.splice(i, 1)
      return
    }
  }
  const spaces = ensureSpaces()
  let changed = false
  for (const sp of spaces.list) {
    const next = sp.open.filter(n => n.instanceId !== instanceId)
    if (next.length !== sp.open.length) {
      sp.open = next
      changed = true
    }
  }
  if (changed) writeJson(SPACES_KEY, spaces)
}

export function getLoadedActions(instanceId: string): Array<{ name: string; payload: unknown }> {
  return readOpen().find(n => n.instanceId === instanceId)?.loadedActions || []
}

// ─── Spaces (the single source of truth for window state) ──────────
// nostrapps:spaces = { current, list: SpaceData[] }. Each space holds its live
// `open` set and a committed `saved` snapshot. The legacy single nostrapps:open
// is folded into the document on first read and then removed.

function readSpacesRaw(): SpacesState | null {
  const v = readJson(SPACES_KEY, null)
  if (v && typeof v.current === "string" && Array.isArray(v.list) && v.list.length) {
    // Back-fill fields added later so older saved data keeps working.
    for (const sp of v.list) {
      if (!Array.isArray(sp.saved)) sp.saved = sp.open ?? []
      if (typeof sp.savedPackMode !== "boolean") sp.savedPackMode = !!sp.packMode
    }
    return v
  }
  return null
}

// One-time: fold leftover legacy keys (the old live current-space window set +
// pack-mode, which may be fresher than the document) into the current space.
function migrateLegacyOpen(state: SpacesState) {
  const rawOpen = localStorage.getItem(LEGACY_OPEN_KEY)
  const rawPack = localStorage.getItem(LEGACY_PACK_MODE_KEY)
  if (rawOpen == null && rawPack == null) return
  const cur = currentSpace(state)
  if (rawOpen != null) {
    try {
      const legacy = JSON.parse(rawOpen)
      if (Array.isArray(legacy)) cur.open = legacy
    } catch {}
    localStorage.removeItem(LEGACY_OPEN_KEY)
  }
  if (rawPack != null) {
    cur.packMode = rawPack === "1"
    localStorage.removeItem(LEGACY_PACK_MODE_KEY)
  }
  writeJson(SPACES_KEY, state)
}

function ensureSpaces(): SpacesState {
  const existing = readSpacesRaw()
  if (existing) {
    migrateLegacyOpen(existing)
    return existing
  }
  // Fresh install (or pre-spaces user): seed a default space from any legacy open.
  const open = readJson(LEGACY_OPEN_KEY, [])
  const packMode = localStorage.getItem(LEGACY_PACK_MODE_KEY) === "1"
  const def: SpaceData = {
    id: "default",
    name: "default",
    open,
    saved: open,
    packMode,
    savedPackMode: packMode
  }
  const state: SpacesState = { current: "default", list: [def] }
  writeJson(SPACES_KEY, state)
  localStorage.removeItem(LEGACY_OPEN_KEY)
  localStorage.removeItem(LEGACY_PACK_MODE_KEY)
  return state
}

export function getCurrentSpaceId(): string {
  return ensureSpaces().current
}

export function listSpaces(): Array<{ id: string; name: string }> {
  return ensureSpaces().list.map(s => ({ id: s.id, name: s.name }))
}

export function getSpaceOpen(id: string): NappWindowState[] {
  return ensureSpaces().list.find(s => s.id === id)?.open ?? []
}

export function getSpacePackMode(id: string): boolean {
  return ensureSpaces().list.find(s => s.id === id)?.packMode ?? false
}

export function setSpacePackMode(id: string, on: boolean) {
  const state = ensureSpaces()
  const sp = state.list.find(s => s.id === id)
  if (!sp) return
  sp.packMode = on
  writeJson(SPACES_KEY, state)
}

// Every open window across all spaces, tagged with its space — for the global
// window switcher. The current space includes its in-memory ephemeral windows.
export function allOpenWindows(): Array<{
  spaceId: string
  spaceName: string
  window: NappWindowState
}> {
  const state = ensureSpaces()
  const out: Array<{ spaceId: string; spaceName: string; window: NappWindowState }> = []
  for (const sp of state.list) {
    const eph = sp.id === state.current ? ephemeralFor(state.current) : []
    for (const w of [...sp.open, ...eph]) {
      out.push({ spaceId: sp.id, spaceName: sp.name, window: w })
    }
  }
  return out
}

export function setCurrentSpaceId(id: string) {
  const state = ensureSpaces()
  if (!state.list.some(s => s.id === id)) return
  state.current = id
  writeJson(SPACES_KEY, state)
}

let spaceSerial = 0
export function createSpace(name?: string): string {
  const state = ensureSpaces()
  const id = "space" + spaceSerial++
  state.list.push({
    id,
    name: name?.trim() || `space ${state.list.length + 1}`,
    open: [],
    saved: [],
    packMode: false,
    savedPackMode: false
  })
  writeJson(SPACES_KEY, state)
  return id
}

// Commit this space's current live layout as its saved snapshot (Save action).
export function commitSpaceSaved(id: string) {
  const state = ensureSpaces()
  const sp = state.list.find(s => s.id === id)
  if (!sp) return
  sp.saved = [...sp.open]
  sp.savedPackMode = sp.packMode
  writeJson(SPACES_KEY, state)
}

// Reorder the spaces list to match the given id order (drag-to-reorder). Any
// space missing from the list is kept, appended in its existing order.
export function setSpacesOrder(orderedIds: string[]) {
  const state = ensureSpaces()
  const byId = new Map(state.list.map(s => [s.id, s]))
  const next: SpaceData[] = []
  for (const id of orderedIds) {
    const sp = byId.get(id)
    if (sp) {
      next.push(sp)
      byId.delete(id)
    }
  }
  for (const sp of byId.values()) next.push(sp)
  state.list = next
  writeJson(SPACES_KEY, state)
}

// The saved snapshot to revert to (the "Reset" action).
export function getSpaceSaved(id: string): { open: NappWindowState[]; packMode: boolean } {
  const sp = ensureSpaces().list.find(s => s.id === id)
  return { open: sp?.saved ?? [], packMode: sp?.savedPackMode ?? false }
}

export function renameSpace(id: string, name: string) {
  const state = ensureSpaces()
  const sp = state.list.find(s => s.id === id)
  if (!sp) return
  sp.name = name.trim() || sp.name
  writeJson(SPACES_KEY, state)
}

export function deleteSpace(id: string) {
  const state = ensureSpaces()
  if (state.list.length <= 1) return // keep at least one space
  state.list = state.list.filter(s => s.id !== id)
  if (state.current === id) state.current = state.list[0].id
  writeJson(SPACES_KEY, state)
}

// The space whose window set holds this system napp (single-placement),
// preferring the current space. Null if no space has it. Used to navigate a
// top-level invocation to the system napp's home space.
export function findSpaceOfSystemNapp(systemId: string): string | null {
  const state = ensureSpaces()
  let fallback: string | null = null
  for (const sp of state.list) {
    if (sp.open.some(o => o.system && o.systemId === systemId)) {
      if (sp.id === state.current) return sp.id
      if (!fallback) fallback = sp.id
    }
  }
  return fallback
}

export function appendLoadedAction(instanceId: string, name: string, payload: unknown) {
  const withAction = (entry: NappWindowState): NappWindowState => {
    const current = Array.isArray(entry.loadedActions) ? entry.loadedActions : []
    return { ...entry, loadedActions: [...current, { name, payload }] }
  }
  for (const arr of devOpenBySpace.values()) {
    const i = arr.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      arr[i] = withAction(arr[i])
      return
    }
  }
  const spaces = ensureSpaces()
  for (const sp of spaces.list) {
    const i = sp.open.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      sp.open[i] = withAction(sp.open[i])
      writeJson(SPACES_KEY, spaces)
      return
    }
  }
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

function readInstalled(): Record<string, Omit<InstalledApp, "nappId">> {
  return readJson(INSTALLED_KEY, {})
}

export function storeInstalledEvent(event: NostrEvent, petname?: string) {
  if (!event?.id) return
  const all = readInstalled()
  const nappId = computeNappId(event)
  const existing = all[nappId]

  const title = event.tags.find(t => t[0] === "title")?.[1] || ""
  all[nappId] = {
    icon: event.tags.find(t => t[0] === "icon")?.[1] || "",
    title,
    petname: petname || existing?.petname || title || nappId,
    singleton: event.tags.some(t => t[0] === "singleton"),
    actions: event.tags.filter(t => t[0] === "action" && t[1]).map(t => t[1]),
    event
  }
  writeInstalled(all)
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
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    actions: app.actions || [],
    singleton: !!app.singleton,
    installedAt: all[app.nappId]?.installedAt || Math.floor(Date.now() / 1000)
  }
  writeInstalled(all)
}

export function getInstalledNappIds(): string[] {
  const ids = Object.keys(readInstalled())
  for (const nappId of devApps.keys()) {
    if (!ids.includes(nappId)) ids.push(nappId)
  }
  return ids
}

export function getInstalledApp(nappId: string): InstalledApp | undefined {
  const app = readInstalled()[nappId]
  if (app) return { nappId, ...app }

  const dev = devApps.get(nappId)
  if (dev) return { nappId, ...dev }
}

export function getInstalledApps(): InstalledApp[] {
  const apps: InstalledApp[] = []

  const installed = readInstalled()
  for (const nappId in installed) {
    const app = installed[nappId]
    apps.push({ nappId, ...app })
  }

  for (const [nappId, dev] of devApps) {
    apps.push({ nappId, ...dev })
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
    writeInstalled(all)
  }
  devApps.delete(nappId)
}

export function getInstalledEventForNappId(nappId: string): NostrEvent | null {
  return readInstalled()[nappId]?.event || null
}

export function setInstalledPetname(nappId: string, petname: string) {
  if (!nappId || !petname) return

  const all = readInstalled()
  if (!all[nappId]) return

  all[nappId].petname = petname
  writeInstalled(all)
}

export function getNappIdForPetname(petname: string) {
  if (!petname) return null
  const app = getInstalledApps().find(app => app.petname === petname)
  return app?.nappId || null
}

// ─── Dev apps (in-memory only) ──────────────────────────

export interface DevAppData {
  title: string
  icon: string
  petname: string
  singleton: boolean
  actions: string[]
  installedAt: number
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
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    singleton: !!app.singleton,
    actions: app.actions || [],
    installedAt: devApps.get(app.nappId)?.installedAt || Math.floor(Date.now() / 1000)
  })
}
