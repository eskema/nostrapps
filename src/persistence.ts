import { NostrEvent } from "@nostr/tools"
import { InstalledApp, NappWindowState, SpaceData, SpacesState } from "./types"

const OPEN_KEY = "nostrapps:open"
const INSTALLED_KEY = "nostrapps:installed"
const SPACES_KEY = "nostrapps:spaces"
const PACK_MODE_KEY = "nostrapps:packMode"

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

function isEphemeralNappId(nappId: string): boolean {
  return nappId.startsWith("dev~") || nappId.startsWith("temp~")
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
    if (isEphemeralNappId(n.nappId)) {
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
  // Check if this is an ephemeral nappId — if so, add to in-memory
  if (isEphemeralNappId(state.nappId)) {
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

// ─── Spaces (saved window configurations) ──────────────────
// The live/current space's window set stays in `nostrapps:open` (so all the
// open/* helpers above are unchanged). `nostrapps:spaces` holds the full list of
// spaces — each with its own `open` snapshot — plus which one is current. A
// snapshot is written when switching away from a space.

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

// Lazily migrate the legacy single `open` into a "default" space on first use.
function ensureSpaces(): SpacesState {
  const existing = readSpacesRaw()
  if (existing) return existing
  const open = readOpenFromStorage()
  const packMode = localStorage.getItem(PACK_MODE_KEY) === "1"
  const def: SpaceData = { id: "default", name: "default", open, saved: open, packMode, savedPackMode: packMode }
  const state: SpacesState = { current: "default", list: [def] }
  writeJson(SPACES_KEY, state)
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

// Persist a space's live window set + pack-mode (called before switching away).
export function saveSpaceState(id: string, open: NappWindowState[], packMode: boolean) {
  const state = ensureSpaces()
  const sp = state.list.find(s => s.id === id)
  if (!sp) return
  sp.open = open
  sp.packMode = packMode
  writeJson(SPACES_KEY, state)
}

export function setCurrentSpaceId(id: string) {
  const state = ensureSpaces()
  if (!state.list.some(s => s.id === id)) return
  state.current = id
  writeJson(SPACES_KEY, state)
}

export function createSpace(name?: string): string {
  const state = ensureSpaces()
  const id = crypto.randomUUID()
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

// Commit the given live state as the space's saved snapshot (the "Save" action).
export function commitSpaceSaved(id: string, open: NappWindowState[], packMode: boolean) {
  const state = ensureSpaces()
  const sp = state.list.find(s => s.id === id)
  if (!sp) return
  sp.open = open
  sp.saved = open
  sp.packMode = packMode
  sp.savedPackMode = packMode
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

// Which OTHER space (not the current one) holds an open instance of a system
// napp. Used to enforce the "one system napp instance, in one space" rule:
// invoking it navigates there instead of duplicating.
export function findOtherSpaceWithSystemNapp(systemId: string): string | null {
  const state = ensureSpaces()
  for (const sp of state.list) {
    if (sp.id === state.current) continue
    if (sp.open.some(o => o.system && o.systemId === systemId)) return sp.id
  }
  return null
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
    singleton: !!app.singleton,
    installedAt: all[app.nappId]?.installedAt || Math.floor(Date.now() / 1000)
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
  const apps: InstalledApp[] = []

  const installed = readInstalled()
  for (const nappId in installed) {
    const app = installed[nappId]
    apps.push({
      nappId: nappId,
      icon: app.icon,
      title: app.title,
      petname: app.petname,
      singleton: app.singleton,
      actions: app.actions,
      // Surface the stored manifest so cards can show author + date (parity with
      // the discover tab). Local apps have no event but carry an install date.
      event: app.event,
      installedAt: app.installedAt
    })
  }

  for (const [nappId, dev] of devApps) {
    apps.push({
      nappId: nappId,
      icon: dev.icon,
      title: dev.title,
      petname: dev.petname,
      singleton: dev.singleton,
      actions: dev.actions,
      installedAt: dev.installedAt
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
      nappId: nappId,
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

export function forgetDevApp(nappId: string) {
  devApps.delete(nappId)
}
