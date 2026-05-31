import "@fontsource-variable/source-sans-3"
import "@fontsource-variable/source-serif-4"
import "@fontsource-variable/source-code-pro"
import {
  launch,
  focusInstance,
  launchSystem,
  mountWithLoading,
  wipe,
  destroyByNappId,
  reinstallFiles,
  reloadIframesByNappId,
  callIframe,
  tileWindows,
  bestFitPack,
  broadcastTheme,
  nappOriginFor,
  bootNapp,
  bootDevApp,
  setDevHandle,
  setTempFiles,
  removeDevHandle,
  setInstanceIdSerial
} from "./sandbox/host.js"
import { resolveInput } from "./nsite/resolve.js"
import { fetchNsite } from "./nsite/fetch.js"
import { collectLocalFolder, slug } from "./nsite/local.js"
import { currentSigner, reconnectIfNeeded } from "./signers/index.js"
import { connectBunkerInput, disconnectBunkerSigner } from "./signers/nip46.js"
import { googleLoginAndCreateBunker } from "./signers/google.js"
import * as account from "./account.js"
import { mountDialog, clearDecisions } from "./permissions.js"
import * as persist from "./persistence.js"
import * as handlers from "./handlers.js"
import * as nostrdb from "./store.js"
import type {
  SuggestionItem,
  NsiteResult,
  NappWindowState,
  SystemCtx,
  NappWindow
} from "./types.js"
import {
  registry as systemRegistry,
  slashCommands,
  list as systemList,
  actionRegistry,
  slashActions,
  actionList
} from "./system-napps/index.js"
import { Filter } from "@nostr/tools/filter"
import { pool } from "@nostr/gadgets/global"
import { EventTemplate } from "@nostr/tools"


pool.trackRelays = true
pool.automaticallyAuth = (_url: string) =>
  currentSigner() ? (evt: EventTemplate) => currentSigner()?.signEvent(evt) as any : null

const stage = document.getElementById("stage")!
const form = document.getElementById("launch-form")!
const input = document.getElementById("nsite-input") as HTMLInputElement
const suggestions = document.getElementById("suggestions")!
const localFolderInput = document.getElementById("local-folder") as HTMLInputElement
const tileBtn = document.getElementById("tile-windows")!
const packToggleBtn = document.getElementById("pack-toggle")!

tileBtn?.addEventListener("click", () => tileWindows(stage))

// ─── pack mode (Packery-style auto-layout on move/resize) ───────
const PACK_MODE_KEY = "nostrapps:packMode"
let packModeOn = localStorage.getItem(PACK_MODE_KEY) === "1"

// Re-entry guard: bestFitPack itself fires onStateChange (per persisted
// position) which would loop right back here. We coalesce all state
// changes during a single tick into one rAF-scheduled pack, and skip
// scheduling while the pack is mid-flight.
//
// Also skip while a drag or resize is in progress (`body.napp-dragging` /
// `body.napp-resizing`): each runs its own focused live-pack which
// already keeps the operating window's style untouched. A generic
// bestFitPack here would re-include it and fight the user's input.
let repackQueued = false
let repackInProgress = false
function maybeRepack() {
  if (!packModeOn || repackInProgress || repackQueued) return
  if (
    document.body.classList.contains("napp-dragging") ||
    document.body.classList.contains("napp-resizing")
  ) {
    return
  }
  repackQueued = true
  requestAnimationFrame(() => {
    repackQueued = false
    repackInProgress = true
    try {
      bestFitPack(stage)
    } finally {
      repackInProgress = false
    }
  })
}

function applyPackMode() {
  packToggleBtn?.setAttribute("aria-pressed", packModeOn ? "true" : "false")
  // The drag handler (in napp-window.js) reads this class to decide
  // whether to render a drop placeholder during the drag.
  stage?.classList.toggle("pack-mode", packModeOn)
  localStorage.setItem(PACK_MODE_KEY, packModeOn ? "1" : "0")
  if (packModeOn) maybeRepack()
}

packToggleBtn?.addEventListener("click", () => {
  packModeOn = !packModeOn
  applyPackMode()
})

applyPackMode()

mountDialog(document.getElementById("permission-prompt") as HTMLDialogElement | null)

// ─── theme store ────────────────────────────────────────────────
const THEME_KEY = "nostrapps:theme"
const themeSubs = new Set<(choice: string) => void>()
function applyTheme(choice: string) {
  if (choice === "light" || choice === "dark") {
    document.documentElement.dataset.theme = choice
  } else {
    delete document.documentElement.dataset.theme
  }
}
const theme = {
  get() {
    return localStorage.getItem(THEME_KEY) || "auto"
  },
  set(choice: string) {
    if (choice === "auto") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
    applyTheme(choice)
    for (const fn of themeSubs) fn(choice)
  },
  subscribe(fn: (choice: string) => void) {
    themeSubs.add(fn)
    return () => themeSubs.delete(fn)
  }
}
applyTheme(theme.get())
theme.subscribe(() => broadcastTheme())

// ─── log bus ────────────────────────────────────────────────────
// Each entry is `{ at: msTimestamp, msg: string }`. Consumers (currently
// /logs) format the timestamp how they want.
const logHistory: Array<{ at: number; msg: string }> = []
const logSubs = new Set<() => void>()
function setStatus(msg: string) {
  logHistory.push({ at: Date.now(), msg })
  for (const fn of logSubs) {
    try {
      fn()
    } catch {}
  }
}
const logs = {
  history: () => logHistory.slice(),
  subscribe(fn: () => void) {
    logSubs.add(fn)
    return () => logSubs.delete(fn)
  }
}

const appSubs = new Set<() => void>()
function notifyAppsChanged() {
  for (const fn of appSubs) {
    try {
      fn()
    } catch {}
  }
}

// ─── account actions ────────────────────────────────────────────
async function connect(): Promise<void> {
  try {
    if (!window.nostr) throw new Error("No NIP-07 extension detected")
    setStatus("Requesting pubkey from extension…")
    const pk = await window.nostr.getPublicKey()
    account.setAccount(pk, "nip07")
    setStatus(`Connected as ${pk.slice(0, 8)}…`)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    throw err
  }
}

async function connectBunker(uri: string): Promise<void> {
  try {
    setStatus("Connecting to bunker…")
    const pk = await connectBunkerInput(uri)
    account.setAccount(pk, "nip46")
    setStatus(`Connected as ${pk.slice(0, 8)}… (bunker)`)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    throw err
  }
}

// One-shot Google OAuth → Pomegranate sharding → bunker handoff. End state
// is identical to a plain `connect with bunker` paste, but the user never
// sees a bunker URI: we mint one against our hardcoded central+operators.
async function connectGoogle(): Promise<void> {
  try {
    setStatus("Logging in with Google…")
    const uri = await googleLoginAndCreateBunker({ onProgress: setStatus })
    setStatus("Connecting to bunker…")
    const pk = await connectBunkerInput(uri)
    account.setAccount(pk, "nip46")
    setStatus(`Connected as ${pk.slice(0, 8)}… (bunker)`)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    throw err
  }
}

async function disconnect(): Promise<void> {
  if (account.getType() === "nip46") {
    try {
      await disconnectBunkerSigner()
    } catch {}
  }
  account.clearPubkey()
  setStatus("Disconnected")
}

const uninstallingNapps = new Set<string>()

async function finalizeNappRemoval(nappId: string, actionLabel = "Uninstalling") {
  clearDecisions(nappId)
  persist.forgetInstalledNapp(nappId)
  handlers.removeApp(nappId)
  removeDevHandle(nappId)
  setStatus(`${actionLabel} ${nappId}…`)
  try {
    await wipe(nappId)
    setStatus(`${actionLabel === "Wiping" ? "Destroyed" : "Uninstalled"} ${nappId}`)
  } catch (err: any) {
    setStatus(`Wipe error: ${err.message}`)
    throw err
  }
}

// Wipe every trace of the launcher: every installed napp's origin storage,
// every `nostrapps:*` localStorage entry, the launcher's IndexedDB, caches,
// and any OPFS data. Then reload to a clean slate. Confirm gated upstream.
async function factoryReset() {
  setStatus("Starting full reset…")

  // 1. Wipe each napp origin we've ever touched.
  const allNappIds = new Set<string>()
  for (const id of persist.getInstalledNappIds()) allNappIds.add(id)
  for (const s of persist.readOpen()) {
    if (s.nappId && !s.system) allNappIds.add(s.nappId)
  }
  for (const nappId of allNappIds) {
    setStatus(`Wiping ${nappId}…`)
    try {
      await wipe(nappId)
    } catch (err: any) {
      console.warn("wipe failed for", nappId, err)
    }
  }

  // 2. Clear every `nostrapps:*` localStorage key.
  setStatus("Clearing localStorage…")
  const lsKeys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith("nostrapps:")) lsKeys.push(k)
  }
  for (const k of lsKeys) localStorage.removeItem(k)
  try {
    sessionStorage.clear()
  } catch {}

  // 3. Drop every IndexedDB on the launcher origin.
  setStatus("Clearing IndexedDB…")
  try {
    if (typeof (indexedDB as any).databases === "function") {
      const dbs: any[] = await (indexedDB as any).databases()
      await Promise.all(
        dbs.map(
          (d: any) =>
            new Promise<void>(resolve => {
              if (!d.name) return resolve()
              const req = indexedDB.deleteDatabase(d.name)
              req.onsuccess = () => resolve()
              req.onerror = () => resolve()
              req.onblocked = () => resolve()
            })
        )
      )
    }
  } catch {}

  // 4. CacheStorage on the launcher origin.
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    } catch {}
  }

  // 5. OPFS (used by @nostr/gadgets/redstore for the global event store).
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory()
      const entries = []
      for await (const handle of root.values?.() ?? []) {
        entries.push(handle.name)
      }
      for (const name of entries) {
        try {
          await root.removeEntry(name, { recursive: true })
        } catch {}
      }
    } catch {}
  }

  // 6. Service workers on the launcher origin (probably none, but be sure).
  if (navigator.serviceWorker?.getRegistrations) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.unregister()))
    } catch {}
  }

  setStatus("Reset complete — reloading…")
  setTimeout(() => location.reload(), 400)
}

function loadFolder() {
  localFolderInput.click()
}

async function uninstall(nappId: string) {
  const wasInstalled = !!persist.getInstalledAppForNappId(nappId)
  uninstallingNapps.add(nappId)

  // Destroy any open windows; their onDestroy chain runs the per-instance
  // cleanup and (when the last open instance dies) the global wipe path.
  try {
    destroyByNappId(nappId)

    // Close any remaining (closed) sessions in persistence so they don't
    // linger as orphan entries.
    for (const s of persist.readOpen()) {
      if (s.nappId === nappId) {
        persist.removeOpen(s.instanceId)
      }
    }

    if (wasInstalled) {
      await finalizeNappRemoval(nappId, "Uninstalling")
    }
  } finally {
    uninstallingNapps.delete(nappId)
    refreshSuggestions()
  }
}

function capabilitiesFromEvent(event: { tags: string[][] } | null | undefined): string[] {
  if (!event) return []
  const actions = []
  for (const t of event.tags) {
    if (t[0] === "action" && typeof t[1] === "string" && t[1]) {
      actions.push(t[1])
    }
  }
  return actions
}

// Update flow: re-fetch the manifest + files at the same target, swap them
// into the napp's existing origin storage (no new window), persist the new
// version, and force any open iframes to reload so they pick up new files.
async function updateNapp(target: { pubkey: string; dTag: string; relayHints: string[] }) {
  if (!target?.pubkey) throw new Error("updateNapp: missing pubkey")
  console.debug("[launch] updateNapp", {
    pubkey: target.pubkey,
    dTag: target.dTag,
    relayHints: target.relayHints
  })
  setStatus(`Checking update…`)
  const updateResult = (await fetchNsite(target, setStatus)) as unknown as NsiteResult
  const { nappId, files, title, manifest } = updateResult
  const label = title || nappId
  setStatus(`Updating ${label}…`)
  await reinstallFiles(nappId, files, setStatus, label)
  if (manifest) persist.storeInstalledEvent(manifest)
  handlers.addApp(nappId, capabilitiesFromEvent(manifest))
  const reloaded = reloadIframesByNappId(nappId)
  setStatus(
    `Updated ${label}` +
      (reloaded ? ` — reloaded ${reloaded} window${reloaded === 1 ? "" : "s"}` : "")
  )
  refreshSuggestions()
}

// ─── inter-app calling (actions) ────────────────────────────────

async function runNappAction(
  callerNappId: string,
  name: string,
  payload: unknown,
  options?: { instance?: string }
) {
  if (typeof name !== "string" || !name) {
    throw new Error("napp.action: action name is required")
  }

  if (options?.instance) {
    persist.appendLoadedAction(options.instance, name, payload)
    const result = await callIframe(options.instance, { name, payload })
    return result
  }

  const candidates = handlers.findHandlersForAction(name).filter(id => id !== callerNappId)
  const nappId =
    candidates.length === 1
      ? candidates[0]
      : await pickHandler(callerNappId, name, payload, candidates)
  const win = await launch(stage, nappId, {
    ...makeLaunchOpts(),
    petname: friendlyNameFor(nappId)
  })
  const instanceId = win.getState().instanceId
  persist.appendLoadedAction(instanceId, name, payload)
  setStatus(
    `Action "${name}" ${friendlyNameFor(callerNappId)} → ${friendlyNameFor(nappId)}, ${JSON.stringify(payload)}`
  )
  const result = await callIframe(instanceId, {
    name,
    payload
  })
  if (result) {
    setStatus(`Action "${name}" result: ${JSON.stringify(result)}`)
  }
  return result
}

async function replayLoadedActions(instanceId: string) {
  for (const action of persist.getLoadedActions(instanceId)) {
    await callIframe(instanceId, action)
  }
}

async function pickHandler(
  callerNappId: string,
  actionName: string,
  payload: unknown,
  candidates: string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let win: NappWindow | null = null
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      win?.close()
    }
    win = launchSystemNapp("handler", {
      persistent: false,
      params: {
        name: actionName,
        payload,
        callerNappId,
        candidates,
        select(nappId: string) {
          if (!candidates.includes(nappId)) return
          finish(() => resolve(nappId))
        },
        cancel() {
          finish(() => reject(new Error("Action handler selection cancelled")))
        }
      }
    })
    if (candidates.length === 0) {
      setStatus(`No handler for action "${actionName}" from ${friendlyNameFor(callerNappId)}`)
    }
  })
}

function friendlyNameFor(nappId: string): string {
  return petnameForNappId(nappId, persist.readOpen()) || nappId
}

// ─── system napp ctx ────────────────────────────────────────────
const systemCtx: SystemCtx = {
  account,
  apps: {
    events() {
      return persist.getInstalledEvents()
    },
    list() {
      return persist.getInstalledApps()
    },
    subscribe(fn: () => void) {
      appSubs.add(fn)
      return () => appSubs.delete(fn)
    }
  },
  database: {
    query: (filter: Filter) => nostrdb.query(filter)
  },
  theme,
  logs,
  connect,
  connectBunker,
  connectGoogle,
  disconnect,
  factoryReset,
  loadFolder,
  setStatus,
  installDevApp,
  launchSystemNapp,
  // Use a thunk so the reference resolves to the function declared later.
  isInstalled: (nappId: string) => !!persist.getInstalledAppForNappId(nappId),
  wasInstalled: (nappId: string) => !!persist.getInstalledAppForNappId(nappId),
  install: (raw: string) => install(raw),
  uninstall: (nappId: string) => uninstall(nappId),
  update: (target: { pubkey: string; dTag: string; relayHints: string[] }) => updateNapp(target)
}

function makeSystemLaunchOpts(sysId: string) {
  return {
    onStateChange: (state: NappWindowState) => {
      persist.updateOpen(state.instanceId, {
        ...state,
        system: true,
        systemId: sysId
      })
      refreshSuggestions()
      maybeRepack()
    },
    onReorder: persistDomOrder,
    onClose: (instanceId: string) => {
      persist.removeOpen(instanceId)
      refreshSuggestions()
    }
  }
}

function launchSystemNapp(
  sysId: string,
  { params, persistent = true }: { params?: any; persistent?: boolean } = {}
) {
  const def = systemRegistry[sysId]
  if (!def) throw new Error(`Unknown system napp: ${sysId}`)
  console.debug("[launch] launchSystemNapp", { sysId, title: def.title, params })
  const launchOpts = persistent
    ? makeSystemLaunchOpts(sysId)
    : {
        onReorder: persistDomOrder,
        onClose: () => refreshSuggestions()
      }
  const win = launchSystem(stage, sysId, def, systemCtx, {
    ...launchOpts,
    params
  })!
  bringToTopOfStack(win.root)
  // Persist the entry now (with current zIndex/position) so it can be
  // restored on the next reload even if the user never interacts with it.
  const state = win.getState()

  if (persistent) {
    persist.updateOpen(state.instanceId, {
      ...state,
      system: true,
      systemId: sysId,
      params
    })
    persistDomOrder()
  }
  refreshSuggestions()
  return win
}

// ─── suggestions ────────────────────────────────────────────────
function buildSuggestionItems(): SuggestionItem[] {
  const seen = new Set()
  const out: SuggestionItem[] = []
  const sessionNappIds = new Set()

  // System napps + slash actions first — discoverability for slash commands
  for (const def of systemList) {
    out.push({
      source: "system",
      systemId: def.id,
      slash: def.slash,
      petname: def.title
    })
  }
  for (const def of actionList) {
    out.push({
      source: "action",
      actionId: def.id,
      slash: def.slash,
      petname: def.title
    })
  }

  const openSessions = persist.readOpen()

  for (const s of openSessions) {
    if (s.system) continue // shown via systemList row instead
    const key = `sess:${s.instanceId}`
    if (seen.has(key)) continue
    seen.add(key)
    const customPet = s.petname && s.petname !== s.nappId ? s.petname : null
    out.push({
      source: "open",
      nappId: s.nappId,
      instanceId: s.instanceId,
      petname: customPet
    })
    if (s.nappId) sessionNappIds.add(s.nappId)
  }

  for (const app of persist.getInstalledApps()) {
    if (sessionNappIds.has(app.nappId)) continue
    const key = `napp:${app.nappId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source: "napp",
      nappId: app.nappId,
      petname: petnameForNappId(app.nappId, openSessions)
    })
  }

  return out
}

function petnameForNappId(nappId: string, sessions: any[]): string | null {
  // Prefer a petname from any session for this nappId — that's typically the
  // friendliest name (manifest title we set at launch).
  for (const s of sessions) {
    if (s.nappId === nappId && s.petname && s.petname !== nappId) {
      return s.petname
    }
  }
  return persist.getInstalledAppForNappId(nappId)?.petname || null
}

function itemSearchText(item: SuggestionItem): string {
  return [
    item.nappId,
    item.instanceId,
    item.petname,
    item.raw,
    item.slash,
    item.systemId,
    item.actionId
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function itemPreferredValue(item: SuggestionItem): string {
  return item.slash || item.petname || item.nappId || item.raw || ""
}

function renderSuggestions() {
  const filter = input!.value.trim().toLowerCase()
  const items = buildSuggestionItems().filter(
    item => !filter || itemSearchText(item).includes(filter)
  )

  // Three sections:
  //   1. System items (slash commands and slash actions) — discoverability.
  //   2. Last 5 sessions (open or closed), in recency order from persist.
  //   3. Everything else (NAPP / NAME), alphabetical by friendly name.
  const systemItems = items.filter(i => i.source === "system" || i.source === "action")
  const sessionItems = items.filter(i => i.source === "open").slice(0, 5)
  const sessionSet = new Set(sessionItems)
  const sysSet = new Set(systemItems)
  const restItems = items
    .filter(i => !sysSet.has(i) && !sessionSet.has(i))
    .sort((a, b) => itemSortLabel(a).localeCompare(itemSortLabel(b)))

  suggestions.innerHTML = ""
  let appended = false
  for (const section of [systemItems, sessionItems, restItems]) {
    if (section.length === 0) continue
    if (appended) {
      const divider = document.createElement("div")
      divider.className = "sugg-divider"
      suggestions.appendChild(divider)
    }
    appended = true
    for (const item of section) suggestions.appendChild(renderSuggestionRow(item))
  }
}

function itemSortLabel(item: SuggestionItem): string {
  return (item.petname || item.nappId || item.raw || "").toLowerCase()
}

function renderSuggestionRow(item: SuggestionItem): HTMLDivElement {
  const row = document.createElement("div")
  row.className = "suggestion"

  const main = document.createElement("span")
  main.className = "sugg-main"

  if (item.systemId || item.actionId) {
    const cmd = document.createElement("span")
    cmd.className = "sugg-slash"
    cmd.textContent = item.slash || null
    main.appendChild(cmd)
  } else if (item.raw) {
    const raw = document.createElement("span")
    raw.className = "sugg-raw"
    raw.textContent = item.raw || null
    main.appendChild(raw)
  } else {
    // Friendly name first, then the pubkey-id, then the instance id for sessions.
    if (item.petname) {
      const pet = document.createElement("span")
      pet.className = "sugg-pet"
      pet.textContent = item.petname ?? null
      main.appendChild(pet)
    }
    const napp = document.createElement("span")
    napp.className = "sugg-napp"
    napp.textContent = item.nappId || null
    main.appendChild(napp)
    if (item.instanceId) {
      const id = document.createElement("span")
      id.className = "sugg-id"
      id.textContent = item.instanceId.slice(0, 8)
      main.appendChild(id)
    }
  }

  const source = document.createElement("span")
  source.className = "source"
  source.textContent = item.source
  row.append(main, source)

  row.addEventListener("mousedown", async (e: MouseEvent) => {
    e.preventDefault()
    const label = itemPreferredValue(item)
    hideSuggestions()
    try {
      if (item.systemId) {
        const win = launchSystemNapp(item.systemId)
        win?.focus?.()
      } else if (item.actionId) {
        actionRegistry[item.actionId]?.run(systemCtx)
      } else if (item.instanceId) {
        await launchSession(item.instanceId)
      } else if (item.nappId) {
        const win = await launch(stage, item.nappId, {
          ...makeLaunchOpts(),
          petname: item.petname && item.petname !== item.nappId ? item.petname : item.nappId
        })
        syncDOM(win)
        win.focus()
      } else if (item.raw) {
        const nappId = await install(item.raw)
        const win = await launch(stage, nappId, {
          ...makeLaunchOpts(),
          petname: friendlyNameFor(nappId)
        })
        syncDOM(win)
        win.focus()
      }
      setStatus(`Launched ${label}`)
      input!.value = ""
    } catch (err: any) {
      setStatus(`Error: ${err.message}`)
      console.error(err)
    }
  })
  return row
}

async function launchSession(instanceId: string) {
  const session = persist.readOpen().find(s => s.instanceId === instanceId)
  if (!session) throw new Error("Session not found")
  console.debug("[launch] launchSession", {
    instanceId,
    nappId: session.nappId,
    petname: session.petname
  })
  if (focusInstance(instanceId)) return
  const win = await launch(stage, session.nappId, {
    ...makeLaunchOpts(),
    instanceId: session.instanceId,
    petname: session.petname,
    position: session.position,
    status: session.status,
    params: session.params
  })
  syncDOM(win)
  win.focus()
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function showSuggestions() {
  renderSuggestions()
  suggestions.hidden = false
}

function hideSuggestions() {
  suggestions.hidden = true
}

input!.addEventListener("focus", showSuggestions)
input!.addEventListener("input", () => {
  if (!suggestions.hidden) renderSuggestions()
  else showSuggestions()
})
input!.addEventListener("blur", () => {
  setTimeout(hideSuggestions, 150)
})
input!.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") hideSuggestions()
})

function refreshSuggestions() {
  if (!suggestions.hidden) renderSuggestions()
  notifyAppsChanged()
}

function bringToTopOfStack(root: HTMLElement) {
  if (!root || !stage.contains(root)) return
  if (stage.firstElementChild === root) return
  stage.insertBefore(root, stage.firstElementChild)
}

function persistDomOrder() {
  const ordered = Array.from(stage.children)
    .filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.classList?.contains("napp-window")
    )
    .map(el => (el as HTMLElement).dataset.instanceId)
    .filter((id): id is string => typeof id === "string")
  if (ordered.length === 0) return
  const open2 = persist.readOpen()
  const byId = new Map<string, any>(open2.map((s: any) => [s.instanceId, s]))
  const nextOrder = []
  const used = new Set()
  for (const id of ordered) {
    const s = byId.get(id)
    if (s) {
      // system napps aren't in `open`, so they get filtered here automatically
      nextOrder.push(s)
      used.add(id)
    }
  }
  for (const s of open2) {
    if (!used.has(s.instanceId)) nextOrder.push(s)
  }
  persist.writeOpen(nextOrder)
}

function makeLaunchOpts() {
  return {
    onProgress: setStatus,
    onStateChange: (state: NappWindowState) => {
      persist.updateOpen(state.instanceId, state)
      if (state.petname) persist.setInstalledPetname(state.nappId, state.petname)
      refreshSuggestions()
      maybeRepack()
    },
    onReorder: persistDomOrder,
    onClose: (instanceId: string) => {
      persist.removeOpen(instanceId)
      refreshSuggestions()
    },
    onDestroy: (instanceId: string) => {
      const entry = persist.readOpen().find(s => s.instanceId === instanceId)
      persist.removeOpen(instanceId)
      if (entry?.nappId) {
        const stillUsed = persist.readOpen().some(s => s.nappId === entry.nappId)
        if (!stillUsed && !uninstallingNapps.has(entry.nappId)) {
          // Wipe the napp's origin storage (IDB, localStorage, caches, SW)
          // so re-installing it later starts from a clean slate.
          finalizeNappRemoval(entry.nappId, "Wiping")
            .then(() => {})
            .catch(err => setStatus(`Wipe error: ${err.message}`))
        }
      }
      refreshSuggestions()
    }
  }
}

async function restoreAll() {
  console.debug("[launch] restoreAll — restoring", {
    sessionCount: persist.readOpen().length
  })
  for (const state of persist.readOpen()) {
    try {
      if (state.system && state.systemId) {
        const def = systemRegistry[state.systemId]
        if (!def) continue
        const win = launchSystem(stage, state.systemId, def, systemCtx, {
          ...makeSystemLaunchOpts(state.systemId),
          instanceId: state.instanceId,
          params: state.params,
          position: state.position,
          status: state.status
        })!
        persist.updateOpen(state.instanceId, {
          ...win.getState(),
          system: true,
          systemId: state.systemId
        })
        continue
      }
      const win = await launch(stage, state.nappId, {
        ...makeLaunchOpts(),
        instanceId: state.instanceId,
        petname: state.petname,
        params: state.params,
        position: state.position,
        status: state.status
      })
      const restoredState = win.getState()
      persist.updateOpen(state.instanceId, restoredState)
      void replayLoadedActions(restoredState.instanceId).catch((err: any) => {
        console.warn("[launch] replayLoadedActions failed", {
          instanceId: restoredState.instanceId,
          err
        })
      })
    } catch (err: any) {
      setStatus(`Failed to restore ${state.nappId}: ${err.message}`)
    }
  }
}

const BOOTSTRAP_KEY = "nostrapps:bootstrapped"
function maybeBootstrap() {
  if (localStorage.getItem(BOOTSTRAP_KEY)) return
  // First ever load: open every system napp once. After this, the user's
  // open/closed state is the source of truth.
  for (const def of systemList) {
    try {
      launchSystemNapp(def.id)
    } catch (err: any) {
      console.warn(`bootstrap ${def.id}:`, err)
    }
  }
  localStorage.setItem(BOOTSTRAP_KEY, "1")
}

async function init() {
  setStatus(
    "Ready — try /apps, /database, /upload, /settings, /logs, /folder, or enter a pubkey/npub/nsite host"
  )
  handlers.setActionDispatcher(runNappAction)
  // If the user is paired with a bunker, get the connection warm in the
  // background. First sign request will wait if it's still connecting.
  reconnectIfNeeded().catch(err => setStatus(`Bunker reconnect failed: ${err.message}`))
  await handlers.init()
  // Bump instanceIdSerial past any existing numeric instanceIds so new
  // windows don't collide with persisted entries.
  let maxId = 0
  for (const s of persist.readOpen()) {
    const n = parseInt(s.instanceId, 10)
    if (!isNaN(n) && n > maxId) maxId = n
  }
  setInstanceIdSerial(maxId + 1)
  await restoreAll()
  maybeBootstrap()
  // Restore doesn't fire onStateChange — kick the packer manually so a
  // session that resumed in pack mode lands cleanly.
  if (packModeOn) maybeRepack()
  broadcastTheme()
}
init()

async function install(raw: string): Promise<string> {
  let resolved
  try {
    resolved = resolveInput(raw)
    console.debug("[install] input resolved", { raw, resolved })
  } catch {
    console.debug("[install] input could not be resolved", { raw })
    throw new Error(
      `Couldn't resolve "${raw}" — try a pubkey, npub, nprofile, naddr, or nsite hostname`
    )
  }

  const { nappId, files, title, manifest } = await fetchNsite(resolved, setStatus)
  console.debug("[install] nsite fetched", {
    nappId,
    title,
    fileCount: files.length,
    hasManifest: !!manifest
  })
  const dTag = manifest?.tags.find((t: any) => t[0] === "d")?.[1]
  const petname = title || dTag || raw
  console.debug("[install] installing napp with opts", { nappId, petname })

  const origin = nappOriginFor(nappId)
  const onProgress = setStatus
  const label = title || nappId

  console.debug("[sandbox] install", { nappId, label, origin })
  onProgress(`Booting ${label}…`)
  await bootNapp(origin, files, onProgress, label)

  if (manifest) persist.storeInstalledEvent(manifest, petname)
  handlers.addApp(nappId, capabilitiesFromEvent(manifest))

  return nappId
}

async function installDevApp() {
  try {
    setStatus("Pick directory with metadata.json…")
    const dirHandle = await window.showDirectoryPicker!()
    setStatus("Reading metadata.json…")
    const metaFileHandle = await dirHandle.getFileHandle("metadata.json")
    const metaFile = await metaFileHandle.getFile()
    const metadata = JSON.parse(await metaFile.text())

    if (!metadata?.id) throw new Error("metadata.json must contain an .id field")

    const nappId = `dev~${slug(metadata.id)}`
    const origin = nappOriginFor(nappId)
    const onProgress = setStatus
    const label = metadata.title || nappId
    const petname = metadata.title || nappId

    setStatus(`Booting dev ${label}…`)
    await bootDevApp(origin, nappId, onProgress, label)

    setDevHandle(nappId, dirHandle)

    persist.storeDevApp({
      nappId,
      title: metadata.title || null,
      icon: metadata.icon || null,
      petname,
      actions: metadata.actions || [],
      singleton: metadata.singleton
    })
    handlers.addApp(nappId, metadata.actions || [])

    const win = await launch(stage, nappId, {
      ...makeLaunchOpts(),
      petname
    })
    syncDOM(win)
    win.focus()
    setStatus(`Launched dev ${petname}`)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    console.error(err)
  }
}

async function launchFromInput(raw: string): Promise<void> {
  console.debug("[launch] launchFromInput", { raw })

  // Slash commands → system napps or one-shot actions
  if (raw.startsWith("/")) {
    const sysId = slashCommands[raw]
    if (sysId) {
      console.debug("[launch] slash command → system napp", { sysId })
      const win = launchSystemNapp(sysId)
      win?.focus?.()
      return
    }
    const actionId = slashActions[raw]
    if (actionId) {
      console.debug("[launch] slash command → action", { actionId })
      actionRegistry[actionId]?.run(systemCtx)
      return
    }
    console.debug("[launch] unknown slash command", { raw })
    throw new Error(`Unknown command: ${raw}`)
  }

  const existing = persist.findSessionByPetname(raw)
  if (existing) {
    if (focusInstance(existing.instanceId)) {
      console.debug("[launch] session already open, focused", {
        raw,
        instanceId: existing.instanceId
      })
      setStatus(`${raw} is already open`)
      refreshSuggestions()
      return
    }
    console.debug("[launch] restoring session by petname", {
      raw,
      nappId: existing.nappId,
      instanceId: existing.instanceId,
      petname: existing.petname
    })

    const win = await launch(stage, existing.nappId, {
      ...makeLaunchOpts(),
      instanceId: existing.instanceId,
      petname: existing.petname,
      position: existing.position,
      status: existing.status,
      params: existing.params
    })
    syncDOM(win)
    win.focus()
    return
  }

  const petNappId = persist.getNappIdForPetname(raw)
  if (petNappId) {
    console.debug("[launch] petname maps to known nappId, restoring fresh", {
      raw,
      nappId: petNappId
    })
    const win = await launch(stage, petNappId, {
      ...makeLaunchOpts(),
      petname: raw
    })
    syncDOM(win)
    win.focus()
    return
  }

  const known = new Set(persist.getInstalledNappIds())
  if (known.has(raw)) {
    console.debug("[launch] raw matches known nappId, restoring fresh", { raw })
    const win = await launch(stage, raw, {
      ...makeLaunchOpts(),
      petname: raw
    })
    syncDOM(win)
    win.focus()
    return
  }

  // ── temp install: show loading window immediately ──
  const suffix = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9._~-]/g, "-")
  const nappId = `temp~${suffix}`
  const petname = friendlyNameFor(nappId)

  const win = mountWithLoading(stage, nappId, nappOriginFor(nappId), {
    petname,
    ...makeLaunchOpts()
  })
  syncDOM(win)
  win.focus()

  try {
    const resolved = resolveInput(raw)
    const { files, title, manifest, singleton } = await fetchNsite(resolved, setStatus)
    const label = title || nappId
    const origin = nappOriginFor(nappId)

    if (title) win.titleEl.textContent = title

    setTempFiles(nappId, files)
    setStatus(`Booting temp ${label}…`)
    await bootDevApp(origin, nappId, setStatus, label)

    win.setIframe(`${origin}/`)

    persist.storeDevApp({
      nappId,
      title: title || null,
      icon: manifest?.tags.find((t: any) => t[0] === "icon")?.[1] || null,
      petname: title || resolved.dTag || nappId,
      actions: capabilitiesFromEvent(manifest),
      singleton
    })
    handlers.addApp(nappId, capabilitiesFromEvent(manifest))
    input!.value = ""
  } catch (err: any) {
    win.destroy()
    throw err
  }
}

form.addEventListener("submit", async (e: SubmitEvent) => {
  e.preventDefault()
  hideSuggestions()
  const raw = input!.value.trim()
  if (!raw) return
  try {
    await launchFromInput(raw)
    setStatus(`Launched ${raw}`)
    input!.value = ""
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    console.error(err)
  }
})

localFolderInput.addEventListener("change", async (e: Event) => {
  const inputFiles = (e.target as HTMLInputElement).files
  if (!inputFiles || inputFiles.length === 0) return
  console.debug("[launch] local folder selected", { fileCount: inputFiles.length })
  try {
    const { nappId, files, metadata } = await collectLocalFolder(inputFiles!, setStatus)
    console.debug("[launch] local folder collected", { nappId, fileCount: files.length, metadata })

    // install(), but from local, not fetching an nsite
    const origin = nappOriginFor(nappId)
    const onProgress = setStatus
    const label = metadata.title || nappId
    console.debug("[sandbox] install", { nappId, label, origin })
    setStatus(`Booting ${label}…`)
    await bootNapp(origin, files, onProgress, label)

    const petname = metadata?.title || nappId

    persist.storeInstalledLocalApp({
      nappId,
      title: metadata?.title || null,
      icon: metadata?.icon || null,
      petname,
      actions: metadata?.actions || [],
      singleton: metadata.singleton
    })
    handlers.addApp(nappId, metadata?.actions || [])

    const win = await launch(stage, nappId, {
      ...makeLaunchOpts(),
      petname
    })
    syncDOM(win)
    win.focus()
    setStatus(`Launched ${petname}`)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    console.error(err)
  } finally {
    ;(e.target as HTMLInputElement).value = ""
  }
})

function syncDOM(win: NappWindow) {
  bringToTopOfStack(win.root)
  persistDomOrder()
  refreshSuggestions()
}
