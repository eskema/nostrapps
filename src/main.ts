import "@fontsource-variable/source-sans-3"
import "@fontsource-variable/source-sans-3/wght-italic.css"
import "@fontsource-variable/source-serif-4"
import "@fontsource-variable/source-serif-4/wght-italic.css"
import "@fontsource-variable/source-code-pro"
import {
  launch as launchNsite,
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
  setStageSettling,
  broadcastTheme,
  nappOriginFor,
  bootNapp,
  bootDevApp,
  setDevHandle,
  setDevUrl,
  setTempFiles,
  removeDevHandle,
  setInstanceIdSerial,
  teardownSpaceWindows,
  listOpenWindows,
  setActiveSpace,
  isWindowInactive,
  moveWindowToSpace,
  markPackNew,
  placeInFreeSpot,
  hasOpenWindow,
  allInstanceIds,
  spaceOfLiveSystem,
  findOpenWindowByNappId,
  loadEvent,
  resolveViewPayload,
  applyNappPolicy,
  closeNappletSubs,
  launchNapplet,
  reloadNappletWindows,
  syncStageBottomSpacer,
  getStageBounds,
  readNappFiles
} from "./sandbox/host.js"
import { button, chip, icon, tab } from "./system-napps/ui.js"
import { promptNappPolicy, promptSharedSpace } from "./napp-permissions.js"
import {
  buildShareLink,
  decodePayload,
  encodePayload,
  parseShareLink,
  type LinkAction,
  type ShareLink
} from "./share-link.js"
import { resolveInput } from "./nsite/resolve.js"
import { isInstanceSerial } from "./utils.js"
import { fetchNsite, manifestRelays, blobServers, manifestPaths } from "./nsite/fetch.js"
import { ensureReplicatedAll, type ReplicationTarget } from "./nsite/heal.js"
import { openShareDialog, type ShareCheck, type ShareWindow } from "./share-dialog.js"
import { resolveNapplet, isNappletKind, loadNappletFromManifest } from "./nsite/napplet.js"
import { collectLocalFolder, slug } from "./nsite/local.js"
import {
  directIconSrc,
  iconBlobFrom,
  iconBlobFromDir,
  installedIconSrc,
  installedIconSources
} from "./nsite/icon.js"
import { currentSigner, reconnectIfNeeded } from "./signers/index.js"
import { connectBunkerInput, disconnectBunkerSigner } from "./signers/nip46.js"
import { googleLoginAndCreateBunker } from "./signers/google.js"
import * as account from "./account.js"
import { clearDecisions } from "./permissions.js"
import { openPopover } from "./popover.js"
import { setPointer, getPointer } from "./pointer.js"
import { moveBefore } from "./dom.js"
import { buildHandlerBody } from "./system-napps/handler.js"
import * as persist from "./persistence.js"
import * as handlers from "./handlers.js"
import type {
  SuggestionItem,
  NsiteResult,
  NsiteFile,
  NappWindowState,
  NappPolicy,
  SystemCtx,
  NappWindow,
  LaunchOpts,
  InstalledApp,
  Position
} from "./types.js"
import {
  registry as systemRegistry,
  slashCommands,
  list as systemList,
  actionRegistry,
  slashActions,
  actionList
} from "./system-napps/index.js"
import { pool } from "@nostr/gadgets/global"
import { bareNostrUser, loadNostrUser } from "@nostr/gadgets/metadata"
import { EventTemplate } from "@nostr/tools"
import type { NostrEvent } from "@nostr/tools/pure"
import { naddrEncode } from "@nostr/tools/nip19"
import * as relayAuth from "./relay-auth.js"
import { buildUserIndex } from "./user-search.js"

pool.trackRelays = true
// gadgets' list fetchers (lists.ts) fill their relay set with
// randomPick(hardcodedRelays), and every loader except kind 3 and 10002 is
// built with an EMPTY hardcoded list — `serial++ % 0` is NaN, so the pick is
// `undefined` and three of them get pushed per request. Those reach the pool
// as the literal string "undefined" and each opens a doomed wss://undefined/
// socket. Drop those before they become connections; this also catches any
// other junk relay hint that reaches us.
const relayAllowed = pool.allowConnectingToRelay
pool.allowConnectingToRelay = (url, operation) => {
  // Only the host is checked, and only for junk: subscribeMap does NOT
  // normalize, and a legitimate fallback arrives here bare ("relay.damus.io"),
  // so requiring a scheme would silently disable those.
  const host = typeof url === "string" ? url.replace(/^wss?:\/\//, "").split(/[/?#]/)[0] : ""
  if (!host || host === "undefined" || host === "null") return false
  return relayAllowed ? relayAllowed(url, operation) : true
}
pool.automaticallyAuth = () => {
  // A signer is handed back even when auto-auth is off: returning non-null is
  // what routes challenges to us at all, and the wrapper then decides per
  // challenge — auto mode signs everything; otherwise a stored per-relay
  // decision is honored or a confirmation toast is shown and remembered.
  if (!currentSigner()) return null
  return relayAuth.relayAuthSigner()
}

const stage = document.getElementById("stage")!
const form = document.getElementById("launch-form")!
const input = document.getElementById("nsite-input") as HTMLInputElement
const suggestions = document.getElementById("suggestions")!
const localFolderInput = document.getElementById("local-folder") as HTMLInputElement
const tileBtn = document.getElementById("tile-windows")!
const packToggleBtn = document.getElementById("pack-toggle")!
const spacesBar = document.getElementById("spaces-bar")!
// Swap the placeholder glyphs for consistent SVG icons.
tileBtn.replaceChildren(icon("tile"))

tileBtn?.addEventListener("click", () => tileWindows(stage))

// ─── spaces (saved window configurations) ──────────────────────
// The live window set lives in persistence's `open`; each space owns its own
// `open` snapshot. currentSpaceId tracks which we're showing.
let currentSpaceId = persist.getCurrentSpaceId()
// Spaces whose windows are mounted in this session. Switching to a space the
// first time mounts its windows; after that we just toggle visibility, so the
// windows (and their iframe state) survive switches.
const materializedSpaces = new Set<string>()

// ─── pack mode (Packery-style auto-layout on move/resize) ───────
// Pack mode is per-space, stored in the spaces document (space.packMode).
let packModeOn = persist.getSpacePackMode(currentSpaceId)

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
    // packModeOn is read again here, not just at schedule time: a space switch in
    // between (moving a window out of a packed space into a freeform one) would
    // otherwise land this pack on the space we arrived in and flatten a layout
    // that was never meant to be packed.
    if (!packModeOn) return
    repackInProgress = true
    try {
      bestFitPack(stage)
    } finally {
      repackInProgress = false
    }
  })
}

function applyPackMode() {
  // Distinct glyph per state: a 4-quadrant grid when active, the pack-corners
  // hint when off (opacity alone wasn't a clear enough signal).
  packToggleBtn?.replaceChildren(icon(packModeOn ? "grid" : "pack"))
  // The tooltip names the mode the click switches TO, not the current one.
  const packLabel = packModeOn ? "free mode" : "grid mode"
  packToggleBtn?.setAttribute("title", packLabel)
  packToggleBtn?.setAttribute("aria-label", packLabel)
  // The drag handler (in napp-window.js) reads this class to decide
  // whether to render a drop placeholder during the drag.
  stage?.classList.toggle("pack-mode", packModeOn)
  persist.setSpacePackMode(currentSpaceId, packModeOn)
  if (packModeOn) maybeRepack()
}

packToggleBtn?.addEventListener("click", () => {
  packModeOn = !packModeOn
  applyPackMode()
})

applyPackMode()

// Feed the launcher's own cursor into the shared pointer store (cursor-anchored
// UI like the action-handler popover reads it). Napp-dispatched actions instead
// carry the in-iframe pointer, converted to screen coords in host.ts.
window.addEventListener("pointermove", e => setPointer(e.clientX, e.clientY), { passive: true })

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

// Header theme toggle — a single button that cycles light → dark → auto, showing
// the current state with the same glyphs as the Settings theme row. (Experiment;
// Settings still has the full switcher.)
const THEME_CYCLE = ["light", "dark", "auto"]
// Only ☀ defaults to a wide color emoji, so it gets the text-presentation
// selector (\uFE0E) to stay monochrome; ☾/◐ are already plain glyphs.
const THEME_GLYPH: Record<string, string> = {
  light: "☀︎",
  dark: "☾",
  auto: "◐"
}
const themeToggleBtn = document.getElementById("theme-toggle")!
function renderThemeToggle(choice: string) {
  themeToggleBtn.textContent = THEME_GLYPH[choice] || THEME_GLYPH.auto
  themeToggleBtn.title = `Theme: ${choice}`
}
themeToggleBtn.addEventListener("click", () => {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme.get()) + 1) % THEME_CYCLE.length]
  theme.set(next)
})
renderThemeToggle(theme.get())
theme.subscribe(renderThemeToggle)

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
  persist.clearPolicy(nappId)
  persist.clearNappletStorage(nappId)
  persist.clearNappletConfig(nappId)
  persist.forgetWindowSize(nappId)
  closeNappletSubs(nappId)
  handlers.removeApp(nappId)
  removeDevHandle(nappId)
  setStatus(`${actionLabel} ${nappId}…`)
  try {
    await wipe(nappId)
    persist.forgetEphemeralOrigin(nappId) // origin is clean; nothing left to sweep
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
  const wasInstalled = !!persist.getInstalledApp(nappId)
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

// NIP-5D capability domains declared in a manifest (["requires", "<domain>"]).
// Declaring any marks the app as a napplet — the host only performs the NAP
// shell handshake for apps that asked for the seam.
function requiresFromEvent(event: { tags: string[][] } | null | undefined): string[] {
  if (!event) return []
  const domains = []
  for (const t of event.tags) {
    if (t[0] === "requires" && typeof t[1] === "string" && t[1]) {
      domains.push(t[1])
    }
  }
  return domains
}

// Update flow: re-fetch the manifest + files at the same target, swap them
// into the napp's existing origin storage (no new window), persist the new
// version, and force any open iframes to reload so they pick up new files.
async function updateNapp(target: {
  pubkey: string
  dTag: string
  relayHints: string[]
  kind?: number
}) {
  if (!target?.pubkey) throw new Error("updateNapp: missing pubkey")
  console.debug("[launch] updateNapp", {
    pubkey: target.pubkey,
    dTag: target.dTag,
    relayHints: target.relayHints
  })
  if (target.kind != null && isNappletKind(target.kind)) return updateNapplet(target)
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

// Napplet update: re-resolve + re-verify the newest manifest, store it, and
// swap open windows onto the new bytes (srcdoc is baked at launch, so this
// rebuilds it rather than reloading).
async function updateNapplet(target: {
  pubkey: string
  dTag: string
  relayHints: string[]
  kind?: number
}) {
  setStatus(`Checking update…`)
  const resolved = await resolveNapplet({ ...target, kind: target.kind! }, setStatus)
  const nappId = persist.computeNappId(resolved.manifest)
  const label = resolved.title || resolved.dTag
  setStatus(`Updating ${label}…`)
  persist.storeInstalledEvent(resolved.manifest)
  const reloaded = reloadNappletWindows(nappId, resolved.html)
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
  options?: { instance?: string; auxiliary?: boolean }
) {
  if (typeof name !== "string" || !name) {
    throw new Error("napp.action: action name is required")
  }

  const auxiliary = !!options?.auxiliary
  let auxWin: NappWindow | null = null

  let instanceId = options?.instance
  if (!instanceId) {
    // no instance specified, will open a new window, often prompting the user first
    const [candidates, openCandidates] = handlers.findHandlersForAction(name, { auxiliary })
    try {
      const [nappId, existingInstanceId] =
        candidates.length + openCandidates.length === 1
          ? [candidates[0], undefined]
          : await pickHandler(callerNappId, name, payload, candidates, openCandidates)

      // the user may have picked an existing window.
      // if not, open a new window here and get its id
      if (existingInstanceId) {
        instanceId = existingInstanceId
      } else if (auxiliary) {
        // Ephemeral floating window at the cursor, sized from the app's
        // `initial_size` metadata. Never persisted; closed on response below.
        auxWin = await launchAuxiliary(nappId)
        syncDOM(auxWin)
        auxWin.focus()
        instanceId = auxWin.getState().instanceId
      } else {
        const win = await launch(stage, nappId, {
          ...makeLaunchOpts(),
          petname: friendlyNameFor(nappId)
        })
        // Match the other launch paths: register DOM order and (in pack mode) fold the
        // new window into the grid. Without this an action-launched window stays at its
        // free-floating launch coordinates instead of being packed.
        syncDOM(win)
        maybeRepack()
        instanceId = win.getState().instanceId
      }
      setStatus(
        `Action "${name}" ${friendlyNameFor(callerNappId)} → ${friendlyNameFor(nappId)}, ${JSON.stringify(payload)}`
      )
    } catch (err) {
      console.warn(err)
      setStatus(String(err))
      return
    }
  }

  try {
    // actually call the instance (auxiliary windows are ephemeral — nothing
    // to replay on restore, so don't record the action)
    if (!auxWin) persist.appendLoadedAction(instanceId, name, payload)
    const result = await callIframe(instanceId, name, payload)

    if (result) {
      setStatus(`Action "${name}" result: ${JSON.stringify(result)}`)
    }

    return result
  } finally {
    // Auxiliary windows close as soon as the action answers (or fails).
    auxWin?.close()
  }
}

// Launch an ephemeral auxiliary window: cursor-anchored, sized from the
// app's `initial_size` metadata, and never written to localStorage (the
// transient flag skips singleton reuse + persistence in host.launch, and
// these opts never call persist.updateOpen).
async function launchAuxiliary(nappId: string): Promise<NappWindow> {
  const size = persist.getInstalledApp(nappId)?.initialSize
  const width = Math.max(240, Math.min(800, Math.round(size?.width ?? 360)))
  const height = Math.max(200, Math.min(1200, Math.round(size?.height ?? 420)))
  const pointer = getPointer()
  const pad = 8
  const left = Math.max(pad, Math.min(pointer.x, window.innerWidth - width - pad))
  const top = Math.max(pad, Math.min(pointer.y, window.innerHeight - height - pad))
  const position = { left, top, width, height }

  if (nappId.startsWith("napplet~")) {
    const win = await launchInstalledNapplet(
      nappId,
      { petname: friendlyNameFor(nappId), position },
      makeEphemeralLaunchOpts()
    )
    if (!win) throw new Error(`napplet ${nappId} could not be launched — its manifest is gone`)
    return win
  }
  return launch(stage, nappId, {
    ...makeEphemeralLaunchOpts(),
    petname: friendlyNameFor(nappId),
    position,
    transient: true
  })
}

function makeEphemeralLaunchOpts() {
  return {
    onProgress: setStatus,
    // Transient (e.g. the handler picker): don't persist it, but still
    // re-pack on move/resize so pack mode keeps it constrained to the grid.
    onStateChange: () => maybeRepack(),
    onReorder: persistDomOrder,
    onClose: () => refreshSuggestions()
  }
}

async function replayLoadedActions(instanceId: string) {
  for (const action of persist.getLoadedActions(instanceId)) {
    await callIframe(instanceId, action.name, action.payload)
  }
}

async function pickHandler(
  callerNappId: string,
  actionName: string,
  payload: unknown,
  candidates: string[],
  openCandidates: NappWindowState[]
): Promise<[nappId: string, instanceId: string | undefined]> {
  if (actionName.startsWith("view:") && typeof payload === "string") {
    const event = await resolveViewPayload(payload)
    if (event) payload = event
    else throw new Error(`Stopped routing of ${actionName}->${payload}: couldn't find event`)
  }

  if (candidates.length === 0) {
    setStatus(`No handler for action "${actionName}" from ${friendlyNameFor(callerNappId)}`)
  }

  const pointer = getPointer()
  const choice = await openPopover<[string, string | undefined] | null>({
    x: pointer.x,
    y: pointer.y,
    class: "handler-popover",
    build: resolve =>
      buildHandlerBody({
        actionName,
        payload,
        candidates,
        openCandidates,
        apps: {
          list: () => persist.getInstalledApps(),
          get: (nappId: string) => persist.getInstalledApp(nappId)
        },
        onSelect: (nappId, instanceId) => {
          if (candidates.includes(nappId)) resolve([nappId, instanceId])
        }
      }),
    dismissValue: null // click outside / Esc cancels
  })

  if (!choice) throw new Error("Action handler selection cancelled")
  return choice
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
    get(nappId: string) {
      return persist.getInstalledApp(nappId)
    },
    list() {
      return persist.getInstalledApps()
    },
    subscribe(fn: () => void) {
      appSubs.add(fn)
      return () => appSubs.delete(fn)
    }
  },
  theme,
  logs,
  relayAuth: {
    getAuto: () => relayAuth.automaticallyAuthOn(),
    setAuto: (on: boolean) => relayAuth.setAutomaticallyAuth(on),
    decisions: () => relayAuth.listRelayDecisions(),
    forget: (url: string) => relayAuth.forgetRelayDecision(url),
    subscribe: (fn: () => void) => relayAuth.subscribe(fn)
  },
  connect,
  connectBunker,
  connectGoogle,
  disconnect,
  factoryReset,
  loadFolder,
  setStatus,
  installDevApp,
  installDevAppFromUrl,
  launchSystemNapp,
  launchNapp: async (nappId: string, petname?: string) => {
    const win = await launch(stage, nappId, {
      ...makeLaunchOpts(),
      petname: petname || friendlyNameFor(nappId)
    })
    syncDOM(win)
    win.focus()
  },
  // Use a thunk so the reference resolves to the function declared later.
  isInstalled: (nappId: string) => !!persist.getInstalledApp(nappId),
  wasInstalled: (nappId: string) => !!persist.getInstalledApp(nappId),
  install: (raw: string) => install(raw),
  uninstall: (nappId: string) => uninstall(nappId),
  editPermissions: (nappId: string) => editPermissions(nappId),
  update: (target: { pubkey: string; dTag: string; relayHints: string[] }) => updateNapp(target)
}

// Re-open the permission screen for an already-installed napp, then write the
// new policy into its origin and reload its windows so the CSP takes effect.
async function editPermissions(nappId: string) {
  const app = persist.getInstalledApp(nappId)
  if (!app) return
  const declared = new Set<string>()
  for (const t of app.event?.tags ?? []) {
    if (t[0] === "requires" && typeof t[1] === "string" && t[1]) declared.add(t[1])
  }
  for (const d of app.requires ?? []) declared.add(d)

  const type = nappId.startsWith("napplet~")
    ? "napplet"
    : app.event
      ? manifestAppType(app.event)
      : metaAppType(app)
  const policy = await promptNappPolicy({
    title: app.petname || app.title || nappId,
    icon: installedIconSrc(app),
    type,
    declaredDomains: [...declared],
    current: persist.getPolicy(nappId),
    mode: "edit"
  })
  if (!policy) return
  persist.setPolicy(nappId, policy)
  try {
    await applyNappPolicy(nappOriginFor(nappId), nappId)
    setStatus(`Updated permissions for ${app.petname || nappId}`)
  } catch (err: any) {
    setStatus(`Couldn't apply permissions: ${err?.message || String(err)}`)
  }
}

function makeSystemLaunchOpts(sysId: string) {
  return {
    onStateChange: (state: NappWindowState) => {
      if (isWindowInactive(state.instanceId)) return // background-space window
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
        // Transient (e.g. the handler picker): don't persist it, but still
        // re-pack on move/resize so pack mode keeps it constrained to the grid.
        onStateChange: () => maybeRepack(),
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
  // Fold the new system window into the grid when pack mode is on (fresh launches
  // don't fire onStateChange, so maybeRepack wouldn't run otherwise).
  maybeRepack()
  return win
}

// Which space "owns" a system napp — where it's live, else its persisted
// placement. A system napp is a single instance, so it lives in one space.
function ownerSpaceOfSystem(sysId: string): string | null {
  return spaceOfLiveSystem(sysId) ?? persist.findSpaceOfSystemNapp(sysId)
}

// Top-level invocation (slash command, suggestion): if the system napp already
// lives in another space, switch there and focus it instead of duplicating or
// moving it; otherwise open/focus it in the current space.
async function invokeSystemNapp(sysId: string) {
  const owner = ownerSpaceOfSystem(sysId)
  if (owner && owner !== currentSpaceId) {
    await switchSpace(owner)
    renderSpacesBar()
  }
  const win = launchSystemNapp(sysId)
  win?.focus?.()
  return win
}

// ─── suggestions ────────────────────────────────────────────────
// The dropdown is a long-lived list changed in place: one row per item, built
// once and kept (rows), so a change touches only the rows it concerns — a
// window opening or closing, an app installed or updated, an author's name
// landing. Typing filters by toggling rows. Nothing here rebuilds the list.

// Three sections, each a container kept in the DOM, with a divider between
// consecutive non-empty ones (see applyFilter):
//   1. System items (slash commands and slash actions) — discoverability.
//   2. Open windows across ALL spaces (current space first), a global switcher.
//   3. Installed apps, alphabetical by friendly name.
type Section = "system" | "open" | "apps"
const suggSections: Record<Section, HTMLDivElement> = {
  system: document.createElement("div"),
  open: document.createElement("div"),
  apps: document.createElement("div")
}
const suggDividers = [document.createElement("div"), document.createElement("div")]
for (const d of suggDividers) d.className = "sugg-divider"
suggestions.append(
  suggSections.system,
  suggDividers[0],
  suggSections.open,
  suggDividers[1],
  suggSections.apps
)

type Row = {
  item: SuggestionItem
  el: HTMLDivElement
  sig: string // what the row was built from — a change means a rebuild
  base: string // the searchable text, minus the author's name
  search: string
  nameEl: HTMLElement | null // the author's name, patched when it lands
}
const rows = new Map<string, Row>()

const itemKey = (item: SuggestionItem) =>
  item.systemId
    ? `sys:${item.systemId}`
    : item.actionId
      ? `act:${item.actionId}`
      : item.instanceId
        ? `sess:${item.instanceId}`
        : `napp:${item.nappId}`

const sectionOf = (item: SuggestionItem): Section =>
  item.source === "system" || item.source === "action"
    ? "system"
    : item.source === "open"
      ? "open"
      : "apps"

// Everything a row is built from. spaceCurrent is left out: it's a class
// toggled in place (a space switch would otherwise rebuild every open row).
const itemSig = (item: SuggestionItem) =>
  [
    item.petname,
    item.slash,
    item.appType,
    item.author,
    item.authorLabel,
    item.iconKey,
    item.spaceId,
    item.spaceName
  ].join(" ")

function buildSuggestionItems(): SuggestionItem[] {
  const seen = new Set()
  const out: SuggestionItem[] = []

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

  // Open windows across ALL spaces — a global switcher. Current space first so
  // its windows lead the list; others follow, each tagged with their space.
  const allWindows = persist.allOpenWindows()
  allWindows.sort(
    (a, b) => (a.spaceId === currentSpaceId ? 0 : 1) - (b.spaceId === currentSpaceId ? 0 : 1)
  )
  const allSessions = allWindows.map(a => a.window)
  // One read of the installed set for the whole build: each record carries its
  // manifest, so a per-row lookup would re-parse all of them every time.
  const installed = persist.getInstalledApps()
  const byId = new Map(installed.map(a => [a.nappId, a]))

  for (const { spaceId, spaceName, window: s } of allWindows) {
    if (s.system) continue // shown via systemList row instead
    const key = `sess:${s.instanceId}`
    if (seen.has(key)) continue
    seen.add(key)
    const customPet = s.petname && s.petname !== s.nappId ? s.petname : null
    const app = byId.get(s.nappId)
    out.push({
      source: "open",
      nappId: s.nappId,
      instanceId: s.instanceId,
      petname: customPet || app?.petname || app?.title || null,
      ...describeApp(app),
      spaceId,
      spaceName,
      spaceCurrent: spaceId === currentSpaceId
    })
  }

  // Every installed app stays launchable, even while open — opening one doesn't
  // remove it from the list, so you can always open another instance. (An open
  // window also appears as its own "open" row above, for jumping to it.)
  for (const app of installed) {
    const key = `napp:${app.nappId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      source: "napp",
      nappId: app.nappId,
      petname: petnameForNappId(app.nappId, allSessions, app),
      ...describeApp(app)
    })
  }

  return out
}

// `app` spares the storage read when the caller already holds the record.
function petnameForNappId(nappId: string, sessions: any[], app?: InstalledApp): string | null {
  // Prefer a petname from any session for this nappId — that's typically the
  // friendliest name (manifest title we set at launch).
  for (const s of sessions) {
    if (s.nappId === nappId && s.petname && s.petname !== nappId) {
      return s.petname
    }
  }
  return (app ?? persist.getInstalledApp(nappId))?.petname || null
}

// What the Apps card shows under an app's title: its icon, and "<type> from
// <author>" — or "<type> · dev/temp/local" when there's no manifest, so no
// publisher.
function describeApp(
  app: InstalledApp | undefined
): Pick<SuggestionItem, "appType" | "icon" | "iconKey" | "author" | "authorLabel"> {
  if (!app) return {}
  const author = app.event?.pubkey || null
  const authorLabel = author
    ? null
    : app.nappId.startsWith("dev~")
      ? "dev"
      : app.nappId.startsWith("temp~")
        ? "temp"
        : "local"
  return {
    appType: persist.classifyInstalled(app),
    icon: iconSrcFor(app, true),
    iconKey: iconKey(app),
    author,
    authorLabel
  }
}

// What the list needs beyond its rows — icons and author names — is fetched
// ahead of it, in the background: at startup, and again when the installed set
// changes (prewarmSuggestions). Opening the list shows what is already in hand;
// the rest patches in as it lands.
//
// The fetching is paced through one queue: a couple of jobs at a time, each
// started only when the main thread is idle and dropped from its slot if it
// overruns, so the fan-out behind a name or an icon (relay connections, the
// signature checks on what comes back, image fetches) never crowds out the
// boot or the user's input. A job wanted for a row on screen moves to the
// front of the line.
type Job = { key: string; run: () => Promise<unknown> }
const queue: Job[] = []
let running = 0
const RUNNING_MAX = 2
const JOB_MAX_MS = 15_000
const idle = () =>
  new Promise<void>(r => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => r(), { timeout: 1000 })
    } else setTimeout(r, 50)
  })
function enqueue(key: string, run: () => Promise<unknown>, front = false) {
  if (front) queue.unshift({ key, run })
  else queue.push({ key, run })
  pump()
}
// Moves a job still waiting in line to the front (for a row now on screen).
function promote(key: string) {
  const at = queue.findIndex(j => j.key === key)
  if (at > 0) queue.unshift(...queue.splice(at, 1))
}
function pump() {
  while (running < RUNNING_MAX && queue.length) {
    running++
    const job = queue.shift()!
    idle()
      .then(() => Promise.race([job.run(), new Promise(r => setTimeout(r, JOB_MAX_MS))]))
      .catch(() => {})
      .then(() => {
        running--
        pump()
      })
  }
}

// Each installed app's icon, probed to the one URL that loads (null: none did);
// the row's <img> then sets a src the browser already holds. The probe images
// are kept so the decoded icons stay cached. Keyed on the manifest version, so
// an update probes afresh (and rebuilds the row, via itemSig).
const iconKey = (app: InstalledApp) => `${app.nappId}\n${app.event?.id || app.icon}`
const iconSrcs = new Map<string, Promise<string | null>>()
const iconProbes = new Map<string, HTMLImageElement>()
const PROBE_MAX_MS = 8_000
function iconSrcFor(app: InstalledApp, front = false): Promise<string | null> {
  const key = iconKey(app)
  let p = iconSrcs.get(key)
  if (p) {
    if (front) promote(`icon:${key}`)
    return p
  }
  p = new Promise<string | null>(resolve => {
    enqueue(
      `icon:${key}`,
      () =>
        installedIconSources(app)
          .then(
            srcs =>
              new Promise<string | null>(done => {
                const img = new Image()
                iconProbes.set(key, img)
                let i = 0
                let timer = 0
                const next = () => {
                  clearTimeout(timer)
                  if (i >= srcs.length) return done(null)
                  img.src = srcs[i++]
                  timer = window.setTimeout(next, PROBE_MAX_MS) // a server that hangs
                }
                img.onload = () => {
                  clearTimeout(timer)
                  done(img.src)
                }
                img.onerror = next
                next()
              })
          )
          .then(resolve, () => resolve(null)),
      front
    )
  })
  iconSrcs.set(key, p)
  return p
}

// Everything the list will need, queued for the background: names first (they
// need relays), then icons. Probes for apps no longer installed (or since
// updated) are dropped.
function prewarmSuggestions() {
  const apps = persist.getInstalledApps()
  const keep = new Set(apps.map(iconKey))
  for (const key of iconSrcs.keys()) {
    if (keep.has(key)) continue
    iconSrcs.delete(key)
    iconProbes.delete(key)
  }
  for (const app of apps) if (app.event?.pubkey) authorFor(app.event.pubkey)
  for (const app of apps) iconSrcFor(app)
}

// Authors by pubkey: the name for the "from <author>" line, and the text a
// typed filter matches against. A row built before its author is in shows the
// short npub; authorLanded patches the name in when the profile arrives.
type Author = { display: string; search: string }
const authors = new Map<string, Author | null>() // null: queued or in flight
function authorFor(pubkey: string, front = false): Author | null {
  const known = authors.get(pubkey)
  if (known !== undefined) {
    if (known === null && front) promote(`author:${pubkey}`)
    return known
  }
  authors.set(pubkey, null)
  enqueue(
    `author:${pubkey}`,
    () =>
      loadNostrUser(pubkey)
        .then(u => {
          const author = {
            display: u.shortName,
            search: [u.metadata?.name, u.metadata?.display_name, u.metadata?.nip05, u.shortName]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
          }
          authors.set(pubkey, author)
          authorLanded(pubkey, author)
        })
        .catch(() => authors.delete(pubkey)),
    front
  )
  return null
}

// Patches the name into every row by that author, and into its search text so
// a filter being typed can match it — no rebuild.
function authorLanded(pubkey: string, author: Author) {
  let any = false
  for (const row of rows.values()) {
    if (row.item.author !== pubkey) continue
    if (row.nameEl) row.nameEl.textContent = author.display
    row.search = `${row.base} ${author.search}`
    any = true
  }
  if (any && !suggestions.hidden && input!.value.trim()) applyFilter()
}

function itemSearchText(item: SuggestionItem): string {
  return [
    item.nappId,
    item.instanceId,
    item.petname,
    item.author,
    item.raw,
    item.slash,
    item.systemId,
    item.actionId,
    item.appType
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function itemPreferredValue(item: SuggestionItem): string {
  return item.slash || item.petname || item.nappId || item.raw || ""
}

function itemSortLabel(item: SuggestionItem): string {
  return (item.petname || item.nappId || item.raw || "").toLowerCase()
}

// Brings the rows in line with the current windows and installed apps: a row
// is built for each new item, rebuilt where its item changed, dropped where
// its item is gone, and each section is put in order by moving only what is
// out of place. Then the filter is applied.
function syncSuggestions() {
  const order: Record<Section, Row[]> = { system: [], open: [], apps: [] }
  const seen = new Set<string>()
  for (const item of buildSuggestionItems()) {
    const key = itemKey(item)
    seen.add(key)
    const sig = itemSig(item)
    let row = rows.get(key)
    if (!row) {
      row = buildRow(item, sig)
      rows.set(key, row)
    } else if (row.sig !== sig) {
      const fresh = buildRow(item, sig)
      row.el.replaceWith(fresh.el)
      row = fresh
      rows.set(key, row)
    } else {
      row.item = item
      row.el
        .querySelector(".sugg-space")
        ?.classList.toggle("sugg-space-current", !!item.spaceCurrent)
    }
    order[sectionOf(item)].push(row)
  }
  for (const [key, row] of rows) {
    if (seen.has(key)) continue
    row.el.remove()
    rows.delete(key)
  }
  order.apps.sort((a, b) => itemSortLabel(a.item).localeCompare(itemSortLabel(b.item)))
  for (const s of ["system", "open", "apps"] as const) {
    placeInOrder(
      suggSections[s],
      order[s].map(r => r.el)
    )
  }
  applyFilter()
}

// Puts `els` into `parent` in this order, touching only what's out of place.
function placeInOrder(parent: HTMLElement, els: HTMLElement[]) {
  let cursor = parent.firstElementChild
  for (const el of els) {
    if (el === cursor) cursor = cursor.nextElementSibling
    else parent.insertBefore(el, cursor)
  }
}

// Shows the rows matching what's typed (all of them when nothing is), hides
// the rest, and sets the dividers and the empty message to suit.
function applyFilter() {
  const filter = input!.value.trim().toLowerCase()
  const shown: Record<Section, boolean> = { system: false, open: false, apps: false }
  for (const row of rows.values()) {
    const show = !filter || row.search.includes(filter)
    row.el.hidden = !show
    if (show) shown[sectionOf(row.item)] = true
  }
  suggDividers[0].hidden = !(shown.system && shown.open)
  suggDividers[1].hidden = !((shown.system || shown.open) && shown.apps)
  suggestions.classList.toggle("sugg-none", !shown.system && !shown.open && !shown.apps)
}

function buildRow(item: SuggestionItem, sig: string): Row {
  const el = document.createElement("div")
  el.className = "suggestion"
  const row: Row = { item, el, sig, base: itemSearchText(item), search: "", nameEl: null }
  const author = item.author ? authorFor(item.author, true) : null
  row.search = author ? `${row.base} ${author.search}` : row.base

  const main = document.createElement("span")
  main.className = "sugg-main"
  let title: HTMLElement | null = null // the icon slots in right after it
  // What trails the row: "<type> from <author>" for an installed app, the space
  // it lives in for an open window.
  let trail: HTMLElement | null = null

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
    // Like the Apps card: title (and icon). An installed app trails with
    // "<type> from <author>"; an open window shows its instance id here and
    // trails with its space instead. No installed record: the bare id stands in.
    if (item.petname) {
      title = document.createElement("span")
      title.className = "sugg-pet"
      title.textContent = item.petname
      main.appendChild(title)
    } else {
      const napp = document.createElement("span")
      napp.className = "sugg-napp"
      napp.textContent = item.nappId || null
      main.appendChild(napp)
    }
    if (item.source === "napp" && (item.author || item.authorLabel)) {
      trail = document.createElement("span")
      trail.className = "sugg-author"
      if (item.author) {
        // The name from the cache, or the short npub until the profile lands
        // (authorLanded patches it in).
        const name = document.createElement("span")
        name.className = "sugg-author-name"
        name.textContent = author ? author.display : bareNostrUser(item.author).shortName
        row.nameEl = name
        trail.append(`${item.appType} from `, name)
      } else {
        trail.textContent = `${item.appType} · ${item.authorLabel}`
      }
    }
    if (item.instanceId && isInstanceSerial(item.instanceId)) {
      const id = document.createElement("span")
      id.className = "sugg-id"
      id.textContent = item.instanceId
      main.appendChild(id)
    }
    // Global view: every open window is tagged with the space it lives in. The
    // current space's windows are de-emphasized (you're already in it).
    if (item.source === "open" && item.spaceName) {
      trail = document.createElement("span")
      trail.className = item.spaceCurrent ? "sugg-space sugg-space-current" : "sugg-space"
      trail.append(icon("window"), document.createTextNode(item.spaceName))
    }
  }

  el.appendChild(main)
  if (trail) el.appendChild(trail)
  // Slash rows carry their affordance label at the right edge; app rows trail
  // with their author line or space instead.
  if (item.source === "system" || item.source === "action") {
    const source = document.createElement("span")
    source.className = "source"
    source.textContent = item.source
    el.appendChild(source)
  }
  // The app's icon, next to its title: the probed src, already settled when the
  // list was warmed ahead of time, so it lands before the paint. No src means
  // no icon — there's no placeholder.
  item.icon?.then(src => {
    if (!src || !el.isConnected) return
    const img = document.createElement("img")
    img.className = "sugg-icon"
    img.alt = ""
    img.addEventListener("error", () => img.remove())
    img.src = src
    if (title) title.after(img)
    else main.prepend(img)
  })

  el.addEventListener("mousedown", async (e: MouseEvent) => {
    e.preventDefault()
    const item = row.item // the row is kept; its item is the current one
    const label = itemPreferredValue(item)
    hideSuggestions()
    try {
      if (item.systemId) {
        await invokeSystemNapp(item.systemId)
      } else if (item.actionId) {
        actionRegistry[item.actionId]?.run(systemCtx)
      } else if (item.instanceId) {
        // Window may live in another space — go there first, then focus it.
        if (item.spaceId && item.spaceId !== currentSpaceId) {
          await switchSpace(item.spaceId)
          renderSpacesBar()
        }
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
        // Napplets self-launch inside install() (srcdoc path); only nsites need
        // launching here.
        if (!nappId.startsWith("napplet~")) {
          const win = await launch(stage, nappId, {
            ...makeLaunchOpts(),
            petname: friendlyNameFor(nappId)
          })
          syncDOM(win)
          win.focus()
        }
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
  syncSuggestions()
  suggestions.hidden = false
}

function hideSuggestions() {
  suggestions.hidden = true
}

input!.addEventListener("focus", showSuggestions)
input!.addEventListener("input", () => {
  if (suggestions.hidden) showSuggestions()
  else applyFilter()
})
input!.addEventListener("blur", () => {
  // Debug aid: `window.__pinSuggestions = true` in the console keeps the
  // dropdown open across blur so it can be inspected in DevTools (clicking the
  // Elements panel blurs the input, which would otherwise hide it).
  if ((window as any).__pinSuggestions) return
  setTimeout(hideSuggestions, 150)
})
input!.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") hideSuggestions()
})

// Ctrl+K / Cmd+K toggles top input, standard launcher palette shortcut.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault()
    if (document.activeElement === input && !suggestions.hidden) {
      hideSuggestions()
      input!.blur()
    } else {
      input!.focus()
      input!.select()
      showSuggestions()
    }
  }
})

function refreshSuggestions() {
  prewarmSuggestions()
  if (!suggestions.hidden) syncSuggestions()
  notifyAppsChanged()
  scheduleSpacesBar()
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
      if (isWindowInactive(state.instanceId)) return // background-space window
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
  // Stage bounds are in flux while windows mount (scrollbar appears once one
  // lands below the fold) — hold the observer's rescale until we're done, or
  // every reload shrinks the layout by the transient delta. See host.ts.
  setStageSettling(true)
  try {
    await restoreAllInner()
  } finally {
    // Two frames: one for layout, one for the scrollbar/spacer to settle,
    // then refs re-baseline against the final bounds.
    requestAnimationFrame(() => requestAnimationFrame(() => setStageSettling(false)))
  }
}

async function restoreAllInner() {
  for (const state of persist.readOpen()) {
    // Skip windows already live (e.g. one moved into this space while it was
    // still unmaterialized) so materializing the space can't mount a duplicate.
    if (hasOpenWindow(state.instanceId)) continue
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
      // Napplets aren't served from an origin — re-verify + srcdoc them from
      // the stored manifest, not the nsite launch path (which would point the
      // iframe at a non-existent SW origin and load the launcher instead).
      const win = state.nappId.startsWith("napplet~")
        ? await restoreNapplet(state)
        : await launch(stage, state.nappId, {
            ...makeLaunchOpts(),
            instanceId: state.instanceId,
            petname: state.petname,
            params: state.params,
            position: state.position,
            status: state.status
          })
      if (!win) continue
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

// Bump the instance-id serial past every numeric id anywhere — live windows AND
// every space's persisted windows (even unvisited ones) — so a new window can't
// collide with one we'll restore when a not-yet-materialized space is opened.
function bumpInstanceSerial() {
  let maxId = 0
  const ids = [...persist.allOpenWindows().map(w => w.window.instanceId), ...allInstanceIds()]
  for (const iid of ids) {
    const n = parseInt(iid, 10)
    if (!isNaN(n) && n > maxId) maxId = n
  }
  setInstanceIdSerial(maxId + 1)
}

// Switch to another space. We do NOT tear windows down — each space's windows
// stay mounted (so their iframe state survives) and we just toggle visibility.
// A space's windows are mounted only the first time it's visited this session.
// No snapshot is needed: each space's `open` is mutated live in the document, so
// flipping the current pointer is enough to make readOpen() reflect the target.
async function switchSpace(targetId: string) {
  if (targetId === currentSpaceId) return
  persist.setCurrentSpaceId(targetId)
  currentSpaceId = targetId
  packModeOn = persist.getSpacePackMode(targetId)
  // Reveal the target's windows, hide every other space's.
  setActiveSpace(targetId)
  if (!materializedSpaces.has(targetId)) {
    // First visit this session: mount its windows from the saved layout.
    materializedSpaces.add(targetId)
    bumpInstanceSerial()
    await restoreAll()
  }
  applyPackMode()
  // The spacer was sized around the space we just left — re-measure against the
  // windows that are actually visible here.
  syncStageBottomSpacer(stage)
  refreshSuggestions()
}

// Create a new (empty) space and switch into it.
async function createSpaceAndSwitch(name?: string): Promise<string> {
  const id = persist.createSpace(name)
  await switchSpace(id)
  renderSpacesBar()
  return id
}

// ─── Move a window to another space ─────────────────────────────
// The window's move button (in napp-window.ts) bubbles a request up to the
// stage; the launcher owns spaces so it opens the picker and does the move.
stage.addEventListener("napp-move-request", e => {
  const d = (e as CustomEvent).detail as { instanceId: string; x: number; y: number }
  openMoveToSpace(d.instanceId, d.x, d.y)
})

const MOVE_NEW_SPACE = "__new__"
function openMoveToSpace(instanceId: string, x: number, y: number) {
  const others = persist.listSpaces().filter(s => s.id !== currentSpaceId)
  openPopover<string | null>({
    x,
    y,
    class: "move-popover",
    dismissValue: null,
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "move-popover-list"
      for (const s of others) {
        wrap.append(
          button({
            variant: "ghost",
            label: s.name,
            class: "move-popover-item",
            onClick: () => resolve(s.id)
          })
        )
      }
      wrap.append(
        button({
          variant: "ghost",
          label: "+ new space",
          class: "move-popover-item move-popover-new",
          onClick: () => resolve(MOVE_NEW_SPACE)
        })
      )
      return wrap
    }
  }).then(async choice => {
    if (!choice) return
    const targetId = choice === MOVE_NEW_SPACE ? persist.createSpace() : choice
    // The window arrives carrying the position it held in the space it left,
    // which says nothing about what's already here — keep it and the window
    // lands on top of whatever occupies those pixels. A packed target treats it
    // as newly arrived and slots it into the leftover space (the flag has to be
    // set before switchSpace, which packs on entry); a freeform one gets it a
    // free spot of its own, leaving the rest of the layout alone.
    const targetPacks = persist.getSpacePackMode(targetId)
    if (targetPacks) markPackNew(instanceId)
    persist.moveOpenToSpace(instanceId, targetId)
    moveWindowToSpace(instanceId, targetId)
    maybeRepack() // tidy the source layout now the window has left
    await switchSpace(targetId) // follow the window into its new space
    // Placed here rather than left to switchSpace's own maybeRepack: that one is
    // rAF-coalesced and the maybeRepack above has already claimed the slot, so it
    // returns early. Landing the window is part of the move — do it now.
    if (targetPacks) bestFitPack(stage)
    else placeInFreeSpot(stage, instanceId)
    renderSpacesBar()
    const name = persist.listSpaces().find(s => s.id === targetId)?.name || "space"
    setStatus(`Moved to ${name}`)
  })
}

// Commit the current windows as this space's saved layout.
function saveCurrentSpace() {
  persist.commitSpaceSaved(currentSpaceId)
  setStatus("Space saved")
  renderSpacesBar()
}

// Revert this space's windows to its last saved layout (loses unsaved changes).
async function resetCurrentSpace() {
  const ok = window.confirm(
    "Reset this space to its saved layout?\n\n" +
      "Windows you've opened, moved, resized, or closed since the last save will be lost."
  )
  if (!ok) return
  // Reset genuinely discards the live windows, so close them and re-mount the
  // saved snapshot from scratch.
  const saved = persist.getSpaceSaved(currentSpaceId)
  teardownSpaceWindows(currentSpaceId)
  persist.writeOpen(saved.open) // becomes the current space's live open
  packModeOn = saved.packMode
  persist.setSpacePackMode(currentSpaceId, packModeOn)
  bumpInstanceSerial()
  await restoreAll()
  applyPackMode()
  refreshSuggestions()
  renderSpacesBar()
}

// Delete the current space and load whichever space becomes current. An
// ephemeral (shared-link) space is discarded: its temp apps are destroyed so
// their origins are wiped now rather than on the next boot.
async function destroyCurrentSpace() {
  const spaces = persist.listSpaces()
  const ephemeral = persist.isEphemeralSpace(currentSpaceId)
  if (!ephemeral && spaces.length <= 1) {
    setStatus("Can't delete the only space")
    return
  }
  const name = spaces.find(s => s.id === currentSpaceId)?.name || "this space"
  const ok = window.confirm(
    ephemeral
      ? `Discard shared space "${name}"?\n\n` +
          "Its apps were never installed; their windows close."
      : `Delete space "${name}"?\n\n` + "Its windows and saved layout will be permanently removed."
  )
  if (!ok) return
  if (ephemeral) {
    for (const w of persist.readOpen()) {
      if (!sharedTemps.has(w.nappId)) continue
      destroyByNappId(w.nappId)
      sharedTemps.delete(w.nappId)
    }
  }
  // This space's windows are genuinely gone — close them.
  teardownSpaceWindows(currentSpaceId)
  materializedSpaces.delete(currentSpaceId)
  persist.deleteSpace(currentSpaceId)
  currentSpaceId = persist.getCurrentSpaceId() // deleteSpace re-points current
  packModeOn = persist.getSpacePackMode(currentSpaceId)
  // Reveal the new current space — reusing its windows if already mounted.
  setActiveSpace(currentSpaceId)
  if (!materializedSpaces.has(currentSpaceId)) {
    materializedSpaces.add(currentSpaceId)
    bumpInstanceSerial()
    await restoreAll()
  }
  applyPackMode()
  refreshSuggestions()
  renderSpacesBar()
}

// ── spaces bar ──────────────────────────────────────────────────
let spacesBarQueued = false
function scheduleSpacesBar() {
  if (spacesBarQueued) return
  spacesBarQueued = true
  requestAnimationFrame(() => {
    spacesBarQueued = false
    renderSpacesBar()
  })
}

function iconButton(name: string, title: string, onClick: () => void) {
  const b = button({ variant: "ghost", title, onClick })
  b.appendChild(icon(name))
  return b
}

// Persistent spaces-bar structure: built once, then renderSpacesBar() updates
// its contents in place. The space TABS in particular are reused across renders
// (keyed by data-space-id) so toggling .active animates — a freshly-created
// element has no prior state to transition from.
let spacesBarBuilt = false
let spacesNameEl: HTMLDivElement
let spacesWinListEl: HTMLDivElement
let spacesTabListEl: HTMLDivElement
// Controls that depend on the kind of the current space: save/reset for a real
// one, keep for an ephemeral one. renderSpacesBar toggles them.
let spacesSaveBtn: HTMLButtonElement
let spacesResetBtn: HTMLButtonElement
let spacesKeepBtn: HTMLButtonElement
let spacesTrashBtn: HTMLButtonElement

function buildSpacesBarSkeleton() {
  // Start: the current space's name. Double-click to rename it.
  spacesNameEl = document.createElement("div")
  spacesNameEl.className = "spaces-current-name"
  spacesNameEl.title = "Double-click to rename this space"
  spacesNameEl.addEventListener("dblclick", () => {
    const cur = persist.listSpaces().find(s => s.id === currentSpaceId)
    const n = window.prompt("Rename space", cur?.name || "")
    if (n != null) {
      persist.renameSpace(currentSpaceId, n)
      renderSpacesBar()
    }
  })

  // Controls for the CURRENT space (save / reset / keep / destroy / share) —
  // handlers read currentSpaceId at call time, so building them once is fine.
  const controls = document.createElement("div")
  controls.className = "spaces-controls"
  spacesSaveBtn = iconButton("save", "Save this space's layout", saveCurrentSpace)
  spacesResetBtn = iconButton("reset", "Reset to saved layout", resetCurrentSpace)
  spacesKeepBtn = iconButton("check", "Keep this space (installs its apps)", keepCurrentSpace)
  spacesTrashBtn = iconButton("trash", "Delete this space", destroyCurrentSpace)
  controls.append(
    spacesSaveBtn,
    spacesResetBtn,
    spacesKeepBtn,
    spacesTrashBtn,
    iconButton("link", "Share this space as a link", shareCurrentSpace)
  )

  // The current space's live windows (taskbar).
  spacesWinListEl = document.createElement("div")
  spacesWinListEl.className = "spaces-windows"

  // The list of spaces (drag to reorder) + new-space.
  spacesTabListEl = document.createElement("div")
  spacesTabListEl.className = "spaces-list"

  const right = document.createElement("div")
  right.className = "spaces-right"
  right.append(
    spacesTabListEl,
    iconButton("plus", "New space", () => createSpaceAndSwitch())
  )

  spacesBar.append(spacesNameEl, controls, spacesWinListEl, right)
  spacesBarBuilt = true
}

function renderSpacesBar() {
  if (!spacesBarBuilt) buildSpacesBarSkeleton()
  const spaces = persist.listSpaces()

  const cur = spaces.find(s => s.id === currentSpaceId)
  const ephemeral = !!cur?.ephemeral
  spacesNameEl.textContent = cur?.name || "space"
  spacesNameEl.classList.toggle("ephemeral", ephemeral)
  spacesSaveBtn.hidden = ephemeral
  spacesResetBtn.hidden = ephemeral
  spacesKeepBtn.hidden = !ephemeral
  spacesTrashBtn.title = ephemeral ? "Discard this shared space" : "Delete this space"

  // Window taskbar — rebuilt each render. Click → focus; drag → reorder (which
  // reorders the stage / mobile stack, see reorderWindows).
  spacesWinListEl.innerHTML = ""
  for (const w of listOpenWindows()) {
    const c = chip({
      label: w.petname,
      title: `${w.petname} — drag to reorder`,
      class: "spaces-window" + (w.minimized ? " minimized" : ""),
      onClick: () => {
        if (windowReorder.wasDragging()) return
        focusInstance(w.instanceId)
      }
    })
    c.dataset.instanceId = w.instanceId
    windowReorder.attach(c)
    spacesWinListEl.appendChild(c)
  }

  // Space tabs — REUSE existing elements so .active toggles (and its padding
  // transition) animate on a live node instead of being born already-active.
  const existing = new Map(
    [...spacesTabListEl.children].map(c => [
      (c as HTMLElement).dataset.spaceId!,
      c as HTMLButtonElement
    ])
  )
  spaces.forEach((s, i) => {
    let tab = existing.get(s.id)
    if (tab) {
      tab.textContent = s.name // keep name in sync (rename)
      existing.delete(s.id)
    } else {
      tab = buildSpaceChip(s)
    }
    tab.classList.toggle("active", s.id === currentSpaceId)
    tab.classList.toggle("ephemeral", !!s.ephemeral) // cleared once the space is kept
    // Only move the node when its position is actually wrong — re-inserting a
    // node cancels its in-flight transition, which would defeat the .active
    // padding animation on a plain switch (where the order doesn't change).
    if (spacesTabListEl.children[i] !== tab) {
      spacesTabListEl.insertBefore(tab, spacesTabListEl.children[i] ?? null)
    }
  })
  for (const [, tab] of existing) tab.remove() // spaces that no longer exist
}

// FLIP: animate every sibling sliding to its new spot with ease-in-out. Handles
// being called mid-animation — measures current visual positions first, snaps
// any in-flight transforms to rest, then animates from there to the new layout.
function flipReorder(list: HTMLElement, exclude: HTMLElement, mutate: () => void) {
  const others = [...list.children].filter(c => c !== exclude) as HTMLElement[]
  // First: current visual left (includes any active transform).
  const before = new Map(others.map(el => [el, el.getBoundingClientRect().left]))
  // Snap to rest so the post-mutate measurement is the true layout position.
  for (const el of others) {
    el.style.transition = "none"
    el.style.transform = ""
  }
  mutate()
  for (const el of others) {
    const dx = (before.get(el) ?? 0) - el.getBoundingClientRect().left
    if (!dx) {
      el.style.transition = ""
      continue
    }
    el.style.transform = `translateX(${dx}px)`
    void el.offsetWidth // force reflow so the next change animates from here
    el.style.transition = "transform 150ms ease-in-out"
    el.style.transform = ""
    el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true })
  }
}

// Generic drag-to-reorder for a horizontal chip row. Pointer-based (not native
// HTML5 DnD) so we own the cursor — `grabbing` throughout — with no floating
// ghost; a drag only starts past a small threshold, so a plain click still
// fires. While dragging, the chip slots into the gap under the cursor and the
// others slide aside (FLIP). On drop, commit() runs with the row's items in
// their new DOM order. Shared by the space tabs and the window taskbar.
function makeReorder(opts: { itemSelector: string; commit: (orderedEls: HTMLElement[]) => void }) {
  let drag: { el: HTMLElement; list: HTMLElement; startX: number; started: boolean } | null = null
  let suppressClick = false

  // Item to insert before (first whose midpoint is right of the cursor); null →
  // past the end. Skips the dragged item.
  function dragAfter(list: HTMLElement, x: number): HTMLElement | null {
    let closest: { offset: number; el: HTMLElement | null } = { offset: -Infinity, el: null }
    for (const child of list.querySelectorAll<HTMLElement>(`${opts.itemSelector}:not(.dragging)`)) {
      const box = child.getBoundingClientRect()
      const offset = x - (box.left + box.width / 2)
      if (offset < 0 && offset > closest.offset) closest = { offset, el: child }
    }
    return closest.el
  }

  function onMove(e: PointerEvent) {
    if (!drag) return
    const { el, list, startX } = drag
    if (!drag.started) {
      if (Math.abs(e.clientX - startX) < 4) return // below threshold: still a click
      drag.started = true
      el.classList.add("dragging") // "this one is moving" highlight
    }
    e.preventDefault()
    const after = dragAfter(list, e.clientX)
    if (after === el) return
    const settled = after ? el.nextElementSibling === after : el === list.lastElementChild
    if (settled) return
    flipReorder(list, el, () =>
      after == null ? list.appendChild(el) : list.insertBefore(el, after)
    )
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onUp)
    document.body.classList.remove("space-dragging") // grabbing cursor off
    if (drag?.started) {
      const { el, list } = drag
      el.classList.remove("dragging")
      opts.commit([...list.querySelectorAll<HTMLElement>(opts.itemSelector)])
      suppressClick = true // swallow the click that follows this pointerup
      setTimeout(() => (suppressClick = false), 0)
    }
    drag = null
  }

  return {
    // Wire an item's pointerdown to begin a potential drag.
    attach(el: HTMLElement) {
      el.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !el.parentElement) return
        drag = { el, list: el.parentElement, startX: e.clientX, started: false }
        document.body.classList.add("space-dragging") // grabbing cursor on press
        window.addEventListener("pointermove", onMove)
        window.addEventListener("pointerup", onUp)
        window.addEventListener("pointercancel", onUp)
      })
    },
    // True briefly after a drag so the trailing click can be ignored.
    wasDragging: () => suppressClick
  }
}

// Two reorderable rows in the spaces bar: the space tabs (→ space order) and the
// window taskbar (→ the per-space window/stage order, which is the mobile stack).
const spaceReorder = makeReorder({
  itemSelector: ".spaces-tab",
  commit: els => persist.setSpacesOrder(els.map(e => e.dataset.spaceId!).filter(Boolean))
})
const windowReorder = makeReorder({
  itemSelector: ".spaces-window",
  commit: els => reorderWindows(els.map(e => e.dataset.instanceId!).filter(Boolean))
})

// Reorder the live windows in the stage to match the taskbar order, then sync
// the per-space `open` array from the new DOM order (persistDomOrder). In mobile
// (static flow) this reorders the visible vertical stack; on desktop the windows
// are absolutely positioned, so only the persisted order changes — which still
// drives the mobile layout and the restore order. Keeping the stage DOM in sync
// matters: persistDomOrder reads it, so a taskbar-only reorder would be reverted.
function reorderWindows(instanceIds: string[]) {
  const spacer = stage.querySelector(".stage-bottom-spacer")
  for (const id of instanceIds) {
    const win = stage.querySelector<HTMLElement>(`.napp-window[data-instance-id="${id}"]`)
    // moveBefore (not insertBefore) so the window's iframe keeps running.
    if (win) moveBefore(stage, win, spacer)
  }
  persistDomOrder()
}

function buildSpaceChip(s: { id: string; name: string }): HTMLButtonElement {
  const el = tab({
    label: s.name,
    active: s.id === currentSpaceId,
    title: "Switch space — drag to reorder",
    class: "spaces-tab", // the drag handler selects on it
    onClick: () => {
      if (spaceReorder.wasDragging()) return // just finished a drag, not a real click
      if (s.id !== currentSpaceId) switchSpace(s.id).then(renderSpacesBar)
    }
  })
  el.dataset.spaceId = s.id
  spaceReorder.attach(el)
  return el
}

// Console hook (kept as a convenience alongside the bar).
;(window as any).__spaces = {
  list: () => persist.listSpaces(),
  current: () => currentSpaceId,
  // Debug: every open window across all spaces, grouped by space.
  windows: () =>
    persist.allOpenWindows().map(w => ({
      space: w.spaceName,
      napp: w.window.nappId,
      petname: w.window.petname,
      system: !!w.window.system,
      instanceId: w.window.instanceId
    })),
  doc: () => JSON.parse(localStorage.getItem("nostrapps:spaces") || "null"),
  switch: (id: string) => switchSpace(id).then(renderSpacesBar),
  create: (name?: string) => createSpaceAndSwitch(name),
  save: () => saveCurrentSpace(),
  reset: () => resetCurrentSpace(),
  destroy: () => destroyCurrentSpace(),
  keep: () => keepCurrentSpace(),
  share: () => shareCurrentSpace(),
  rename: (id: string, name: string) => (persist.renameSpace(id, name), renderSpacesBar()),
  remove: (id: string) => (persist.deleteSpace(id), renderSpacesBar())
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

// A dev~/temp~ napp is meant to leave nothing behind: closing its window wipes
// its origin (see onDestroy). A reload skips that — the window goes, and with it
// every in-memory trace of the napp, while the origin's data and service worker
// stay. Clear whatever the last session left, before anything else mounts, so
// re-running /dev on the same app starts genuinely empty.
async function sweepEphemeralOrigins() {
  const stale = persist.listEphemeralOrigins()
  if (stale.length === 0) return
  setStatus(`Clearing ${stale.length} leftover dev napp${stale.length === 1 ? "" : "s"}…`)
  for (const nappId of stale) {
    try {
      await wipe(nappId)
      // The close path (finalizeNappRemoval) clears these too — a reload skips
      // it, and an ephemeral napp's "Allow always" must not outlive its data.
      clearDecisions(nappId)
      persist.forgetEphemeralOrigin(nappId) // only on success, so a failure retries next boot
    } catch (err: any) {
      console.warn("[sandbox] sweep failed for", nappId, err)
    }
  }
}

async function init() {
  setStatus(
    "Ready — try /apps, /upload, /settings, /logs, /folder, or enter a pubkey/npub/nsite host"
  )
  handlers.setActionDispatcher(runNappAction)
  // Build the local profile search index in the background — searches just
  // see a smaller index until it's done.
  buildUserIndex().catch(err => console.warn("[search] user index build failed", err))
  await sweepEphemeralOrigins()
  // If the user is paired with a bunker, get the connection warm in the
  // background. First sign request will wait if it's still connecting.
  reconnectIfNeeded().catch(err => setStatus(`Bunker reconnect failed: ${err.message}`))
  await handlers.init()
  // The current space's windows are about to be mounted — make it the active
  // (visible) space so they're tagged to it and shown.
  setActiveSpace(currentSpaceId)
  materializedSpaces.add(currentSpaceId)
  // Bump instanceIdSerial past any existing numeric instanceIds so new
  // windows don't collide with persisted entries.
  bumpInstanceSerial()
  await restoreAll()
  maybeBootstrap()
  // Restore doesn't fire onStateChange — kick the packer manually so a
  // session that resumed in pack mode lands cleanly.
  if (packModeOn) maybeRepack()
  broadcastTheme()
  renderSpacesBar()
  // Queue the launcher input's icons and author names for the background —
  // paced behind the rest of the boot and the user's input, see the queue
  // by prewarmSuggestions.
  prewarmSuggestions()
  importShareLink(location.hash).catch(reportShareLinkError)
}
init()
// A link opened in an already-running launcher only changes the hash.
window.addEventListener("hashchange", () => {
  importShareLink(location.hash).catch(reportShareLinkError)
})

// nsite/napp/napplet, for the summary screen.
function manifestAppType(event: { kind: number; tags: string[][] } | null | undefined): string {
  if (!event) return "napp"
  if (event.kind === 5129 || event.kind === 15129 || event.kind === 35129) return "napplet"
  return event.tags.some(t => (t[0] === "action" || t[0] === "requires") && t[1]) ? "napp" : "nsite"
}
// Same, from a dev/local metadata.json.
function metaAppType(m: any): string {
  return m?.actions?.length || m?.requires?.length ? "napp" : "nsite"
}

// First-run-remembered permission gate, shared by every launch path (published,
// dev, folder, temp). Shows the summary + grant screen the first time an app is
// seen; later launches reuse the remembered grant (the app card's permissions
// button re-opens it). Returns the effective policy, or null if cancelled.
async function resolvePolicyForLaunch(
  nappId: string,
  opts: {
    title: string
    icon?: string
    iconBlob?: Blob
    type?: string
    declaredDomains: string[]
  }
): Promise<NappPolicy | null> {
  if (persist.hasPolicy(nappId)) return persist.getPolicy(nappId)
  const granted = await promptNappPolicy(opts)
  if (!granted) return null
  persist.setPolicy(nappId, granted)
  return persist.getPolicy(nappId)
}

async function install(raw: string): Promise<string> {
  // A share link's temp app (the Apps card hands over its id minus the temp~
  // prefix): installed for real from the files it was fetched with, under the
  // grant the link's screen gave it. Its window stays the temp one until the
  // space is kept.
  const tempId = raw.startsWith("temp~") ? raw : `temp~${raw}`
  if (sharedTemps.has(tempId)) {
    const realId = await keepTempApp(tempId)
    if (!realId) throw new Error(`Couldn't keep ${tempId}`)
    return realId
  }

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

  // NIP-5D napplet (its own kind) takes the srcdoc loader, not the nsite path.
  if (resolved.kind && isNappletKind(resolved.kind)) {
    return installNapplet({ ...resolved, kind: resolved.kind })
  }

  const fetched = await fetchNsite(resolved, setStatus)
  console.debug("[install] nsite fetched", {
    nappId: fetched.nappId,
    title: fetched.title,
    fileCount: fetched.files.length,
    hasManifest: !!fetched.manifest
  })
  return installFetched(fetched, raw)
}

// The install proper, from fetched files: the first-run permission screen (a
// stored policy skips it), the boot into the napp's origin, the manifest
// record. Keep runs it on the files a shared space already fetched.
async function installFetched(
  { nappId, files, title, manifest }: NsiteResult,
  raw: string,
  installedAt?: number
): Promise<string> {
  const dTag = manifest?.tags.find((t: any) => t[0] === "d")?.[1]
  const petname = title || dTag || raw
  console.debug("[install] installing napp with opts", { nappId, petname })

  const origin = nappOriginFor(nappId)
  const onProgress = setStatus
  const label = title || nappId

  // Summary + permission screen before anything is written; the granted policy
  // ships with the install so the napp's first load is already under the right
  // CSP. Cancelling aborts. First run only — a reinstall keeps the prior grant.
  const iconUrl = manifest?.tags.find((t: any) => t[0] === "icon")?.[1]
  const policy = await resolvePolicyForLaunch(nappId, {
    title: label,
    icon: directIconSrc(iconUrl),
    iconBlob: iconBlobFrom(iconUrl, files, manifest),
    type: manifestAppType(manifest),
    declaredDomains: requiresFromEvent(manifest)
  })
  if (!policy) throw new Error("Install cancelled")

  console.debug("[sandbox] install", { nappId, label, origin })
  onProgress(`Booting ${label}…`)
  await bootNapp(origin, files, onProgress, label, persist.getStoredPolicy(nappId))

  if (manifest) persist.storeInstalledEvent(manifest, petname, installedAt)
  handlers.addApp(nappId, capabilitiesFromEvent(manifest))

  setStatus(`Installed ${label}`)
  return nappId
}

// NIP-5D napplet install/launch — the srcdoc path, entirely separate from the
// nsite install above. Resolve + verify the manifest, gate on the permission
// screen (declaredDomains = its `requires`), store it as an installed app so
// nappletDomainsFor sees the grant, then launch it into an opaque srcdoc window.
async function installNapplet(target: {
  pubkey: string
  dTag: string
  relayHints: string[]
  kind: number
}): Promise<string> {
  setStatus("Resolving napplet…")
  const resolved = await resolveNapplet(target, setStatus)
  const nappId = persist.computeNappId(resolved.manifest)

  const policy = await resolvePolicyForLaunch(nappId, {
    title: resolved.title || resolved.dTag,
    type: "napplet",
    declaredDomains: resolved.requires
  })
  if (!policy) throw new Error("Install cancelled")
  persist.storeInstalledEvent(resolved.manifest, resolved.title || resolved.dTag)
  handlers.addApp(nappId, [])

  const win = launchNapplet(stage, nappId, resolved.html, {
    ...makeLaunchOpts(),
    petname: resolved.title || resolved.dTag
  })
  syncDOM(win)
  win.focus()
  setStatus(`Launched napplet ${resolved.title || resolved.dTag}`)
  return nappId
}

// Unified launch entry point. Installed napplets have no service-worker origin,
// so the nsite launcher (`launchNsite`) would point their iframe at a URL that
// falls back to the launcher page itself. Route them to the srcdoc path instead.
// Every call site (input, apps, restore, direct paste) goes through here.
async function launch(
  stageEl: HTMLElement,
  nappId: string,
  opts: LaunchOpts = {}
): Promise<NappWindow> {
  if (nappId.startsWith("napplet~")) {
    const win = await launchInstalledNapplet(
      nappId,
      {
        instanceId: opts.instanceId,
        petname: opts.petname,
        position: opts.position,
        status: opts.status
      },
      opts.transient ? makeEphemeralLaunchOpts() : undefined
    )
    if (!win) throw new Error(`napplet ${nappId} could not be launched — its manifest is gone`)
    return win
  }
  return launchNsite(stageEl, nappId, opts)
}

// Materialize a napplet window from its stored manifest: re-verify + re-fetch
// its bytes and srcdoc them. Used for a fresh launch (via `launch` above) and
// for reload restore alike.
async function launchInstalledNapplet(
  nappId: string,
  opts: {
    instanceId?: string
    petname?: string | null
    position?: NappWindowState["position"]
    status?: NappWindowState["status"]
  } = {},
  baseOpts?: LaunchOpts
): Promise<NappWindow | null> {
  const app = persist.getInstalledApp(nappId)
  if (!app?.event && !app?.html) {
    setStatus(`Can't launch napplet ${nappId} — its manifest is gone`)
    return null
  }
  // A napplet with no stored policy launches with zero granted domains, which
  // presents as every required domain missing. Run the same first-run gate as
  // install (returns the stored policy when one exists, so no re-prompt).
  const policy = await resolvePolicyForLaunch(nappId, {
    title: app.petname || app.title || nappId,
    icon: installedIconSrc(app),
    type: "napplet",
    declaredDomains: app.event ? requiresFromEvent(app.event) : (app.requires ?? [])
  })
  if (!policy) return null
  // Published napplets re-fetch + re-verify from the manifest; local ones run
  // the stored folder bytes directly.
  const resolved = app.event ? await loadNappletFromManifest(app.event, setStatus) : null
  const html = resolved?.html ?? app.html!
  return launchNapplet(stage, nappId, html, {
    ...(baseOpts ?? makeLaunchOpts()),
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
    petname: opts.petname || resolved?.title || app.petname || nappId,
    ...(opts.position ? { position: opts.position } : {}),
    ...(opts.status ? { status: opts.status } : {})
  })
}

// Re-materialize a napplet window on reload from its saved window state.
async function restoreNapplet(state: NappWindowState): Promise<NappWindow | null> {
  return launchInstalledNapplet(state.nappId, {
    instanceId: state.instanceId,
    petname: state.petname,
    position: state.position,
    status: state.status
  })
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

    // Summary + grant screen (first run only), before boot — same gate as a
    // published install, so dev apps are shown and configurable from the start.
    if (
      !(await resolvePolicyForLaunch(nappId, {
        title: label,
        iconBlob: await iconBlobFromDir(dirHandle, metadata.icon),
        type: metaAppType(metadata),
        declaredDomains: metadata.requires || []
      }))
    ) {
      setStatus("Cancelled")
      return
    }

    setStatus(`Booting dev ${label}…`)
    await bootDevApp(origin, nappId, onProgress, label)

    setDevHandle(nappId, dirHandle)

    persist.storeDevApp({
      nappId,
      title: metadata.title || null,
      icon: metadata.icon || null,
      petname,
      actions: metadata.actions || [],
      requires: metadata.requires || [],
      modes: metadata.modes,
      initialSize: persist.initialSizeFromMeta(metadata),
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

async function installDevAppFromUrl(rawUrl: string) {
  try {
    const baseUrl = normalizeDevUrl(rawUrl)
    setStatus(`Fetching ${baseUrl}metadata.json…`)
    const metaRes = await fetch(new URL("metadata.json", baseUrl).toString())
    if (!metaRes.ok) throw new Error(`Fetch metadata.json failed: ${metaRes.status}`)
    const metadata = JSON.parse(await metaRes.text())
    if (!metadata?.id) throw new Error("metadata.json must contain an .id field")

    const nappId = `dev~${slug(baseUrl)}-${slug(metadata.id)}`
    const origin = nappOriginFor(nappId)
    const onProgress = setStatus
    const label = metadata.title || nappId
    const petname = metadata.title || nappId

    if (
      !(await resolvePolicyForLaunch(nappId, {
        title: label,
        icon: metadata.icon
          ? new URL(String(metadata.icon).replace(/^\//, ""), baseUrl).toString()
          : undefined,
        type: metaAppType(metadata),
        declaredDomains: metadata.requires || []
      }))
    ) {
      setStatus("Cancelled")
      return
    }

    setStatus(`Booting dev ${label}…`)
    await bootDevApp(origin, nappId, onProgress, label)

    setDevUrl(nappId, baseUrl)

    persist.storeDevApp({
      nappId,
      title: metadata.title || null,
      icon: metadata.icon || null,
      petname,
      actions: metadata.actions || [],
      requires: metadata.requires || [],
      modes: metadata.modes,
      initialSize: persist.initialSizeFromMeta(metadata),
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

function normalizeDevUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error("URL is required")
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http${trimmed === "localhost" ? "" : "s"}://${trimmed}`
  const u = new URL(withScheme)
  if (!u.pathname.endsWith("/")) u.pathname += "/"
  return u.toString()
}

async function launchFromInput(raw: string): Promise<void> {
  console.debug("[launch] launchFromInput", { raw })

  // Slash commands → system napps or one-shot actions
  if (raw.startsWith("/")) {
    const spaceIdx = raw.indexOf(" ")
    const cmd = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim()

    const sysId = slashCommands[cmd]
    if (sysId) {
      if (args) throw new Error(`${cmd} takes no arguments`)
      console.debug("[launch] slash command → system napp", { sysId })
      await invokeSystemNapp(sysId)
      return
    }
    const actionId = slashActions[cmd]
    if (actionId) {
      console.debug("[launch] slash command → action", { actionId, args })
      actionRegistry[actionId]?.run(systemCtx, args)
      return
    }
    console.debug("[launch] unknown slash command", { raw })
    throw new Error(`Unknown command: ${cmd}`)
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

  // "<action> <payload>" — dispatch a napp action from the launcher, the path a
  // napp takes with napp.action(): a handler is picked (or one of its open
  // windows), the action lands and is recorded on the window, so it comes back
  // on restore and goes into a share link. Payloads read like a link's.
  const act = /^([a-z0-9:_-]+)\s+(\S.*)$/i.exec(raw)
  if (act && handlers.hasAction(act[1])) {
    console.debug("[launch] input → action", { name: act[1] })
    await runNappAction("launcher", act[1], decodePayload(act[1], act[2].trim()))
    return
  }

  // ── temp install: show loading window immediately ──
  const suffix = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9._~-]/g, "-")
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

    const iconTag = manifest?.tags.find((t: any) => t[0] === "icon")?.[1]
    if (
      !(await resolvePolicyForLaunch(nappId, {
        title: label,
        icon: directIconSrc(iconTag),
        iconBlob: iconBlobFrom(iconTag, files, manifest),
        type: manifestAppType(manifest),
        declaredDomains: requiresFromEvent(manifest)
      }))
    ) {
      win.close()
      setStatus("Cancelled")
      return
    }

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
      requires: requiresFromEvent(manifest),
      modes: persist.modesFromEventTags(manifest?.tags ?? []),
      initialSize: persist.initialSizeFromEventTags(manifest?.tags ?? []),
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
    const { nappId, files, metadata, skipped, single } = await collectLocalFolder(
      inputFiles!,
      setStatus
    )
    console.debug("[launch] local folder collected", {
      nappId,
      fileCount: files.length,
      skipped,
      metadata
    })

    // A lone index.html: declaring `requires` (or a napplet meta) makes it a
    // napplet outright — only a file declaring nothing is ambiguous, and then
    // the permission screen asks. A previous load's choice is remembered
    // (napplet~ record with html, or a plain local~ one).
    if (single) {
      const nappletId = `napplet~${nappId}`
      const label = metadata.title || metadata.id
      const impliedNapplet = single.napplet || (metadata.requires?.length ?? 0) > 0
      let type: string
      if (persist.getInstalledApp(nappletId)?.html) type = "napplet"
      else if (persist.getInstalledApp(nappId)) type = "nsite"
      else if (impliedNapplet) {
        const granted = await resolvePolicyForLaunch(nappletId, {
          title: label,
          icon: directIconSrc(metadata.icon),
          iconBlob: iconBlobFrom(metadata.icon, files),
          type: "napplet",
          declaredDomains: metadata.requires || []
        })
        if (!granted) {
          setStatus("Cancelled")
          return
        }
        type = "napplet"
      } else {
        const granted = await promptNappPolicy({
          title: label,
          icon: directIconSrc(metadata.icon),
          iconBlob: iconBlobFrom(metadata.icon, files),
          type: "nsite",
          chooseType: true,
          declaredDomains: []
        })
        if (!granted) {
          setStatus("Cancelled")
          return
        }
        type = granted.type === "napplet" ? "napplet" : "nsite"
        persist.setPolicy(type === "napplet" ? nappletId : nappId, granted)
      }

      if (type === "napplet") {
        persist.storeInstalledLocalApp({
          nappId: nappletId,
          title: metadata.title || null,
          icon: metadata.icon || null,
          petname: label,
          requires: metadata.requires || [],
          html: single.html
        })
        handlers.addApp(nappletId, [])
        // Re-picking the folder while a window is open hot-swaps it onto the
        // new bytes instead of opening a second window.
        const reloaded = reloadNappletWindows(nappletId, single.html)
        if (!reloaded) {
          const win = launchNapplet(stage, nappletId, single.html, {
            ...makeLaunchOpts(),
            petname: label
          })
          syncDOM(win)
          win.focus()
        }
        setStatus(
          `Launched ${label}` +
            (reloaded ? ` — reloaded ${reloaded} window${reloaded === 1 ? "" : "s"}` : "")
        )
        return
      }
      // nsite: fall through to the normal local install (the policy stored
      // above makes resolvePolicyForLaunch a no-prompt pass-through).
    }

    // install(), but from local, not fetching an nsite
    const origin = nappOriginFor(nappId)
    const onProgress = setStatus
    const label = metadata.title || nappId

    const policy = await resolvePolicyForLaunch(nappId, {
      title: label,
      icon: directIconSrc(metadata?.icon),
      iconBlob: iconBlobFrom(metadata?.icon, files),
      type: metaAppType(metadata),
      declaredDomains: metadata?.requires || []
    })
    if (!policy) {
      setStatus("Cancelled")
      return
    }

    console.debug("[sandbox] install", { nappId, label, origin })
    setStatus(`Booting ${label}…`)
    await bootNapp(origin, files, onProgress, label, persist.getStoredPolicy(nappId))

    const petname = metadata?.title || nappId

    persist.storeInstalledLocalApp({
      nappId,
      title: metadata?.title || null,
      icon: metadata?.icon || null,
      petname,
      actions: metadata?.actions || [],
      requires: metadata?.requires || [],
      modes: metadata?.modes,
      initialSize: persist.initialSizeFromMeta(metadata),
      singleton: metadata.singleton
    })
    handlers.addApp(nappId, metadata?.actions || [])

    // Was a window for this napp already open before the re-boot? launch()
    // reuses it (singleton) without reloading its iframe — which would keep
    // showing the OLD files/metadata (e.g. a freshly added ui-wrapper) until a
    // manual reload. Detect the reuse and reload the page ourselves.
    const preExisting = findOpenWindowByNappId(nappId)
    const win = await launch(stage, nappId, {
      ...makeLaunchOpts(),
      petname
    })
    if (preExisting && win === preExisting) win.reload()
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
  // Pack the new window into the grid (no-op when pack mode is off). Fresh-in-
  // pack windows are flagged in the host, so bestFitPack sizes them 1×2 and
  // appends them rather than disturbing the existing layout.
  maybeRepack()
}

// ─── shared spaces (share links) ────────────────────────────────
// A link (see share-link.ts) opens its apps in an ephemeral space: apps the
// user has run as their installed copy, the rest as temp~ apps that leave
// nothing behind. Keep installs those for real and promotes the space; Discard
// or a reload drops everything.

// What each temp window came from — the fetched files, installed under their
// real id by Keep, and the link input Share writes back out.
const sharedTemps = new Map<string, { input: string; fetched: NsiteResult }>()
// Cap per link action: an app that never registers the handler would otherwise
// hang the import (callIframe waits for the registration).
const LINK_ACTION_MS = 15_000
// Windows opened into the grid keep the height they were given (user-sized
// holds off the default height cap).
const GRID_STATUS = {
  minimized: false,
  maximized: false,
  pinned: false,
  userSized: true,
  zIndex: 0
}

function reportShareLinkError(err: any) {
  console.error("[share-link] error:", err)
  setStatus(`Share link error: ${err.message}`)
}

// The temp id mirrors the real one (`<pubkey16>~<d>`) behind a temp~ prefix.
// Not the link input: nappOriginFor cuts the id to the 63-char DNS label, and
// an naddr can put kind and author first, so two apps by one author would
// truncate to the same origin — and two boot iframes would then answer that
// origin's file requests with different apps' files.
function tempNappIdFor(target: { pubkey: string; dTag: string }): string {
  return `temp~${target.pubkey.slice(0, 16)}~${target.dTag}`
}

// The match handlers.findHandlersForAction makes: exact, or "view" for any view:<kind>.
function handlesAction(declared: string[], name: string): boolean {
  return declared.includes(name) || (name.startsWith("view:") && declared.includes("view"))
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      v => {
        clearTimeout(t)
        resolve(v)
      },
      err => {
        clearTimeout(t)
        reject(err)
      }
    )
  })
}

// An equal grid for n windows in reading order: ceil(√n) columns, the last row
// sharing its width between what's left. Same pixel convention as tileWindows.
function gridCells(n: number): Position[] {
  const b = getStageBounds(stage)
  const width = b.width > 0 ? b.width : 960
  const height = b.height > 0 ? b.height : 600
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellH = height / rows
  const gap = 8
  const cells: Position[] = []
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols)
    const inRow = r === rows - 1 ? n - r * cols : cols
    const c = i - r * cols
    const cellW = width / inRow
    const x0 = Math.round(b.padL + c * cellW)
    const x1 = Math.round(b.padL + (c + 1) * cellW)
    const y0 = Math.round(b.padT + r * cellH)
    const y1 = Math.round(b.padT + (r + 1) * cellH)
    cells.push({
      left: x0 + gap / 2,
      top: y0 + gap / 2,
      width: Math.max(0, x1 - x0 - gap),
      height: Math.max(0, y1 - y0 - gap)
    })
  }
  return cells
}

type LinkEntry = {
  input: string
  actions: LinkAction[]
  title: string
  // The installed id, or the temp id the app will run under.
  nappId: string
  installed?: InstalledApp
  fetched?: NsiteResult
  // Actions the app handles (its manifest's action tags).
  declared: string[]
}

async function importShareLink(hash: string) {
  const link = parseShareLink(hash)
  if (!link) return
  // Out of the address bar right away: a reload lands on the user's own spaces,
  // and a cancelled import leaves nothing behind.
  history.replaceState(null, "", location.pathname + location.search)
  setStatus(`Opening shared space "${link.name}"…`)

  // Resolve (and fetch) every app first, so the consent screen is one screen.
  const entries: LinkEntry[] = []
  for (const w of link.windows) {
    let target
    try {
      target = resolveInput(w.input)
    } catch (err: any) {
      setStatus(`Skipping ${w.input}: ${err.message}`)
      continue
    }
    if (target.kind && isNappletKind(target.kind)) {
      setStatus(`Skipping ${w.input}: napplets can't be shared yet`)
      continue
    }
    const installed = persist.getInstalledApp(`${target.pubkey.slice(0, 16)}~${target.dTag}`)
    if (installed) {
      entries.push({
        input: w.input,
        actions: w.actions,
        title: installed.petname || installed.title || installed.nappId,
        nappId: installed.nappId,
        installed,
        declared: installed.actions
      })
      continue
    }
    const tempId = tempNappIdFor(target)
    try {
      // The same app twice in a link is fetched once.
      const fetched =
        entries.find(e => e.nappId === tempId)?.fetched ?? (await fetchNsite(target, setStatus))
      entries.push({
        input: w.input,
        actions: w.actions,
        title: fetched.title || target.dTag,
        nappId: tempId,
        fetched,
        declared: capabilitiesFromEvent(fetched.manifest)
      })
    } catch (err: any) {
      setStatus(`Couldn't fetch ${w.input}: ${err.message}`)
    }
  }
  if (!entries.length) {
    setStatus("Nothing in that link could be opened")
    return
  }

  const declaredOf = (e: LinkEntry) =>
    requiresFromEvent(e.installed ? e.installed.event : e.fetched!.manifest)
  const granted = await promptSharedSpace({
    name: link.name,
    taken: persist.listSpaces().map(s => s.name),
    apps: entries.map(e => {
      const iconTag = e.fetched?.manifest?.tags.find(t => t[0] === "icon")?.[1]
      return {
        key: e.nappId,
        title: e.title,
        icon: e.installed ? installedIconSrc(e.installed) : directIconSrc(iconTag),
        iconBlob: e.fetched
          ? iconBlobFrom(iconTag, e.fetched.files, e.fetched.manifest)
          : undefined,
        type: e.installed
          ? persist.classifyInstalled(e.installed)
          : manifestAppType(e.fetched!.manifest),
        installed: !!e.installed,
        declaredDomains: declaredOf(e),
        actions: e.actions.map(a => ({ ...a, supported: handlesAction(e.declared, a.name) }))
      }
    })
  })
  if (!granted) {
    setStatus("Shared space cancelled")
    return
  }
  // Each temp app's grant from that screen is its policy — the first-run gate
  // install() runs, answered here.
  for (const e of entries) {
    const policy = e.fetched ? granted.policies.get(e.nappId) : undefined
    if (policy) persist.setPolicy(e.nappId, policy)
  }

  const spaceId = persist.createEphemeralSpace(granted.name)
  await switchSpace(spaceId)
  renderSpacesBar()

  const cells = gridCells(entries.length)
  const opened: Array<{ instanceId: string; entry: LinkEntry }> = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    try {
      const win = e.fetched
        ? await launchSharedTemp(e.nappId, e.input, e.fetched, e.title, cells[i])
        : await launch(stage, e.nappId, {
            ...makeLaunchOpts(),
            petname: e.title,
            position: cells[i],
            status: GRID_STATUS
          })
      syncDOM(win)
      const state = win.getState()
      // A launch alone doesn't persist a window (its first state change does);
      // the entry is needed now, for the actions to be recorded on it.
      persist.updateOpen(state.instanceId, state)
      opened.push({ instanceId: state.instanceId, entry: e })
    } catch (err: any) {
      setStatus(`Couldn't open ${e.title}: ${err.message}`)
    }
  }
  // Actions in link order, through the dispatcher so they're recorded on the
  // window (replayed when its iframe reloads, carried over by Keep).
  for (const { instanceId, entry } of opened) {
    for (const a of entry.actions) {
      if (!handlesAction(entry.declared, a.name)) continue
      try {
        await withTimeout(
          runNappAction("link", a.name, decodePayload(a.name, a.payload), { instance: instanceId }),
          LINK_ACTION_MS,
          `${a.name} on ${entry.title}`
        )
      } catch (err: any) {
        setStatus(`${a.name} failed for ${entry.title}: ${err.message}`)
      }
    }
  }
  setStatus(`Opened shared space "${link.name}" — keep it to install its apps`)
}

// A temp~ app for a shared space: booted like a /dev app (its origin is swept
// on the next boot), its files kept for Keep. The policy is already stored.
async function launchSharedTemp(
  nappId: string,
  input: string,
  fetched: NsiteResult,
  petname: string,
  position: Position
): Promise<NappWindow> {
  if (!sharedTemps.has(nappId)) {
    const { files, title, manifest, singleton } = fetched
    setTempFiles(nappId, files)
    setStatus(`Booting ${petname}…`)
    await bootDevApp(nappOriginFor(nappId), nappId, setStatus, petname)
    persist.storeDevApp({
      nappId,
      title: title || null,
      icon: manifest?.tags.find(t => t[0] === "icon")?.[1] || null,
      petname,
      actions: capabilitiesFromEvent(manifest),
      requires: requiresFromEvent(manifest),
      modes: persist.modesFromEventTags(manifest?.tags ?? []),
      initialSize: persist.initialSizeFromEventTags(manifest?.tags ?? []),
      singleton
    })
    handlers.addApp(nappId, capabilitiesFromEvent(manifest))
    sharedTemps.set(nappId, { input, fetched })
  }
  return launch(stage, nappId, { ...makeLaunchOpts(), petname, position, status: GRID_STATUS })
}

// Keep one temp app: install it for real from the files it was fetched with,
// under the grant the link's screen gave it and in the temp entry's place in
// the list; put each of its windows back under the real origin — in the space
// it was in, with its layout and actions — and wipe the temp one. The real id,
// or null if it wasn't a temp app.
async function keepTempApp(tempId: string): Promise<string | null> {
  const src = sharedTemps.get(tempId)
  if (!src) return null
  const realId = src.fetched.nappId
  if (!persist.hasPolicy(realId)) persist.setPolicy(realId, persist.getPolicy(tempId))
  await installFetched(src.fetched, src.input, persist.getInstalledApp(tempId)?.installedAt)
  const restore = persist
    .allOpenWindows()
    .filter(w => w.window.nappId === tempId)
    .map(({ spaceId, window: w }) => ({
      spaceId,
      petname: w.petname,
      position: w.position,
      status: w.status,
      actions: w.loadedActions ?? []
    }))
  // The temp app goes — windows, record, policy, origin — explicitly, the way
  // uninstall does it: the windows' own destroy hook only sees the current
  // space, and a temp window may live in another. The real app takes their
  // place and gets its actions again.
  uninstallingNapps.add(tempId)
  try {
    destroyByNappId(tempId)
    await finalizeNappRemoval(tempId, "Wiping")
  } catch (err: any) {
    console.warn("[keep] temp wipe failed", { tempId, err })
  } finally {
    uninstallingNapps.delete(tempId)
  }
  sharedTemps.delete(tempId)
  for (const { spaceId, actions, ...r } of restore) {
    const win = await launch(stage, realId, { ...makeLaunchOpts(), ...r })
    syncDOM(win)
    const state = win.getState()
    persist.updateOpen(state.instanceId, state)
    if (spaceId !== currentSpaceId) {
      moveWindowToSpace(state.instanceId, spaceId)
      persist.moveOpenToSpace(state.instanceId, spaceId)
    }
    for (const a of actions) {
      await withTimeout(
        runNappAction("link", a.name, a.payload, { instance: state.instanceId }),
        LINK_ACTION_MS,
        `${a.name} on ${r.petname}`
      )
    }
  }
  notifyAppsChanged()
  return realId
}

// Keep: every temp app of the space kept for real, then the space promoted.
async function keepCurrentSpace() {
  const spaceId = currentSpaceId
  if (!persist.isEphemeralSpace(spaceId)) return
  const name = persist.listSpaces().find(s => s.id === spaceId)?.name || "space"
  const temps = new Set(
    persist
      .readOpen()
      .filter(w => !w.system && sharedTemps.has(w.nappId))
      .map(w => w.nappId)
  )
  for (const tempId of temps) {
    try {
      await keepTempApp(tempId)
    } catch (err: any) {
      setStatus(`Couldn't keep ${friendlyNameFor(tempId)}: ${err.message}`)
      return
    }
  }
  persist.promoteSpace(spaceId)
  renderSpacesBar()
  setStatus(`Kept space "${name}"`)
}

// Share: the current space as a link. The share screen (share-dialog.ts, the
// consent screen's twin) lists every window in visual reading order — the
// receiver lays them out from link order alone — with the last payload it got
// per action, lets the user rename, untick and edit, runs one reachability
// check over every app (checkReachable), and shows the link. Windows with no
// address (system, dev, local) are listed as such and can't be included.
const SHARE_HINTS_MAX = 4

async function shareCurrentSpace() {
  const name = persist.listSpaces().find(s => s.id === currentSpaceId)?.name || "space"
  const row = (w: NappWindowState) => Math.round((w.position?.top ?? 0) / 60)
  const windows = persist
    .readOpen()
    .filter(w => !w.system)
    .sort((a, b) => row(a) - row(b) || (a.position?.left ?? 0) - (b.position?.left ?? 0))
  if (!windows.length) {
    setStatus("Nothing open in this space")
    return
  }
  // Icons the way the Apps card gets them — an installed app's probed (and
  // cached) blossom src, waited on briefly so the screen opens promptly; a
  // temp app's from the bytes it was fetched with.
  const shareWindows: ShareWindow[] = await Promise.all(
    windows.map(async (w): Promise<ShareWindow> => {
      const installed = persist.getInstalledApp(w.nappId)
      const temp = sharedTemps.get(w.nappId)?.fetched
      const iconTag = temp?.manifest?.tags.find(t => t[0] === "icon")?.[1]
      const icon = installed
        ? await withTimeout(iconSrcFor(installed, true), 1500, "icon").catch(() => null)
        : null
      const last = new Map<string, unknown>()
      for (const a of w.loadedActions ?? []) last.set(a.name, a.payload)
      return {
        key: w.nappId,
        title: w.petname,
        icon: icon ?? undefined,
        iconBlob: temp ? iconBlobFrom(iconTag, temp.files, temp.manifest) : undefined,
        type: persist.classifyNappId(w.nappId),
        shareable: !!shareableFor(w.nappId),
        actions: [...last].map(([n, p]) => ({ name: n, payload: encodePayload(n, p) }))
      }
    })
  )
  await openShareDialog({
    name,
    windows: shareWindows,
    // The screen shows checking… / all good / error per app; the status line
    // narrates the steps.
    check: keys =>
      checkReachable(
        keys.flatMap(k => {
          const app = shareableFor(k)
          return app ? [[k, app] as const] : []
        }),
        (key, msg) => setStatus(`${shareWindows.find(w => w.key === key)?.title ?? key}: ${msg}`)
      ),
    buildLink: (n, ws) =>
      buildShareLink({ name: n, windows: ws }, `${location.origin}${location.pathname}`),
    encode: encodePayload
  })
}

type Shareable = { manifest: NostrEvent; dTag: string; files(): Promise<NsiteFile[]> }

// What a window's app can be shared as: its manifest, and its bytes for the
// healing — a temp app's fetched files, an installed app's read back out of
// its origin. Null for apps with no address (dev, local, napplets).
function shareableFor(nappId: string): Shareable | null {
  const temp = sharedTemps.get(nappId)
  const manifest = temp ? temp.fetched.manifest : persist.getInstalledApp(nappId)?.event
  if (!manifest || manifest.kind !== 35128) return null
  const dTag = manifest.tags.find(t => t[0] === "d")?.[1]
  if (!dTag) return null
  return {
    manifest,
    dTag,
    files: temp ? async () => temp.fetched.files : () => readNappFiles(nappId)
  }
}

// One check over every app the link carries: each manifest republished and
// its blobs probed, one upload auth for everything missing (one signing
// prompt), and per app the naddr with the relays holding its manifest as
// hints. Never fails the share: an app whose check errors out gets an naddr
// without hints, and says so.
async function checkReachable(
  apps: Array<readonly [string, Shareable]>,
  onProgress: (key: string, msg: string) => void
): Promise<Map<string, ShareCheck>> {
  const naddrFor = (app: Shareable, relays: string[]) =>
    naddrEncode({
      pubkey: app.manifest.pubkey,
      kind: app.manifest.kind,
      identifier: app.dTag,
      relays
    })
  const out = new Map<string, ShareCheck>()
  const failed = (key: string, app: Shareable, err: any) => {
    const error = `check failed: ${err?.message ?? String(err)}`
    onProgress(key, error)
    out.set(key, { input: naddrFor(app, []), uploaded: 0, missing: "", hints: 0, error })
  }

  // Every app's relays, servers and bytes, gathered at once.
  const ready: Array<{ key: string; app: Shareable; target: ReplicationTarget }> = []
  await Promise.all(
    apps.map(async ([key, app]) => {
      const { manifest } = app
      try {
        onProgress(key, "finding relays…")
        // Where it was seen this session, the author's write relays, the napp relays.
        const seen = Array.from(pool.seenOn.get(manifest.id) || []).map((r: any) => r.url as string)
        const relays = [...new Set([...seen, ...(await manifestRelays(manifest.pubkey))])]
        const servers = await blobServers(manifest, manifest.pubkey)
        let files: NsiteFile[] = []
        try {
          files = await app.files()
        } catch (err) {
          console.warn("[share] can't read the app's files", err) // probe-only, then
        }
        const byPath = new Map(manifestPaths(manifest).map(p => [p.path, p]))
        ready.push({
          key,
          app,
          target: {
            manifest,
            relays,
            servers,
            files: files.flatMap(f => {
              const p = byPath.get(f.path.startsWith("/") ? f.path : `/${f.path}`)
              return p ? [{ sha: p.sha, body: f.body, mime: f.mime || p.mime }] : []
            }),
            onProgress: msg => onProgress(key, msg)
          }
        })
      } catch (err) {
        failed(key, app, err)
      }
    })
  )
  // Keep the caller's order, so the one signing prompt lists apps as shown.
  ready.sort((a, b) => apps.findIndex(x => x[0] === a.key) - apps.findIndex(x => x[0] === b.key))

  try {
    const results = await ensureReplicatedAll(ready.map(r => r.target))
    ready.forEach((r, i) => {
      const res = results[i]
      const hints = res.relays.slice(0, SHARE_HINTS_MAX)
      const n = res.missing.length
      out.set(r.key, {
        input: naddrFor(r.app, hints),
        uploaded: res.uploaded,
        missing: n ? `${n} file${n === 1 ? "" : "s"}` : "",
        hints: hints.length
      })
    })
  } catch (err) {
    for (const r of ready) failed(r.key, r.app, err)
  }
  return out
}
