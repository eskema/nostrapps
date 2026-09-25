import { NostrEvent } from "@nostr/tools"
import {
  AppType,
  InstalledApp,
  NappInitialSize,
  NappMode,
  NappPolicy,
  NappWindowState,
  SpaceData,
  SpacesState
} from "./types"

const INSTALLED_KEY = "nostrapps:installed"
const SPACES_KEY = "nostrapps:spaces"
// Per-napp security policy (network + granted capability domains). See
// NappPolicy. Keyed by nappId; an absent entry means fully locked.
const POLICY_KEY = "nostrapps:policy"
// Origins of ephemeral napps (dev~/temp~) that have been booted. Everything
// else about them is memory-only and dies with the page — but their ORIGIN data
// (the napp's own IDB/localStorage, its service worker) outlives the launcher,
// and no web API can enumerate another origin's storage. So without a note of
// the id, a reload orphans that data permanently: unreachable by uninstall, by
// factory reset, by anything. This is the minimum written down to make the
// wipe possible, and each id is dropped the moment its origin is cleared.
const EPHEMERAL_KEY = "nostrapps:ephemeral-origins"
// Per-napp window size, remembered from the last deliberate resize.
const WINDOW_SIZE_KEY = "nostrapps:window-sizes"
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

// Whose record is memory-only: dev and temp apps by prefix, and a share
// link's app until it's kept (same id as its install, so by record).
function isEphemeralNappId(nappId: string): boolean {
  return nappId.startsWith("dev~") || nappId.startsWith("temp~") || devApps.has(nappId)
}

function ephemeralFor(spaceId: string): NappWindowState[] {
  let arr = devOpenBySpace.get(spaceId)
  if (!arr) {
    arr = []
    devOpenBySpace.set(spaceId, arr)
  }
  return arr
}

// ─── Ephemeral spaces ───────────────────────────────────────────
// A space opened from a share link lives only in memory: never written to the
// document, its windows memory-only whatever their napp id (an installed app's
// window in it must not persist either), gone on reload — the temp origins it
// booted are swept on the next boot. The document's `current` never points at
// one, so a reload lands on the last real space. Keep (promoteSpace) moves it
// into the document under the same id.
const ephemeralSpaces: SpaceData[] = []
let ephemeralCurrent: string | null = null
let ephemeralSerial = 0

export function isEphemeralSpace(id: string): boolean {
  return ephemeralSpaces.some(s => s.id === id)
}

function allSpaces(state: SpacesState): SpaceData[] {
  return [...state.list, ...ephemeralSpaces]
}

function findSpace(state: SpacesState, id: string): SpaceData | undefined {
  return state.list.find(s => s.id === id) ?? ephemeralSpaces.find(s => s.id === id)
}

function currentId(state: SpacesState): string {
  return ephemeralCurrent ?? state.current
}

function currentSpace(state: SpacesState): SpaceData {
  return findSpace(state, currentId(state)) ?? state.list[0]
}

export function readOpen(): NappWindowState[] {
  const sp = currentSpace(ensureSpaces())
  return [...sp.open, ...ephemeralFor(sp.id)]
}

export function writeOpen(napps: NappWindowState[]) {
  const state = ensureSpaces()
  const sp = currentSpace(state)
  if (isEphemeralSpace(sp.id)) {
    sp.open = [...napps]
    devOpenBySpace.set(sp.id, [])
    return
  }
  const stored: NappWindowState[] = []
  const eph: NappWindowState[] = []
  for (const n of napps) (isEphemeralNappId(n.nappId) ? eph : stored).push(n)
  sp.open = stored
  devOpenBySpace.set(sp.id, eph)
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
  const spaces = ensureSpaces()
  for (const sp of allSpaces(spaces)) {
    const i = sp.open.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      sp.open[i] = { ...sp.open[i], ...state }
      if (!isEphemeralSpace(sp.id)) writeJson(SPACES_KEY, spaces)
      return
    }
  }
  const cur = currentSpace(spaces)
  if (isEphemeralSpace(cur.id)) {
    cur.open.push(state)
    return
  }
  if (isEphemeralNappId(state.nappId)) {
    ephemeralFor(cur.id).push(state)
    return
  }
  cur.open.push(state)
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
  for (const sp of allSpaces(spaces)) {
    const next = sp.open.filter(n => n.instanceId !== instanceId)
    if (next.length !== sp.open.length) {
      sp.open = next
      if (!isEphemeralSpace(sp.id)) changed = true
    }
  }
  if (changed) writeJson(SPACES_KEY, spaces)
}

// Relocate an open window's entry from the current space to another space,
// keeping its state (position, params, …). Handles both persisted windows
// (in the space's `open` list) and ephemeral dev windows (in devOpenBySpace).
export function moveOpenToSpace(instanceId: string, targetId: string) {
  const state = ensureSpaces()
  const cur = currentSpace(state)
  if (targetId === cur.id) return
  const target = findSpace(state, targetId)
  if (!target) return

  // Where it lands: an ephemeral space keeps everything in its own list, a real
  // one keeps dev~/temp~ windows in the memory-only side list.
  const land = (entry: NappWindowState) => {
    if (isEphemeralSpace(targetId) || !isEphemeralNappId(entry.nappId)) target.open.push(entry)
    else ephemeralFor(targetId).push(entry)
  }

  const eph = devOpenBySpace.get(cur.id)
  const ei = eph ? eph.findIndex(n => n.instanceId === instanceId) : -1
  if (eph && ei >= 0) {
    const [entry] = eph.splice(ei, 1)
    land(entry)
    return
  }

  const i = cur.open.findIndex(n => n.instanceId === instanceId)
  if (i === -1) return
  const [entry] = cur.open.splice(i, 1)
  land(entry)
  if (!isEphemeralSpace(cur.id) || !isEphemeralSpace(targetId)) writeJson(SPACES_KEY, state)
}

export function getLoadedActions(instanceId: string): Array<{ name: string; payload: unknown }> {
  return readOpen().find(n => n.instanceId === instanceId)?.loadedActions || []
}

// ─── Remembered window sizes ───────────────────────────────────────
// Resizing a window records that size for its napp, so the next window you
// open for it starts there instead of at the default. Keyed by nappId (system
// windows included, as `__<sysId>__`) and global rather than per-space: the
// size you picked is a property of the napp, not of where it was open.

export function rememberWindowSize(nappId: string, width: number, height?: number) {
  if (!nappId || !Number.isFinite(width) || width <= 0) return
  const size: { width: number; height?: number } = { width: Math.round(width) }
  // A minimized window only commits a width; leave the height off rather than
  // remembering a zero.
  if (Number.isFinite(height) && (height as number) > 0) size.height = Math.round(height as number)
  const all = readJson(WINDOW_SIZE_KEY, {})
  all[nappId] = size
  writeJson(WINDOW_SIZE_KEY, all)
}

export function getWindowSize(nappId: string): { width: number; height?: number } | null {
  const size = readJson(WINDOW_SIZE_KEY, {})[nappId]
  if (!size || typeof size.width !== "number" || size.width <= 0) return null
  const height = typeof size.height === "number" && size.height > 0 ? size.height : undefined
  return { width: size.width, height }
}

export function forgetWindowSize(nappId: string) {
  const all = readJson(WINDOW_SIZE_KEY, {})
  if (!(nappId in all)) return
  delete all[nappId]
  writeJson(WINDOW_SIZE_KEY, all)
}

// ─── Spaces (the single source of truth for window state) ──────────
// nostrapps:spaces = { current, list: SpaceData[] }. Each space holds its live
// `open` set and a committed `saved` snapshot. The legacy single nostrapps:open
// is folded into the document on first read and then removed.

function readSpacesRaw(): SpacesState | null {
  const v = readJson(SPACES_KEY, null)
  if (v && typeof v.current === "string" && Array.isArray(v.list) && v.list.length) {
    // Repair: drop spaces with a duplicate or invalid id (a past id-collision bug
    // could mint them), keeping the first of each id. Duplicate ids break every
    // id-keyed lookup, so heal the document on load and persist the repair.
    const seen = new Set<string>()
    const deduped = v.list.filter((sp: SpaceData) => {
      if (!sp || typeof sp.id !== "string" || seen.has(sp.id)) return false
      seen.add(sp.id)
      return true
    })
    const changed = deduped.length !== v.list.length
    v.list = deduped
    if (!seen.has(v.current)) v.current = v.list[0]?.id
    // Back-fill fields added later so older saved data keeps working.
    for (const sp of v.list) {
      if (!Array.isArray(sp.saved)) sp.saved = sp.open ?? []
      if (typeof sp.savedPackMode !== "boolean") sp.savedPackMode = !!sp.packMode
    }
    if (changed) writeJson(SPACES_KEY, v)
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

// Every space gone, the memory-only ones too. The next read seeds a fresh
// default, as on a first run.
export function clearSpaces() {
  localStorage.removeItem(SPACES_KEY)
  ephemeralSpaces.length = 0
  devOpenBySpace.clear()
}

export function getCurrentSpaceId(): string {
  return currentId(ensureSpaces())
}

// Real spaces first, in document order; ephemeral ones after.
export function listSpaces(): Array<{ id: string; name: string; ephemeral?: boolean }> {
  return [
    ...ensureSpaces().list.map(s => ({ id: s.id, name: s.name })),
    ...ephemeralSpaces.map(s => ({ id: s.id, name: s.name, ephemeral: true }))
  ]
}

export function getSpaceOpen(id: string): NappWindowState[] {
  return findSpace(ensureSpaces(), id)?.open ?? []
}

export function getSpacePackMode(id: string): boolean {
  return findSpace(ensureSpaces(), id)?.packMode ?? false
}

export function setSpacePackMode(id: string, on: boolean) {
  const state = ensureSpaces()
  const sp = findSpace(state, id)
  if (!sp) return
  sp.packMode = on
  if (!isEphemeralSpace(id)) writeJson(SPACES_KEY, state)
}

// Every open window across all spaces, tagged with its space — for the global
// window switcher. The current space includes its in-memory ephemeral windows.
export function allOpenWindows(): Array<{
  spaceId: string
  spaceName: string
  window: NappWindowState
}> {
  const state = ensureSpaces()
  const cur = currentId(state)
  const out: Array<{ spaceId: string; spaceName: string; window: NappWindowState }> = []
  for (const sp of allSpaces(state)) {
    const eph = sp.id === cur ? ephemeralFor(cur) : []
    for (const w of [...sp.open, ...eph]) {
      out.push({ spaceId: sp.id, spaceName: sp.name, window: w })
    }
  }
  return out
}

export function setCurrentSpaceId(id: string) {
  const state = ensureSpaces()
  if (isEphemeralSpace(id)) {
    ephemeralCurrent = id // the document's current stays on the last real space
    return
  }
  if (!state.list.some(s => s.id === id)) return
  ephemeralCurrent = null
  state.current = id
  writeJson(SPACES_KEY, state)
}

export function createEphemeralSpace(name: string): string {
  const state = ensureSpaces()
  // A kept space keeps its "sharedN" id in the document, so skip those too.
  const taken = new Set(allSpaces(state).map(s => s.id))
  let id = "shared" + ephemeralSerial++
  while (taken.has(id)) id = "shared" + ephemeralSerial++
  ephemeralSpaces.push({
    id,
    name: name.trim() || "shared",
    open: [],
    saved: [],
    packMode: false,
    savedPackMode: false
  })
  return id
}

// Keep: move an ephemeral space into the document under the same id, its live
// layout committed as the saved one. Its windows should be real installs by
// now; any dev~/temp~ one left stays memory-only, as in every space.
export function promoteSpace(id: string) {
  const i = ephemeralSpaces.findIndex(s => s.id === id)
  if (i < 0) return
  const state = ensureSpaces()
  const [sp] = ephemeralSpaces.splice(i, 1)
  const stored: NappWindowState[] = []
  const eph: NappWindowState[] = []
  for (const n of sp.open) (isEphemeralNappId(n.nappId) ? eph : stored).push(n)
  sp.open = stored
  sp.saved = [...stored]
  sp.savedPackMode = sp.packMode
  devOpenBySpace.set(id, eph)
  state.list.push(sp)
  if (ephemeralCurrent === id) {
    ephemeralCurrent = null
    state.current = id
  }
  writeJson(SPACES_KEY, state)
}

let spaceSerial = 0
export function createSpace(name?: string): string {
  const state = ensureSpaces()
  // spaceSerial resets to 0 each page load, so a fresh session would otherwise
  // regenerate "space0", "space1", … that collide with spaces persisted in an
  // earlier session. Skip any id already taken — duplicate ids corrupt every
  // id-keyed lookup (current-space, tab reconciliation, reorder…).
  const taken = new Set(allSpaces(state).map(s => s.id))
  let id = "space" + spaceSerial++
  while (taken.has(id)) id = "space" + spaceSerial++
  // Default name is one past the highest existing "space N". Counting the list
  // length instead repeats a number after any delete (delete shrinks the list),
  // which is how two "space 4" can end up side by side.
  const maxN = state.list.reduce((m, s) => {
    const match = /^space (\d+)$/.exec(s.name)
    return match ? Math.max(m, Number(match[1])) : m
  }, 0)
  state.list.push({
    id,
    name: name?.trim() || `space ${maxN + 1}`,
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
  const sp = findSpace(state, id)
  if (!sp) return
  sp.saved = [...sp.open]
  sp.savedPackMode = sp.packMode
  if (!isEphemeralSpace(id)) writeJson(SPACES_KEY, state)
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
  const sp = findSpace(ensureSpaces(), id)
  return { open: sp?.saved ?? [], packMode: sp?.savedPackMode ?? false }
}

// Swap the whole spaces document for another: a restore, which reloads the
// page right after, so nothing live needs telling.
export function replaceSpaces(state: SpacesState) {
  writeJson(SPACES_KEY, state)
}

export function renameSpace(id: string, name: string) {
  const state = ensureSpaces()
  const sp = findSpace(state, id)
  if (!sp) return
  sp.name = name.trim() || sp.name
  if (!isEphemeralSpace(id)) writeJson(SPACES_KEY, state)
}

export function deleteSpace(id: string) {
  if (isEphemeralSpace(id)) {
    ephemeralSpaces.splice(
      ephemeralSpaces.findIndex(s => s.id === id),
      1
    )
    devOpenBySpace.delete(id)
    if (ephemeralCurrent === id) ephemeralCurrent = null // back to the document's current
    return
  }
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
  const cur = currentId(state)
  let fallback: string | null = null
  for (const sp of allSpaces(state)) {
    if (sp.open.some(o => o.system && o.systemId === systemId)) {
      if (sp.id === cur) return sp.id
      if (!fallback) fallback = sp.id
    }
  }
  return fallback
}

type LoadedAction = { name: string; payload: unknown }

// Rewrite a window's loaded actions wherever it lives — any space, or ephemeral.
function editLoadedActions(instanceId: string, edit: (list: LoadedAction[]) => LoadedAction[]) {
  const withEdit = (entry: NappWindowState): NappWindowState => ({
    ...entry,
    loadedActions: edit(Array.isArray(entry.loadedActions) ? entry.loadedActions : [])
  })
  for (const arr of devOpenBySpace.values()) {
    const i = arr.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      arr[i] = withEdit(arr[i])
      return
    }
  }
  const spaces = ensureSpaces()
  for (const sp of allSpaces(spaces)) {
    const i = sp.open.findIndex(n => n.instanceId === instanceId)
    if (i >= 0) {
      sp.open[i] = withEdit(sp.open[i])
      if (!isEphemeralSpace(sp.id)) writeJson(SPACES_KEY, spaces)
      return
    }
  }
}

// An action dispatched to the window: appended, replayed in order on restore.
// Bounded: the last LOADED_ACTIONS_KEEP, none over 8 KB (the size a napp's own
// state gets, see setLoadedAction's caller). A window taking actions all day
// would otherwise grow the spaces document until localStorage refuses it.
const LOADED_ACTIONS_KEEP = 20
export function appendLoadedAction(instanceId: string, name: string, payload: unknown) {
  let size = 0
  try {
    size = JSON.stringify(payload ?? null).length
  } catch {}
  if (size > 8192) return
  editLoadedActions(instanceId, list => [...list, { name, payload }].slice(-LOADED_ACTIONS_KEEP))
}

// Where the napp took itself (its own history state): the latest of that
// action wins and goes last, so a restore ends where the napp was.
export function setLoadedAction(instanceId: string, name: string, payload: unknown) {
  editLoadedActions(instanceId, list => [...list.filter(a => a.name !== name), { name, payload }])
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
  const base = `${event.pubkey.slice(0, 16)}~${dTag || ""}`
  // NIP-5D napplets (kinds 5129/15129/35129) get their own namespace so a
  // pubkey can publish both a 35128 nsite and a napplet under the same d tag
  // without colliding.
  if (event.kind === 5129 || event.kind === 15129 || event.kind === 35129) {
    return `napplet~${base}`
  }
  return base
}

function writeInstalled(all: Record<string, Omit<InstalledApp, "nappId">>) {
  writeJson(INSTALLED_KEY, all)
}

// Parsed once per distinct stored string: the records carry whole manifests,
// and the launcher input rebuilds its list from them on every open and
// keystroke. Every mutation writes back in the same call, so a cached object
// is never stale — the next read sees the new string and re-parses.
let installedCache: {
  raw: string | null
  parsed: Record<string, Omit<InstalledApp, "nappId">>
} | null = null
function readInstalled(): Record<string, Omit<InstalledApp, "nappId">> {
  const raw = localStorage.getItem(INSTALLED_KEY)
  if (installedCache && installedCache.raw === raw) return installedCache.parsed
  let parsed: Record<string, Omit<InstalledApp, "nappId">> = {}
  try {
    parsed = JSON.parse(raw || "") ?? {}
  } catch {}
  installedCache = { raw, parsed }
  return parsed
}

// `installedAt` seeds the first-install time for a record that has none —
// a temp app kept for real keeps its place in the list.
export function storeInstalledEvent(event: NostrEvent, petname?: string, installedAt?: number) {
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
    modes: modesFromEventTags(event.tags),
    initialSize: initialSizeFromEventTags(event.tags),
    event,
    // First install wins: an update re-runs this, and it shouldn't read as a
    // fresh install (the apps list orders by this).
    installedAt: existing?.installedAt || installedAt || Math.floor(Date.now() / 1000)
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
  requires?: string[]
  modes?: unknown
  initialSize?: unknown
  html?: string | null
}) {
  if (!app?.nappId) return
  const all = readInstalled()

  all[app.nappId] = {
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    actions: app.actions || [],
    requires: sanitizeRequires(app.requires),
    singleton: !!app.singleton,
    modes: sanitizeModes(app.modes),
    initialSize: sanitizeInitialSize(app.initialSize),
    ...(app.html ? { html: app.html } : {}),
    installedAt: all[app.nappId]?.installedAt || Math.floor(Date.now() / 1000)
  }
  writeInstalled(all)
}

// NIP-5D `requires` domains from metadata.json — untrusted napp input.
function sanitizeRequires(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(s => typeof s === "string" && s && s.length <= 64).slice(0, 32)
}

// App presentation modes — untrusted napp input, from metadata.json `modes`
// or ["mode", "<mode>"] manifest tags. Anything outside the vocabulary is
// dropped; an empty result means the default (see modesOfApp).
const NAPP_MODES: NappMode[] = ["normal", "auxiliary", "headless"]

export function sanitizeModes(v: unknown): NappMode[] {
  if (!Array.isArray(v)) return []
  const out: NappMode[] = []
  for (const m of v) {
    if (
      typeof m === "string" &&
      (NAPP_MODES as string[]).includes(m) &&
      !out.includes(m as NappMode)
    ) {
      out.push(m as NappMode)
    }
  }
  return out
}

// Effective modes for an app: what it advertised, or ["normal"] when the
// field is absent/empty.
export function modesOfApp(app: { modes?: NappMode[] } | undefined | null): NappMode[] {
  const modes = sanitizeModes(app?.modes)
  return modes.length ? modes : ["normal"]
}

// ["mode", "<mode>"] per-mode tags (["modes", ...] accepted too).
export function modesFromEventTags(tags: string[][]): NappMode[] {
  const out: unknown[] = []
  for (const t of tags ?? []) {
    if (t[0] === "mode" && typeof t[1] === "string" && t[1]) out.push(t[1])
    else if (t[0] === "modes") for (const v of t.slice(1)) out.push(v)
  }
  return sanitizeModes(out)
}

// Preferred floating-window size — untrusted napp input. metadata.json
// `initial_size` ({width, height}) or an ["initial_size", "<w>", "<h>"]
// manifest tag (["initial-size", …] accepted too). Null when absent/invalid.
export function sanitizeInitialSize(v: unknown): NappInitialSize | undefined {
  if (!v || typeof v !== "object") return undefined
  const w = Number((v as any).width)
  const h = Number((v as any).height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined
  return { width: Math.min(2000, Math.round(w)), height: Math.min(2000, Math.round(h)) }
}

export function initialSizeFromEventTags(tags: string[][]): NappInitialSize | undefined {
  for (const t of tags ?? []) {
    if ((t[0] === "initial_size" || t[0] === "initial-size") && t[1] != null && t[2] != null) {
      const size = sanitizeInitialSize({ width: Number(t[1]), height: Number(t[2]) })
      if (size) return size
    }
  }
  return undefined
}

// metadata.json carries `initial_size` (snake_case); accept camelCase too.
export function initialSizeFromMeta(meta: any): NappInitialSize | undefined {
  if (!meta || typeof meta !== "object") return undefined
  return sanitizeInitialSize(meta.initial_size ?? meta.initialSize)
}

// ─── Per-napp security policy ───────────────────────────────────
// The default for a napplet without a stored entry: fully locked. Legacy
// nsites/napps with no entry instead keep identity+network (see getPolicy) —
// they predate the policy system and ran unrestricted.
export const DEFAULT_LOCKED_POLICY: NappPolicy = { domains: [] }

// The declarable `requires` vocabulary. NAP_DOMAINS are real NIP-5D capability
// domains serviced over the bridge; LAUNCHER_DOMAINS are our two extensions,
// enforced by the service worker (ui = inject the component kit, network =
// allow direct network). Keep NAP_DOMAINS in sync with NAPPLET_OFFERED (host).
export const NAP_DOMAINS = ["identity", "theme", "storage", "resource", "relay"]
export const LAUNCHER_DOMAINS = ["ui", "network"]
export const ALL_REQUIRES = [...NAP_DOMAINS, ...LAUNCHER_DOMAINS]

// `ui` implies `theme`: the component kit is built on theme's color tokens, so a
// napp that takes the kit must also get the colors — otherwise it renders
// colorless. Applied whenever grants are normalized.
export function expandGrants(domains: unknown): string[] {
  const s = new Set<string>()
  if (Array.isArray(domains)) for (const d of domains) if (typeof d === "string" && d) s.add(d)
  if (s.has("ui")) s.add("theme")
  return [...s].slice(0, 32)
}

function readPolicies(): Record<string, any> {
  const raw = readJson(POLICY_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}

// Bumped whenever a stored policy's meaning changes so getPolicy can back-fill
// grants that older entries couldn't have recorded. v2: `identity` gained a
// meaning (it now gates window.nostr) — pre-v2 non-napplet policies had the
// signer injected unconditionally, so treat them as identity-granted.
const POLICY_VERSION = 2

export function getPolicy(nappId: string): NappPolicy {
  const p = readPolicies()[nappId]
  if (!p || typeof p !== "object") {
    // No record at all: an install that predates the policy system. It ran
    // unrestricted then — sealing it retroactively breaks it (CDN scripts,
    // direct sockets, signer), so legacy nsites/napps keep what they had.
    // Napplets are born under the policy system: absent means locked.
    return nappId.startsWith("napplet~") ? { domains: [] } : { domains: ["identity", "network"] }
  }
  const domains = expandGrants(p.domains)
  // Migrate the old {network:boolean} shape: a granted network boolean becomes
  // the "network" domain entry.
  if (p.network === true && !domains.includes("network")) domains.push("network")
  // Pre-v2 non-napplet policies had window.nostr injected unconditionally — keep
  // their signer so upgrading doesn't strip it. New/edited policies (v2) record
  // identity explicitly, so unchecking it there is honored.
  if ((p.v ?? 0) < 2 && !nappId.startsWith("napplet~") && !domains.includes("identity")) {
    domains.push("identity")
  }
  return { domains }
}

export function setPolicy(nappId: string, policy: NappPolicy) {
  if (!nappId) return
  const all = readPolicies()
  all[nappId] = { domains: expandGrants(policy.domains), v: POLICY_VERSION }
  writeJson(POLICY_KEY, all)
}

// The raw stored record (domains + version) written verbatim into the napp's
// /__policy__, so the service worker applies the same version-aware migration.
export function getStoredPolicy(nappId: string): { domains: string[]; v: number } {
  const p = readPolicies()[nappId]
  return {
    domains: expandGrants(p?.domains),
    v: typeof p?.v === "number" ? p.v : 0
  }
}

export function hasPolicy(nappId: string): boolean {
  return !!readPolicies()[nappId]
}

export function clearPolicy(nappId: string) {
  const all = readPolicies()
  if (!(nappId in all)) return
  delete all[nappId]
  writeJson(POLICY_KEY, all)
}

// ─── NIP-5D napplet storage (NAP-STORAGE) ───────────────────────
// Host-backed key-value store proxied to napplets via window.napplet.storage.
// A napplet has an opaque origin (or, for our nsite-hosted case, we still route
// it here) so it can't use its own localStorage — this is the durable store.
// Keyed nappId → scope → key → string. `scope` is "shared" (per-napp, the
// default) or "instance"; true per-window isolation needs an instance token we
// don't have on this transport yet, so "instance" is a separate per-napp
// namespace for now — isolated from shared, not yet per-window.
const NAPPLET_STORAGE_KEY = "nostrapps:napplet-storage"
type NappletStore = Record<string, Record<string, Record<string, string>>>

function readNappletStore(): NappletStore {
  const raw = readJson(NAPPLET_STORAGE_KEY, {})
  return raw && typeof raw === "object" ? raw : {}
}
function nappletScope(store: NappletStore, nappId: string, scope: string): Record<string, string> {
  const s = scope === "instance" ? "instance" : "shared"
  return (store[nappId] && store[nappId][s]) || {}
}

export function nappletStorageGet(nappId: string, scope: string, key: string): string | null {
  const v = nappletScope(readNappletStore(), nappId, scope)[key]
  return typeof v === "string" ? v : null
}
export function nappletStorageKeys(nappId: string, scope: string): string[] {
  return Object.keys(nappletScope(readNappletStore(), nappId, scope))
}
export function nappletStorageSet(nappId: string, scope: string, key: string, value: string) {
  const s = scope === "instance" ? "instance" : "shared"
  const store = readNappletStore()
  store[nappId] = store[nappId] || {}
  store[nappId][s] = store[nappId][s] || {}
  store[nappId][s][key] = value
  writeJson(NAPPLET_STORAGE_KEY, store)
}
export function nappletStorageRemove(nappId: string, scope: string, key: string) {
  const s = scope === "instance" ? "instance" : "shared"
  const store = readNappletStore()
  if (store[nappId]?.[s] && key in store[nappId][s]) {
    delete store[nappId][s][key]
    writeJson(NAPPLET_STORAGE_KEY, store)
  }
}
export function clearNappletStorage(nappId: string) {
  const store = readNappletStore()
  if (nappId in store) {
    delete store[nappId]
    writeJson(NAPPLET_STORAGE_KEY, store)
  }
}

// ── napplet config (NAP-CONFIG: shell-owned settings per napp — the schema
// the napp registered, and the values the user set in the settings form) ──
const NAPPLET_CONFIG_KEY = "nostrapps:napplet-config"
type NappletConfigRecord = { schema?: any; version?: number; values?: Record<string, unknown> }

function readNappletConfigs(): Record<string, NappletConfigRecord> {
  return readJson(NAPPLET_CONFIG_KEY, {})
}
export function getNappletConfig(nappId: string): {
  schema: any | null
  version: number | undefined
  values: Record<string, unknown>
} {
  const r = readNappletConfigs()[nappId]
  return { schema: r?.schema ?? null, version: r?.version, values: r?.values ?? {} }
}
export function setNappletConfigSchema(nappId: string, schema: any, version?: number) {
  const all = readNappletConfigs()
  const values = all[nappId]?.values
  all[nappId] = {
    ...all[nappId],
    schema,
    ...(version === undefined ? {} : { version }),
    // Restored values arrive as text; the schema says what they are.
    ...(values ? { values: coerceConfigValues(schema, values) } : {})
  }
  writeJson(NAPPLET_CONFIG_KEY, all)
}

// Config values as the schema types them: "true" for a boolean, "12" for a
// number, a string matching one of an enum's values. Anything else as it is.
export function coerceConfigValues(
  schema: any,
  values: Record<string, unknown>
): Record<string, unknown> {
  const props = schema?.properties ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const p = props[key]
    out[key] = typeof value === "string" && p && typeof p === "object" ? typed(p, value) : value
  }
  return out
}

function typed(p: any, value: string): unknown {
  if (Array.isArray(p.enum)) return p.enum.find((e: unknown) => String(e) === value) ?? value
  const type = Array.isArray(p.type) ? p.type[0] : p.type
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value
  if (type === "number" || type === "integer") {
    const n = Number(value)
    return value.trim() !== "" && Number.isFinite(n) ? n : value
  }
  return value
}
export function setNappletConfigValues(nappId: string, values: Record<string, unknown>) {
  const all = readNappletConfigs()
  all[nappId] = { ...all[nappId], values }
  writeJson(NAPPLET_CONFIG_KEY, all)
}
export function clearNappletConfig(nappId: string) {
  const all = readNappletConfigs()
  if (nappId in all) {
    delete all[nappId]
    writeJson(NAPPLET_CONFIG_KEY, all)
  }
}

export function getInstalledNappIds(): string[] {
  const ids = Object.keys(readInstalled())
  for (const nappId of devApps.keys()) {
    if (!ids.includes(nappId)) ids.push(nappId)
  }
  // Ephemeral origins from an earlier session: devApps is empty after a reload,
  // so these would otherwise be invisible to the factory reset too.
  for (const nappId of listEphemeralOrigins()) {
    if (!ids.includes(nappId)) ids.push(nappId)
  }
  return ids
}

// ─── Ephemeral origins (dev~ / temp~) ───────────────────────────
// See EPHEMERAL_KEY. Recorded when the origin is booted, dropped when wiped.

export function listEphemeralOrigins(): string[] {
  const list = readJson(EPHEMERAL_KEY, [])
  return Array.isArray(list) ? list.filter(id => typeof id === "string" && id) : []
}

export function rememberEphemeralOrigin(nappId: string) {
  if (!nappId) return
  const list = listEphemeralOrigins()
  if (list.includes(nappId)) return
  list.push(nappId)
  writeJson(EPHEMERAL_KEY, list)
}

export function forgetEphemeralOrigin(nappId: string) {
  const list = listEphemeralOrigins()
  const next = list.filter(id => id !== nappId)
  if (next.length === list.length) return
  // Drop the key entirely once the last one is gone, so a clean launcher leaves
  // no evidence that a dev napp was ever run.
  if (next.length === 0) localStorage.removeItem(EPHEMERAL_KEY)
  else writeJson(EPHEMERAL_KEY, next)
}

export function getInstalledApp(nappId: string): InstalledApp | undefined {
  const app = readInstalled()[nappId]
  if (app) return { nappId, ...app }

  const dev = devApps.get(nappId)
  if (dev) return { nappId, ...dev }
}

// The three app tiers. napplet = a NIP-5D capability app (its own kinds). napp =
// kind 35130. nsite = kind 35128 without capabilities.
export function classifyEvent(event: { kind: number; tags: string[][] }): AppType {
  if (event.kind === 5129 || event.kind === 15129 || event.kind === 35129) return "napplet"
  if (event.kind === 35130) return "napp"
  return "nsite"
}

export function classifyInstalled(app: InstalledApp): AppType {
  if (app.nappId.startsWith("napplet~") || app.event?.kind === 35129) return "napplet"
  if (app.event) return classifyEvent(app.event)
  // dev/local/temp: no manifest event — classify from the stored declarations.
  const caps = (app.actions?.length ?? 0) > 0 || (app.requires?.length ?? 0) > 0
  return caps ? "napp" : "nsite"
}

export function classifyNappId(nappId: string): AppType {
  const app = getInstalledApp(nappId)
  if (app) return classifyInstalled(app)
  return nappId.startsWith("napplet~") ? "napplet" : "nsite"
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
  // Called on every window commit: the catalog (whole manifests) is only
  // written back for an actual rename.
  if (!all[nappId] || all[nappId].petname === petname) return

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
  requires?: string[]
  modes?: NappMode[]
  initialSize?: NappInitialSize
  installedAt: number
  temporary?: boolean
  // A link's app has its manifest in hand: kept on the record so its card
  // shows what an installed one would (author, description, date, icon).
  event?: NostrEvent
}

const devApps = new Map<string, DevAppData>()

export function storeDevApp(app: {
  nappId: string
  title?: string | null
  icon?: string | null
  petname?: string | null
  singleton?: boolean
  actions?: string[]
  requires?: string[]
  modes?: unknown
  initialSize?: unknown
  temporary?: boolean
  event?: NostrEvent | null
}) {
  if (!app?.nappId) return
  devApps.set(app.nappId, {
    title: sanitizeString(app.title),
    icon: sanitizeString(app.icon),
    petname: sanitizeString(app.petname) || sanitizeString(app.title) || app.nappId,
    singleton: !!app.singleton,
    actions: app.actions || [],
    requires: sanitizeRequires(app.requires),
    modes: sanitizeModes(app.modes),
    initialSize: sanitizeInitialSize(app.initialSize),
    installedAt: devApps.get(app.nappId)?.installedAt || Math.floor(Date.now() / 1000),
    ...(app.temporary ? { temporary: true } : {}),
    ...(app.event ? { event: app.event } : {})
  })
}

// Drop only the memory-only record (a kept app's, once persisted under the
// same id).
export function forgetDevApp(nappId: string) {
  devApps.delete(nappId)
}

// ─── history ───────────────────────────────────────────────────
// What was tried and would otherwise be gone: a share link as opened (before
// its fetch, so a cancelled one stays), a space as deleted or discarded — each
// as the link that brings it back. Newest first, one entry per link (a repeat
// moves up), capped. Local only, and the launcher's alone: no napp reads it.
const HISTORY_KEY = "nostrapps:history"
const HISTORY_MAX = 200
export type HistoryEntry = { at: number; kind: "link" | "space"; name: string; link: string }

export function listHistory(): HistoryEntry[] {
  const raw = readJson(HISTORY_KEY, [])
  return Array.isArray(raw) ? raw.filter(isHistoryEntry) : []
}

export function addHistory(entry: Omit<HistoryEntry, "at">) {
  const rest = listHistory().filter(e => e.link !== entry.link)
  writeJson(HISTORY_KEY, [{ at: Date.now(), ...entry }, ...rest].slice(0, HISTORY_MAX))
}

export function forgetHistory(link: string) {
  const kept = listHistory().filter(e => e.link !== link)
  writeJson(HISTORY_KEY, kept)
}

function isHistoryEntry(e: any): e is HistoryEntry {
  return (
    !!e &&
    typeof e.at === "number" &&
    (e.kind === "link" || e.kind === "space") &&
    typeof e.name === "string" &&
    typeof e.link === "string"
  )
}
