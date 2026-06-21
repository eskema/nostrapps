import type {
  SystemLaunchOpts,
  LaunchOpts,
  NappWindow,
  NappWindowState,
  Signer,
  SignerGetter,
  MessageData,
  NsiteFile,
  SystemNappDef,
  PackCell,
  GridRect,
  SystemCtx
} from "../types.js"

import { isGated, requireApproval } from "../permissions.js"
import { dispatchAction } from "../handlers.js"
import { setPointer } from "../pointer.js"
import { getStore } from "../store.js"
import { createNappWindow } from "./napp-window.js"
import {
  loadBlossomServers,
  loadBookmarks,
  loadEmojis,
  loadFavoriteRelays,
  loadFavoriteScrolls,
  loadFollowsList,
  loadMuteList,
  loadPins,
  loadRelayList,
  loadWikiAuthors,
  loadWikiRelays
} from "@nostr/gadgets/lists"
import { loadEmojiSets, loadFollowPacks, loadFollowSets, loadRelaySets } from "@nostr/gadgets/sets"
import { loadNostrUser } from "@nostr/gadgets/metadata"
import { loadRelayInfo } from "@nostr/gadgets/relays"
import { pool } from "@nostr/gadgets/global"
import type { SubCloser } from "@nostr/tools/abstract-pool"
import type { NostrEvent } from "@nostr/tools/core"
import { matchFilter, type Filter } from "@nostr/tools/filter"
import { isNip05, queryProfile } from "@nostr/tools/nip05"
import { decode } from "@nostr/tools/nip19"
import { getInstalledApp, updateOpen } from "../persistence.js"
import { currentSigner } from "../signers/index.js"
import { current as outboxCurrent, outbox, FALLBACK_RELAYS } from "../outbox.js"
import { debounce } from "../utils.js"

const BOOT_TIMEOUT_MS = 10_000

const store = getStore()

const openWindows = new Map<string, NappWindow>()

// Which space's windows are currently visible. Windows from other spaces stay
// mounted (so their iframes keep their state) but get `.space-inactive`
// (display:none). A window is "born" into whatever space is active when it's
// created, recorded on its root as data-space.
let activeSpace = ""

// Tag a freshly-created window with the active space and make sure it shows.
function adoptWindow(win: NappWindow) {
  win.root.dataset.space = activeSpace
  win.root.classList.remove("space-inactive")
}

// A genuinely NEW window opened while pack mode is on (stage has the `pack-mode`
// class) is flagged so bestFitPack sizes it 1×2 and appends it at the end,
// instead of shoving it into the top-left and reflowing existing windows.
// `hasPosition` is true for restored / reopened windows — those carry a saved
// layout and must keep it, so they're never flagged. Singleton reuse returns
// before creation, so reused windows are never flagged either.
function flagFreshInPack(stageEl: HTMLElement, win: NappWindow, hasPosition: boolean) {
  if (!hasPosition && stageEl.classList.contains("pack-mode")) win.root.dataset.packNew = "1"
}

// Switch which space is visible: show its windows, hide every other space's.
// Pure visibility — nothing is mounted or unmounted, so iframe state survives.
export function setActiveSpace(id: string) {
  activeSpace = id
  for (const win of openWindows.values()) {
    const owns = (win.root.dataset.space || "") === id
    win.root.classList.toggle("space-inactive", !owns)
  }
}

// True only for a tracked window that belongs to a NON-active space. Used to
// skip persisting background-space windows. A window mid-creation isn't in
// openWindows yet, so this returns false and its initial state still persists.
export function isWindowInactive(instanceId: string): boolean {
  const win = openWindows.get(instanceId)
  return !!win && (win.root.dataset.space || "") !== activeSpace
}

// Every live instance id across all materialized spaces (for serial bumping).
export function allInstanceIds(): string[] {
  return [...openWindows.keys()]
}

let iframeCallSerial = 1
let instanceIdSerial = 1
export function setInstanceIdSerial(val: number) {
  instanceIdSerial = val
}

const readyWaits = new Map<string, Promise<void>>()
const readyResolve = new Map<string, () => void>()
// Instances whose iframe has signalled napp-ready (so its document is loaded at
// the napp origin). Until then the iframe is still on about:blank, whose origin
// is the launcher's — posting there with the napp origin logs an uncatchable
// "target origin does not match" error. broadcastTheme skips non-ready ones.
const readyInstances = new Set<string>()
const registeredActions = new Map<string, Array<{ idx: number | undefined; pattern: string }>>()
const feedRequests = new Map<
  string,
  Map<string, { controller: AbortController; closer?: SubCloser; cleanup?: () => void }>
>()
const actionWaiters = new Map<
  string,
  Array<{
    name: string
    resolve(entry: { idx: number | undefined; pattern: string }): void
    reject(err: Error): void
  }>
>()

function matchesActionPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (pattern === "view" && name.startsWith("view:")) return true
  return false
}

function findRegisteredAction(instanceId: string, name: string) {
  return (
    (registeredActions.get(instanceId) || []).find(entry =>
      matchesActionPattern(entry.pattern, name)
    ) || null
  )
}

function addRegisteredAction(
  instanceId: string,
  entry: { idx: number | undefined; pattern: string }
) {
  const list = registeredActions.get(instanceId) || []
  list.push(entry)
  registeredActions.set(instanceId, list)

  const waiters = actionWaiters.get(instanceId)
  if (!waiters?.length) return
  const pending = []
  for (const waiter of waiters) {
    if (matchesActionPattern(entry.pattern, waiter.name)) waiter.resolve(entry)
    else pending.push(waiter)
  }
  if (pending.length === 0) actionWaiters.delete(instanceId)
  else actionWaiters.set(instanceId, pending)
}

function clearInstanceActionState(
  instanceId: string,
  reason = "Window closed before action registered"
) {
  registeredActions.delete(instanceId)
  const waiters = actionWaiters.get(instanceId)
  if (waiters?.length) {
    for (const waiter of waiters) waiter.reject(new Error(reason))
  }
  actionWaiters.delete(instanceId)
}

function clearReady(instanceId: string) {
  readyWaits.delete(instanceId)
  readyResolve.delete(instanceId)
  readyInstances.delete(instanceId)
}

function clearInstanceRuntimeState(
  instanceId: string,
  reason = "Window closed before action registered"
) {
  clearReady(instanceId)
  clearInstanceActionState(instanceId, reason)
  clearInstanceFeedRequests(instanceId)
}

function clearInstanceFeedRequests(instanceId: string) {
  const requests = feedRequests.get(instanceId)
  if (!requests) return
  for (const request of requests.values()) {
    request.controller.abort()
    request.closer?.close("napp closed")
    request.cleanup?.()
  }
  feedRequests.delete(instanceId)
}

function trackFeedRequest(
  instanceId: string,
  requestId: string,
  request: { controller: AbortController; cleanup?: () => void }
) {
  let requests = feedRequests.get(instanceId)
  if (!requests) {
    requests = new Map()
    feedRequests.set(instanceId, requests)
  }
  const existing = requests.get(requestId)
  existing?.controller.abort()
  existing?.closer?.close("feed replaced")
  existing?.cleanup?.()
  requests.set(requestId, request)
}

function finishFeedRequest(instanceId: string, requestId: string) {
  const requests = feedRequests.get(instanceId)
  if (!requests) return
  const request = requests.get(requestId)
  request?.cleanup?.()
  requests.delete(requestId)
  if (requests.size === 0) feedRequests.delete(instanceId)
}

function cancelFeedRequest(instanceId: string | undefined, requestId: string | undefined) {
  if (!instanceId || !requestId) return false
  const requests = feedRequests.get(instanceId)
  const request = requests?.get(requestId)
  if (!request) return false
  request.controller.abort()
  request.closer?.close("napp aborted feed")
  finishFeedRequest(instanceId, requestId)
  return true
}

function resetInstanceRuntimeState(
  instanceId: string,
  reason = "Window reloaded before action registered"
) {
  clearInstanceRuntimeState(instanceId, reason)
  trackReady(instanceId)
}

function trackReady(instanceId: string) {
  if (!readyWaits.has(instanceId)) {
    readyWaits.set(
      instanceId,
      new Promise<void>(resolve => {
        readyResolve.set(instanceId, resolve)
      })
    )
  }
}

function resolveReady(instanceId: string) {
  readyInstances.add(instanceId)
  const resolve = readyResolve.get(instanceId)
  if (resolve) {
    readyResolve.delete(instanceId)
    resolve()
  }
}

export function waitReady(instanceId: string): Promise<void> {
  return readyWaits.get(instanceId) || Promise.resolve()
}

export async function waitForRegisteredAction(instanceId: string, name: string) {
  const existing = findRegisteredAction(instanceId, name)
  if (existing) return existing
  await waitReady(instanceId)
  const afterReady = findRegisteredAction(instanceId, name)
  if (afterReady) return afterReady
  return await new Promise<{ idx: number | undefined; pattern: string }>((resolve, reject) => {
    const waiters = actionWaiters.get(instanceId) || []
    waiters.push({ name, resolve, reject })
    actionWaiters.set(instanceId, waiters)
  })
}

export function nappOriginFor(nappId: string): string {
  const slug = nappId.slice(0, 63).replace(/[^a-zA-Z0-9.-]/g, "-")
  return `${location.protocol}//${slug}.${location.host}`
}

export async function launch(stageEl: HTMLElement, nappId: string, opts: LaunchOpts = {}) {
  const singleton = singletonForNappId(nappId)

  if (singleton === null) throw new Error(`failed to launch uninstalled app ${nappId}`)

  if (singleton) {
    const existing = findOpenWindowByNappId(nappId)
    if (existing) {
      // Single instance: if it lives in another (hidden) space, adopt it into
      // the active one so launching surfaces it where you are.
      adoptWindow(existing)
      existing.focus?.()
      return existing
    }
  }

  const origin = nappOriginFor(nappId)
  const win = mount(stageEl, nappId, singleton, origin, currentSigner, opts)
  const st = win.getState()
  console.debug("[launch] trackOpened", {
    nappId,
    instanceId: st.instanceId,
    petname: st.petname
  })
  updateOpen(st.instanceId, st)

  return win
}

function singletonForNappId(nappId: string): boolean | null {
  const app = getInstalledApp(nappId)
  return app ? app.singleton : null
}

function currentTheme(): "light" | "dark" {
  const attr = document.documentElement.dataset.theme
  if (attr === "light" || attr === "dark") return attr
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

// Theme-change payload forwarded to napps. Carries the theme name plus the
// launcher's *resolved* color tokens (read from its own computed styles, so the
// CSS stays the single source of truth) — napps apply these as inline vars and
// match the launcher without hardcoding any colors of their own.
function themePayload() {
  const cs = getComputedStyle(document.documentElement)
  return {
    __nostrapps: "napp-theme-change" as const,
    theme: currentTheme(),
    vars: {
      surface: cs.getPropertyValue("--surface").trim(),
      text: cs.getPropertyValue("--text").trim()
    }
  }
}

export function broadcastTheme() {
  const payload = themePayload()
  for (const [instanceId, win] of openWindows) {
    if (win.root) {
      win.root.style.setProperty("--theme", payload.theme)
    }
    // Only post to napps that have signalled ready — others are still on
    // about:blank (origin mismatch) and will get the theme on their napp-ready.
    if (!readyInstances.has(instanceId)) continue
    if (win.iframe?.contentWindow) {
      try {
        const origin = new URL(win.iframe.src).origin
        win.iframe.contentWindow.postMessage(payload, origin)
      } catch (err) {
        console.warn("[sandbox] broadcastTheme failed", {
          nappId: win.root.dataset.nappId,
          src: win.iframe.src,
          err
        })
      }
    }
  }
}

export function focusInstance(instanceId: string): boolean {
  const win = openWindows.get(instanceId)
  if (!win) return false
  win.focus?.()
  return true
}

// Close only the given space's windows (used when resetting or destroying a
// space — its windows are genuinely gone, unlike a plain switch which hides).
export function teardownSpaceWindows(spaceId: string) {
  for (const win of [...openWindows.values()]) {
    if ((win.root.dataset.space || "") === spaceId) win.close()
  }
}

// Snapshot of the live windows, for the spaces bar's window list.
export function listOpenWindows(): Array<{
  instanceId: string
  nappId: string
  petname: string
  systemId?: string
  minimized: boolean
}> {
  const out = []
  for (const [instanceId, win] of openWindows) {
    // Only the active space's windows belong on the bar's taskbar.
    if ((win.root.dataset.space || "") !== activeSpace) continue
    const st = win.getState()
    out.push({
      instanceId,
      nappId: st.nappId,
      petname: st.petname || st.nappId,
      systemId: win.systemId,
      minimized: !!st.status.minimized
    })
  }
  return out
}

export function destroyByNappId(nappId: string): number {
  // Snapshot — destroy() mutates openWindows.
  const targets = []
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId) targets.push(win)
  }
  for (const win of targets) win.destroy()
  return targets.length
}

export function findOpenWindowByNappId(nappId: string): NappWindow | null {
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId) return win
  }
  return null
}

// Launcher → iframe dispatch calls (action). Each call gets a
// requestId; the iframe replies with that id once `window.napp.onAction`
// has run.
const pendingDispatches = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>()

export async function callIframe(
  instanceId: string,
  actionName: string,
  actionPayload: unknown
): Promise<unknown> {
  // resolve nevent/naddr payload for view:* actions
  if (actionName.startsWith("view:") && typeof actionPayload === "string") {
    const event = await loadEvent({ code: actionPayload })
    if (event) actionPayload = event
    else {
      console.warn(
        `Stopped routing of ${actionName}->${actionPayload} to ${instanceId}: couldn't find event`
      )
      return
    }
  }

  await waitReady(instanceId)
  const win = openWindows.get(instanceId)
  if (!win || !win.iframe) {
    throw new Error(`No iframe for instance ${instanceId}`)
  }
  const origin = new URL(win.iframe.src).origin
  const requestId = `${iframeCallSerial++}`

  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => {
      pendingDispatches.delete(requestId)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    pendingDispatches.delete(requestId)
    pendingDispatches.set(requestId, {
      resolve: result => {
        resolve(result)
      },
      reject: err => {
        reject(err)
      }
    })
    console.debug("[sandbox] dispatching action to iframe", {
      instanceId,
      nappId: win.root.dataset.nappId,
      requestId,
      name: actionName
    })
    ;(async () => {
      const { idx } = await waitForRegisteredAction(instanceId, actionName)
      win.iframe!.contentWindow?.postMessage(
        {
          __nostrapps: "napp-dispatch-action",
          requestId,
          idx,
          name: actionName,
          payload: actionPayload
        },
        origin
      )
    })().catch(fail)
  })
}

function settleDispatch(data: Extract<MessageData, { __nostrapps: "napp-dispatch-result" }>) {
  const p = pendingDispatches.get(data.requestId!)
  if (!p) return
  pendingDispatches.delete(data.requestId!)
  if (data.__nostrapps === "napp-dispatch-result") p.resolve(data.result)
  else p.reject(new Error(data.error || "dispatch failed"))
}

// Re-run the install flow into the napp's existing origin without spawning
// a new visible window. boot.html's install handler clears its files store
// before writing, so this swaps the files atomically for in-place updates.
export async function reinstallFiles(
  nappId: string,
  files: NsiteFile[],
  onProgress?: (msg: string) => void,
  label?: string
) {
  const origin = nappOriginFor(nappId)
  console.debug("[sandbox] reinstallFiles", { nappId, origin, fileCount: files.length, label })
  await bootNapp(origin, files, onProgress ?? (() => {}), label || nappId)
}

// Reload every open iframe whose dataset.nappId matches. Reassigning
// iframe.src triggers a same-origin navigation; window.name (the bridge's
// instanceId) is preserved across same-origin reloads.
export function reloadIframesByNappId(nappId: string): number {
  let count = 0
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId && win.iframe) {
      resetInstanceRuntimeState(win.root.dataset.instanceId || "")
      win.iframe.src = win.iframe.src
      count++
    }
  }
  return count
}

const systemSingletons = new Map<string, string>() // sysId -> instanceId

// The space currently holding the live (singleton) system napp, or null if it
// isn't mounted anywhere. Used to navigate to a system napp's home space.
export function spaceOfLiveSystem(sysId: string): string | null {
  const id = systemSingletons.get(sysId)
  const win = id ? openWindows.get(id) : undefined
  return win ? win.root.dataset.space || null : null
}

export function launchSystem(
  stageEl: HTMLElement,
  sysId: string,
  def: SystemNappDef,
  ctx: SystemCtx,
  opts: SystemLaunchOpts = {}
) {
  console.debug("[sandbox] launchSystem", { sysId, def, opts })
  const singleton = def.singleton !== false
  if (singleton) {
    const existing = systemSingletons.get(sysId)
    if (existing && openWindows.has(existing)) {
      console.debug("[sandbox] launchSystem: reusing existing singleton", {
        sysId,
        instanceId: existing
      })
      // A system napp is a single instance. If it currently lives in another
      // (hidden) space, adopt it into the active one so invoking it always
      // surfaces it where you are, rather than focusing a display:none window.
      const win = openWindows.get(existing)!
      adoptWindow(win)
      focusInstance(existing)
      return win
    }
  }

  let win: NappWindow | null = null
  const instanceId =
    opts.instanceId || singleton ? `system:${sysId}` : `system:${sysId}:${instanceIdSerial++}`
  const bodyElement = document.createElement("div")
  bodyElement.className = `system-napp-content system-napp-${sysId}`

  const handle = def.mount(bodyElement, ctx, {
    params: opts.params,
    onStateChange(sysState: NappWindowState) {
      if (win) opts.onStateChange?.({ ...win.getState(), ...sysState })
    }
  })

  win = createNappWindow({
    nappId: `__${sysId}__`,
    instanceId,
    petname: def.title || sysId,
    bodyElement,
    system: true,
    onStateChange: state => opts.onStateChange?.(state),
    onClose: () => {
      handle && handle.unmount?.()
      openWindows.delete(instanceId)
      clearInstanceRuntimeState(instanceId)
      if (singleton) systemSingletons.delete(sysId)
      opts.onClose?.(instanceId)
    },
    onReorder: opts.onReorder,
    position: opts.position,
    status: opts.status
  })
  win.systemId = sysId
  adoptWindow(win)
  flagFreshInPack(stageEl, win, !!opts.position)
  stageEl.appendChild(win.root)
  openWindows.set(instanceId, win)
  if (singleton) systemSingletons.set(sysId, instanceId)
  ensureStageObserver(stageEl)
  clampToStage(win.root, stageEl)
  return win
}

function mount(
  stageEl: HTMLElement,
  nappId: string,
  singleton: boolean,
  origin: string,
  signer: Signer | SignerGetter,
  opts: LaunchOpts = {}
) {
  const {
    instanceId = singleton ? nappId : opts.instanceId ? opts.instanceId : `${instanceIdSerial++}`,
    petname,
    onProgress = () => {},
    onStateChange,
    onReorder,
    onClose,
    onDestroy,
    position,
    status
  } = opts

  onProgress(`Starting ${petname || nappId}…`)
  const win = createNappWindow({
    nappId,
    instanceId,
    origin,
    src: `${origin}/`,
    petname,
    position,
    status,
    onMessage: (data, iframe) => {
      switch (data.__nostrapps) {
        case "napp-ready": {
          resolveReady(data.instanceId!)
          iframe.contentWindow?.postMessage(themePayload(), origin)
          return
        }
        case "napp-action-registered": {
          addRegisteredAction(instanceId, { idx: data.idx, pattern: data.pattern })
          return
        }
        case "rpc": {
          handleRpc(data, iframe, signer, nappId)
          return
        }
        case "napp-dispatch-result": {
          settleDispatch(data)
          return
        }
      }
    },
    onClose: () => {
      openWindows.delete(instanceId)
      clearInstanceRuntimeState(instanceId)
      onClose?.(instanceId)
    },
    onDestroy: () => {
      openWindows.delete(instanceId)
      clearInstanceRuntimeState(instanceId)
      onDestroy?.(instanceId)
    },
    onStateChange,
    onReorder
  })
  adoptWindow(win)
  flagFreshInPack(stageEl, win, !!position)
  stageEl.appendChild(win.root)
  openWindows.set(instanceId, win)
  resetInstanceRuntimeState(instanceId, "Window remounted before action registered")
  ensureStageObserver(stageEl)
  clampToStage(win.root, stageEl)
  return win
}

export function mountWithLoading(
  stageEl: HTMLElement,
  nappId: string,
  origin: string,
  opts: LaunchOpts = {}
): NappWindow {
  const {
    instanceId = `${instanceIdSerial++}`,
    petname,
    onStateChange,
    onReorder,
    onClose,
    onDestroy,
    position,
    status
  } = opts

  const win = createNappWindow({
    nappId,
    instanceId,
    origin,
    petname,
    loading: true,
    position,
    status,
    onMessage: (data, iframe) => {
      switch (data.__nostrapps) {
        case "napp-ready": {
          resolveReady(data.instanceId!)
          iframe.contentWindow?.postMessage(themePayload(), origin)
          return
        }
        case "napp-action-registered": {
          addRegisteredAction(instanceId, { idx: data.idx, pattern: data.pattern })
          return
        }
        case "rpc": {
          handleRpc(data, iframe, currentSigner, nappId)
          return
        }
        case "napp-dispatch-result": {
          settleDispatch(data)
          return
        }
      }
    },
    onClose: () => {
      openWindows.delete(instanceId)
      clearInstanceRuntimeState(instanceId)
      onClose?.(instanceId)
    },
    onDestroy: () => {
      openWindows.delete(instanceId)
      clearInstanceRuntimeState(instanceId)
      onDestroy?.(instanceId)
    },
    onStateChange,
    onReorder
  })
  adoptWindow(win)
  flagFreshInPack(stageEl, win, !!position)
  stageEl.appendChild(win.root)
  openWindows.set(instanceId, win)
  resetInstanceRuntimeState(instanceId, "Loading window created")
  ensureStageObserver(stageEl)
  clampToStage(win.root, stageEl)
  return win
}

// Lay every visible (non-minimized) window out as a non-overlapping
// partition that fills the inner area. Each call shuffles + repartitions,
// so clicking the tile button repeatedly produces fresh layouts.
//
// We work over a fixed 4×3 grid (12 cells). With N windows we recursively
// split that grid at integer cell lines, so each window gets a rectangular
// region of 1+ whole cells — some 1×1, some 2×1, some 2×2, etc. All cells
// are covered (no empty space). For N > 12 we grow the grid in rows so the
// column width stays consistent.
const TILE_GAP = 8
const TILE_BASE_COLS = 4
const TILE_BASE_ROWS = 3

// Snapshot every visible window's current cell. Used at drag start so the
// live-pack can default to the pre-drag layout: as long as the dragged
// window isn't blocking a window's original cell, that window returns to
// where it started. This lets the user "undo" mid-drag by moving back.
export function capturePackSnapshot(stageEl: HTMLElement) {
  if (!stageEl) return new Map()
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return new Map()
  const COLS = TILE_BASE_COLS
  const cellW = innerW / COLS
  const cellH = innerH / TILE_BASE_ROWS
  const map = new Map()
  for (const w of openWindows.values()) {
    if (!w.root || !w.root.isConnected) continue
    if (w.root.classList.contains("space-inactive")) continue
    if (w.root.classList.contains("minimized")) continue
    if (w.root.classList.contains("maximized")) continue
    const px = parseFloat(w.root.style.left) || padL
    const py = parseFloat(w.root.style.top) || padT
    const pw = w.root.offsetWidth || cellW
    const ph = w.root.offsetHeight || cellH
    const col = Math.max(0, Math.min(COLS - 1, Math.round((px - padL) / cellW)))
    const row = Math.max(0, Math.round((py - padT) / cellH))
    const cols = Math.max(1, Math.min(COLS - col, Math.round(pw / cellW)))
    const rows = Math.max(1, Math.round(ph / cellH))
    map.set(w.root, { col, row, cols, rows })
  }
  return map
}

// Snap an arbitrary pixel rect to the nearest 4×3 cell rect. Returns the
// snap target in BOTH grid units (col/row/cols/rows) and pixel coords
// (left/top/width/height). The drag handler uses the pixels to position
// the placeholder, and the cell coords to drive live-pack reflow.
export function packCellSnap(
  stageEl: HTMLElement,
  leftPx: number,
  topPx: number,
  widthPx: number,
  heightPx: number
) {
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return null
  const COLS = TILE_BASE_COLS
  const cellW = innerW / COLS
  const cellH = innerH / TILE_BASE_ROWS
  const cols = Math.max(1, Math.min(COLS, Math.round(widthPx / cellW)))
  const rows = Math.max(1, Math.round(heightPx / cellH))
  const col = Math.max(0, Math.min(COLS - cols, Math.round((leftPx - padL) / cellW)))
  const row = Math.max(0, Math.round((topPx - padT) / cellH))
  const x0 = Math.round(padL + col * cellW)
  const y0 = Math.round(padT + row * cellH)
  const x1 = Math.round(padL + (col + cols) * cellW)
  const y1 = Math.round(padT + (row + rows) * cellH)
  const half = TILE_GAP / 2
  return {
    col,
    row,
    cols,
    rows,
    left: x0 + half,
    top: y0 + half,
    width: Math.max(0, x1 - x0 - TILE_GAP),
    height: Math.max(0, y1 - y0 - TILE_GAP)
  }
}

// Module-level timer for clearing the .packing class. Reset on every pack
// so a long drag (many live-pack calls) keeps the transition class on.
let packingClearTimer: ReturnType<typeof setTimeout> | null = null

// Bin-pack windows into a 4-column grid. Used by the optional pack-mode
// toggle.
//
// Without args: regular pack — sort all windows by weight, place each in
// its desired cell (with first-fit fallback if occupied).
//
// With (focusRoot, focusCell): "live-drag" pack — focusRoot is currently
// being dragged; we don't touch its style (the drag controls it via
// transform). Its cell is stamped as occupied so other windows pack
// around it. Neighbors transition smoothly to make room.
//
// With (focusRoot) and no cell: drop-time pack — the dragged window has
// just committed its drop position to style.left/top. It's processed via
// the regular weight-ordered loop with its lastMovedAt freshly bumped,
// so it wins.
//
// With (..., snapshot): each item prefers its snapshot cell over its
// current style-derived cell. Used during a drag so other windows
// default back to their pre-drag positions whenever the dragged window
// isn't blocking them — the user can revert by moving back.
//
//   - Pinned windows are stamps (immovable obstacles).
//   - Maximized windows are skipped entirely.
//   - Minimized windows are skipped.
//   - Grid grows downward as needed; stage scrolls.
export function bestFitPack(
  stageEl: HTMLElement,
  focusRoot: HTMLElement | null = null,
  focusCell: PackCell | null = null,
  snapshot: Map<HTMLElement, PackCell> | null = null
) {
  if (!stageEl) return
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return

  const COLS = TILE_BASE_COLS
  const cellW = innerW / COLS
  const cellH = innerH / TILE_BASE_ROWS

  const all = Array.from(openWindows.values()).filter(w => {
    if (!w.root || !w.root.isConnected) return false
    if (w.root.classList.contains("space-inactive")) return false
    if (w.root.classList.contains("minimized")) return false
    if (w.root.classList.contains("maximized")) return false
    if (getComputedStyle(w.root).position === "static") return false
    return true
  })
  if (all.length === 0) return

  const focused = focusRoot ? all.find(w => w.root === focusRoot) || null : null

  const stamps = all.filter(w => w.root.classList.contains("pinned"))
  // Items = all non-pinned, non-focused windows. Focused is positioned
  // separately (or not at all, when the drag's transform owns its style).
  let items = all.filter(w => !w.root.classList.contains("pinned"))
  if (focused) items = items.filter(w => w !== focused)

  // Sort items by a three-tier weight (each tier broken to the next on
  // tie):
  //   1. "Just moved" tier — windows whose lastMovedAt is within
  //      JUST_MOVED_MS of NOW. At drop time this is the just-released
  //      window; placing it first means it claims its drop-position
  //      cell, so the user sees their drop "stick" even when bigger
  //      older windows would otherwise outweigh it on size.
  //   2. Area descending — bigger windows have less placement flexibility
  //      (more ways to be blocked) so they go first. A small recent
  //      window grabbing a cell can otherwise force a big older one to
  //      a new row, growing the stage unnecessarily.
  //   3. lastMovedAt descending — older > newer so a recently-moved
  //      window of equal area still gets placed earlier. Stability for
  //      "I just touched this, leave it" scenarios.
  const NOW = Date.now()
  const JUST_MOVED_MS = 100
  const justMoved = (w: NappWindow) => {
    const t = parseInt(w.root.dataset.lastMovedAt!, 10) || 0
    return NOW - t < JUST_MOVED_MS
  }
  items.sort((a, b) => {
    // Freshly-launched (pack-new) windows pack LAST so existing windows claim
    // their cells first and the new one first-fits into the leftover space.
    const na = a.root.dataset.packNew === "1"
    const nb = b.root.dataset.packNew === "1"
    if (na !== nb) return na ? 1 : -1
    const ja = justMoved(a)
    const jb = justMoved(b)
    if (ja !== jb) return ja ? -1 : 1
    const aa = a.root.offsetWidth * a.root.offsetHeight
    const ab = b.root.offsetWidth * b.root.offsetHeight
    if (aa !== ab) return ab - aa
    const ma = parseInt(a.root.dataset.lastMovedAt!, 10) || 0
    const mb = parseInt(b.root.dataset.lastMovedAt!, 10) || 0
    return mb - ma
  })

  // Lazy occupancy grid (rows × COLS), grows as needed.
  const grid: boolean[][] = []
  const ensureRows = (n: number) => {
    while (grid.length < n) grid.push(new Array(COLS).fill(false))
  }
  const fits = (col: number, row: number, w: number, h: number) => {
    if (col < 0 || col + w > COLS) return false
    ensureRows(row + h)
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (grid[r][c]) return false
      }
    }
    return true
  }
  const mark = (col: number, row: number, w: number, h: number) => {
    ensureRows(row + h)
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        grid[r][c] = true
      }
    }
  }
  const overlaps = (a: PackCell, b: PackCell) =>
    a.col < b.col + b.cols &&
    a.col + a.cols > b.col &&
    a.row < b.row + b.rows &&
    a.row + a.rows > b.row

  const cellFromPx = (w: NappWindow) => {
    const px = parseFloat(w.root.style.left) || padL
    const py = parseFloat(w.root.style.top) || padT
    const pw = w.root.offsetWidth || cellW
    const ph = w.root.offsetHeight || cellH
    const col = Math.max(0, Math.min(COLS - 1, Math.round((px - padL) / cellW)))
    const row = Math.max(0, Math.round((py - padT) / cellH))
    const cols = Math.max(1, Math.min(COLS - col, Math.round(pw / cellW)))
    const rows = Math.max(1, Math.round(ph / cellH))
    return { col, row, cols, rows }
  }

  // Add the transition class to items so neighbors slide smoothly. The
  // focused window is excluded — during a live drag it's controlled by
  // transform, and we don't want its left/top change on drop to animate
  // (the user expects it to land where they released, not slide there).
  for (const w of items) w.root.classList.add("packing")
  // Force a style flush so the freshly-added transition rule applies
  // before we mutate the transitioned properties below. Without this,
  // a same-tick add+mutate can skip the transition entirely.
  if (items.length) void items[0].root.offsetHeight

  // Lay down stamps first so items have to flow around them.
  for (const s of stamps) {
    const { col, row, cols, rows } = cellFromPx(s)
    mark(col, row, cols, rows)
    applyCellRect(s, col, row, cols, rows, padL, padT, cellW, cellH)
  }

  // The focused window claims its cell BEFORE other items pack — this is
  // what makes "drag wins collisions" work. focusCell is provided by the
  // live-drag path (cell from packCellSnap of the cursor's hypothetical
  // position); without it, we read the focused window's current
  // style.left/top (the just-committed drop position).
  if (focused) {
    const fCell = focusCell ?? cellFromPx(focused)
    const c = Math.max(0, Math.min(COLS - fCell.cols, fCell.col))
    const r = Math.max(0, fCell.row)
    mark(c, r, fCell.cols, fCell.rows)
    // If we're at drop time (no focusCell hint), commit the focused
    // window's cell-aligned position too. Skip while live-dragging — the
    // transform owns its position then.
    if (!focusCell) {
      applyCellRect(focused, c, r, fCell.cols, fCell.rows, padL, padT, cellW, cellH)
    }
  }

  // Identify the highest-weight non-focused window. We *don't* shrink it
  // around the focus stamp — it's the user's most-recently-touched
  // window before this drag, treated as a stamp itself.
  let mostRecentItem = null
  let mostRecentTime = -1
  for (const item of items) {
    const t = parseInt(item.root.dataset.lastMovedAt!, 10) || 0
    if (t > mostRecentTime) {
      mostRecentTime = t
      mostRecentItem = item
    }
  }

  for (const item of items) {
    // Fresh-in-pack windows are 1 column × 2 rows and always append: they skip
    // the "keep current/snapshot cell" preference and go straight to first-fit,
    // landing in the first free slot after the existing windows.
    const isNew = item.root.dataset.packNew === "1"
    // Prefer the snapshot cell (where this window was at drag start) so
    // an item only relocates when the dragged window is actually blocking
    // its original spot. Without snapshot we fall back to its current
    // style-derived cell — that's the regular non-drag pack path.
    const original = snapshot?.get(item.root)
    const desired = isNew ? { col: 0, row: 0, cols: 1, rows: 2 } : (original ?? cellFromPx(item))
    let placed = null
    if (!isNew) {
      // 1. Try the exact desired cell.
      if (fits(desired.col, desired.row, desired.cols, desired.rows)) {
        placed = {
          col: desired.col,
          row: desired.row,
          cols: desired.cols,
          rows: desired.rows
        }
      }
      // 1b. The window the focus DIRECTLY displaced (its snapshot cell is where
      //     the dragged window is going) swaps into the dragged window's vacated
      //     origin — instead of falling through to the global first-fit scan
      //     below, which can grab a third window's still-unplaced cell and
      //     cascade (a 3-cycle of windows rather than a clean A<->B swap). Only
      //     during a live drag (focusCell + snapshot both set).
      if (!placed && focusCell && focused && snapshot && overlaps(desired, focusCell)) {
        const origin = snapshot.get(focused.root)
        if (origin && fits(origin.col, origin.row, desired.cols, desired.rows)) {
          placed = { col: origin.col, row: origin.row, cols: desired.cols, rows: desired.rows }
        }
      }
      // 2. Blocked → if this item is "much bigger" than the dragged stamp,
      //    try shrinking it around the stamp instead of relocating. Skip
      //    the most-recently-touched non-focused window — that one holds
      //    its size.
      if (
        !placed &&
        focusCell &&
        item !== mostRecentItem &&
        desired.cols * desired.rows >= 2 * (focusCell.cols * focusCell.rows)
      ) {
        placed = shrinkAroundFocus(desired, focusCell, fits)
      }
    }
    // 3. Last resort. New windows append via top-left first-fit (earliest gap).
    //    A displaced EXISTING window instead takes the free cell NEAREST its
    //    desired spot, so it shifts locally into a nearby gap (e.g. its own
    //    just-vacated cell) rather than teleporting to the top-left — which can
    //    grab a not-yet-placed window's cell and cascade a third window.
    if (!placed && isNew) {
      for (let r = 0; r < 1000 && !placed; r++) {
        for (let c = 0; c <= COLS - desired.cols; c++) {
          if (fits(c, r, desired.cols, desired.rows)) {
            placed = { col: c, row: r, cols: desired.cols, rows: desired.rows }
            break
          }
        }
      }
    } else if (!placed) {
      const maxRow = grid.length + desired.rows
      let bestDist = Infinity
      for (let r = 0; r <= maxRow; r++) {
        for (let c = 0; c <= COLS - desired.cols; c++) {
          if (!fits(c, r, desired.cols, desired.rows)) continue
          const colDist = Math.abs(c - desired.col)
          const rowDist = Math.abs(r - desired.row)
          // Nearest by Manhattan; tie → same/nearer column, then top, then left.
          const dist = (colDist + rowDist) * 1000 + colDist
          if (dist < bestDist) {
            bestDist = dist
            placed = { col: c, row: r, cols: desired.cols, rows: desired.rows }
          }
        }
      }
    }
    if (!placed) continue
    mark(placed.col, placed.row, placed.cols, placed.rows)
    applyCellRect(item, placed.col, placed.row, placed.cols, placed.rows, padL, padT, cellW, cellH)
    if (isNew) delete item.root.dataset.packNew // flag consumed
  }

  // Reset the clear timer on each pack so an ongoing drag (multiple
  // live-pack calls) keeps .packing on for as long as the drag lasts.
  if (packingClearTimer) clearTimeout(packingClearTimer)
  packingClearTimer = setTimeout(() => {
    document.querySelectorAll(".napp-window.packing").forEach(el => el.classList.remove("packing"))
    packingClearTimer = null
  }, 260)

  // Bottom of the lowest occupied row, from the target grid (not measured —
  // offsetTop lags the .packing transition that just started above).
  let lastRow = 0
  for (let r = grid.length - 1; r >= 0; r--) {
    if (grid[r]?.some(Boolean)) {
      lastRow = r + 1
      break
    }
  }
  setStageBottomSpacer(stageEl, lastRow ? padT + lastRow * cellH - TILE_GAP / 2 : 0)
}

// Try to fit `desired` around `focus` by trimming one of the four sides
// (top/bottom/left/right). Returns the largest valid sub-rectangle that:
//   1. is contained within `desired`,
//   2. doesn't overlap `focus`,
//   3. passes `fits` (no other obstructions in the partially-built grid).
// Used to let a "big" window shrink around the dragged window's stamp
// instead of relocating entirely. Returns null if no candidate works.
function shrinkAroundFocus(
  desired: PackCell,
  focus: PackCell,
  fits: (col: number, row: number, cols: number, rows: number) => boolean
) {
  const ic1 = desired.col
  const ir1 = desired.row
  const ic2 = ic1 + desired.cols
  const ir2 = ir1 + desired.rows
  const fc1 = focus.col
  const fr1 = focus.row
  const fc2 = fc1 + focus.cols
  const fr2 = fr1 + focus.rows

  // Focus must actually overlap desired; if it doesn't we shouldn't be
  // here (the desired cell would have fit).
  if (fc2 <= ic1 || fc1 >= ic2 || fr2 <= ir1 || fr1 >= ir2) return null

  const candidates = []
  // Sub-rect above focus.
  if (fr1 > ir1) {
    candidates.push({
      col: ic1,
      row: ir1,
      cols: desired.cols,
      rows: fr1 - ir1
    })
  }
  // Sub-rect below focus.
  if (fr2 < ir2) {
    candidates.push({
      col: ic1,
      row: fr2,
      cols: desired.cols,
      rows: ir2 - fr2
    })
  }
  // Sub-rect left of focus.
  if (fc1 > ic1) {
    candidates.push({
      col: ic1,
      row: ir1,
      cols: fc1 - ic1,
      rows: desired.rows
    })
  }
  // Sub-rect right of focus.
  if (fc2 < ic2) {
    candidates.push({
      col: fc2,
      row: ir1,
      cols: ic2 - fc2,
      rows: desired.rows
    })
  }

  // Filter to ones that actually fit, then pick the one with most cells.
  const valid = candidates.filter(
    c => c.cols > 0 && c.rows > 0 && fits(c.col, c.row, c.cols, c.rows)
  )
  if (valid.length === 0) return null
  valid.sort((a, b) => b.cols * b.rows - a.cols * a.rows)
  return valid[0]
}

function applyCellRect(
  w: NappWindow,
  col: number,
  row: number,
  cols: number,
  rows: number,
  padL: number,
  padT: number,
  cellW: number,
  cellH: number
) {
  const x0 = Math.round(padL + col * cellW)
  const y0 = Math.round(padT + row * cellH)
  const x1 = Math.round(padL + (col + cols) * cellW)
  const y1 = Math.round(padT + (row + rows) * cellH)
  const half = TILE_GAP / 2
  const newLeft = `${x0 + half}px`
  const newTop = `${y0 + half}px`
  const newW = `${Math.max(0, x1 - x0 - TILE_GAP)}px`
  const newH = `${Math.max(0, y1 - y0 - TILE_GAP)}px`
  const changed =
    w.root.style.left !== newLeft ||
    w.root.style.top !== newTop ||
    w.root.style.width !== newW ||
    w.root.style.height !== newH
  w.root.style.left = newLeft
  w.root.style.top = newTop
  w.root.style.width = newW
  w.root.style.height = newH
  w.root.style.minWidth = "0"
  w.root.style.minHeight = "0"
  w.root.classList.add("user-sized")
  if (changed) w.notifyState?.()
}

export function tileWindows(stageEl: HTMLElement) {
  if (!stageEl) return
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return

  const wins = Array.from(openWindows.values()).filter(w => {
    if (!w.root || !w.root.isConnected) return false
    if (w.root.classList.contains("space-inactive")) return false
    if (w.root.classList.contains("minimized")) return false
    // Mobile static layout doesn't honor left/top — tiling makes no sense.
    if (getComputedStyle(w.root).position === "static") return false
    return true
  })
  if (wins.length === 0) return

  const shuffled = shuffle(wins.slice())
  const n = shuffled.length

  // Pick grid dimensions: 4×3 base, growing rows so we always have enough
  // cells (one per window minimum). Columns stay at 4 so cell width is
  // predictable.
  const cols = TILE_BASE_COLS
  const rows = Math.max(TILE_BASE_ROWS, Math.ceil(n / cols))
  const gridRects = partitionGrid({ col: 0, row: 0, cols, rows }, Math.min(n, cols * rows))

  const cellW = innerW / cols
  const cellH = innerH / rows

  for (let i = 0; i < shuffled.length && i < gridRects.length; i++) {
    const w = shuffled[i]
    const g = gridRects[i]
    // Convert grid units to pixels (rounded so adjacent cells share an
    // integer boundary — no sub-pixel overlap or gap from rounding).
    const x0 = Math.round(padL + g.col * cellW)
    const y0 = Math.round(padT + g.row * cellH)
    const x1 = Math.round(padL + (g.col + g.cols) * cellW)
    const y1 = Math.round(padT + (g.row + g.rows) * cellH)
    const half = TILE_GAP / 2
    const left = x0 + half
    const top = y0 + half
    const width = Math.max(0, x1 - x0 - TILE_GAP)
    const height = Math.max(0, y1 - y0 - TILE_GAP)
    // Drop maximized state — it'd override our left/top with !important.
    w.root.classList.remove("maximized")
    w.root.style.left = `${left}px`
    w.root.style.top = `${top}px`
    w.root.style.width = `${width}px`
    w.root.style.height = `${height}px`
    // The 240px CSS min-width would force narrow cells to render oversized
    // and overlap their neighbors. Override it so the partition is honored.
    // (User can still drag the window wider afterward.)
    w.root.style.minWidth = "0"
    w.root.style.minHeight = "0"
    // First-tile marks the window as user-sized so the 420px cap doesn't
    // claw the height back next render.
    w.root.classList.add("user-sized")
    w.notifyState?.()
  }
}

function shuffle(arr: NappWindow[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Recursively partition a grid `rect` (in integer cell units) into `n`
// non-overlapping sub-rectangles, also in cell units. Splits land on
// integer cell lines so every output rectangle is whole-cell aligned.
//
// Constraints to avoid losing windows:
//   - Only split if the chosen side has ≥ 2 cells.
//   - Each side must end up with at least as many cells as it has windows
//     (otherwise a deeper recursion would hit "no split possible" with
//      n > 1 and silently drop windows).
function partitionGrid(rect: GridRect, n: number): GridRect[] {
  if (n <= 1) return [rect]
  const cells = rect.cols * rect.rows
  // Caller guarantees `cells >= n`; if somehow not, we can't split safely.
  if (cells <= 1 || n > cells) return [rect]

  // Pick a direction we can actually split + satisfy the cell-count
  // constraint. Try the preferred direction first, fall back to the other.
  const canV = canSplitDirection(rect, n, true)
  const canH = canSplitDirection(rect, n, false)
  if (!canV && !canH) return [rect]

  let vertical
  if (canV && canH) {
    const wide = rect.cols > rect.rows * 1.2
    const tall = rect.rows > rect.cols * 1.2
    vertical = wide ? true : tall ? false : Math.random() < 0.5
  } else {
    vertical = canV
  }

  const sideCells = vertical ? rect.cols : rect.rows
  const otherCells = vertical ? rect.rows : rect.cols

  // Pick how many windows go on each side, then a cut that fits both.
  // leftN must be in [1, n-1]. Then the valid cut range is
  //   [ceil(leftN / otherCells), sideCells - ceil(rightN / otherCells)].
  // We retry leftN a few times if it produces no valid cut range.
  let leftN = 1 + Math.floor(Math.random() * (n - 1))
  let rightN = n - leftN
  let minCut = Math.ceil(leftN / otherCells)
  let maxCut = sideCells - Math.ceil(rightN / otherCells)
  if (minCut > maxCut) {
    // Random pick produced no fit. Collect every leftN that does fit and
    // pick one of those at random — keeps the layout diverse instead of
    // always biasing to the smallest valid leftN.
    const valid = []
    for (let i = 1; i < n; i++) {
      const lo = Math.ceil(i / otherCells)
      const hi = sideCells - Math.ceil((n - i) / otherCells)
      if (lo <= hi) valid.push(i)
    }
    if (valid.length === 0) return [rect] // shouldn't happen
    leftN = valid[Math.floor(Math.random() * valid.length)]
    rightN = n - leftN
    minCut = Math.ceil(leftN / otherCells)
    maxCut = sideCells - Math.ceil(rightN / otherCells)
  }

  // Bias cut toward the proportional position with ±1 cell jitter.
  const proportional = Math.round((leftN / n) * sideCells)
  const jitter = Math.random() < 0.33 ? -1 : Math.random() < 0.5 ? 1 : 0
  const cut = Math.max(minCut, Math.min(maxCut, proportional + jitter))

  if (vertical) {
    const a = { col: rect.col, row: rect.row, cols: cut, rows: rect.rows }
    const b = {
      col: rect.col + cut,
      row: rect.row,
      cols: rect.cols - cut,
      rows: rect.rows
    }
    return [...partitionGrid(a, leftN), ...partitionGrid(b, rightN)]
  }
  const a = { col: rect.col, row: rect.row, cols: rect.cols, rows: cut }
  const b = {
    col: rect.col,
    row: rect.row + cut,
    cols: rect.cols,
    rows: rect.rows - cut
  }
  return [...partitionGrid(a, leftN), ...partitionGrid(b, rightN)]
}

// Can we split this rect along the given axis such that both sides hold at
// least 1 window, with enough cells for SOME valid (leftN, rightN) pair?
//
// The minimum value of `ceil(leftN/O) + ceil(rightN/O)` over leftN ∈ [1, n-1]
// is ceil(n/O) (attained when one side is a multiple of O). So as long as
// ceil(n / otherCells) ≤ sideCells, a balanced leftN exists that fits.
function canSplitDirection(rect: GridRect, n: number, vertical: boolean) {
  const sideCells = vertical ? rect.cols : rect.rows
  if (sideCells < 2) return false
  const otherCells = vertical ? rect.rows : rect.cols
  return Math.ceil(n / otherCells) <= sideCells
}

// Read the stage's effective inner bounds. With `position: absolute` children,
// left/top are measured from the padding edge, so the usable region is
// 0 → (clientW - padLeft - padRight). We return both the bounds and the
// padding so callers (clamp + tile) can use them consistently.
export function getStageBounds(stage: HTMLElement) {
  const cs = getComputedStyle(stage)
  const padL = parseFloat(cs.paddingLeft) || 0
  const padR = parseFloat(cs.paddingRight) || 0
  const padT = parseFloat(cs.paddingTop) || 0
  const padB = parseFloat(cs.paddingBottom) || 0
  return {
    width: Math.max(0, stage.clientWidth - padL - padR),
    height: Math.max(0, stage.clientHeight - padT - padB),
    padL,
    padR,
    padT,
    padB
  }
}

// Browsers don't include a scroll container's padding-bottom in the scrollable
// area for absolutely-positioned children, so a window scrolled to the bottom
// sits flush against the edge. Keep a tiny spacer a gutter below the lowest
// window so the bottom gets the same breathing room as the sides.
function setStageBottomSpacer(stage: HTMLElement, maxBottom: number) {
  if (!stage) return
  let spacer = stage.querySelector(":scope > .stage-bottom-spacer") as HTMLElement | null
  if (maxBottom <= 0) {
    spacer?.remove()
    return
  }
  if (!spacer) {
    spacer = document.createElement("div")
    spacer.className = "stage-bottom-spacer"
    stage.appendChild(spacer)
  }
  spacer.style.top = `${Math.round(maxBottom + getStageBounds(stage).padB)}px`
}

// Lowest window bottom from laid-out positions — valid only when windows are
// SETTLED. bestFitPack instead derives it from its target grid, since offsetTop
// lags behind the in-flight `.packing` transition right after a repack (which is
// why the spacer used to wait for a focus/re-pack to catch up).
function measureMaxWindowBottom(stage: HTMLElement): number {
  let maxBottom = 0
  for (const win of openWindows.values()) {
    const r = win.root
    if (!r.isConnected || r.classList.contains("space-inactive")) continue
    if (getComputedStyle(r).position === "static") continue // mobile flow layout
    maxBottom = Math.max(maxBottom, r.offsetTop + r.offsetHeight)
  }
  return maxBottom
}

// Make sure the window's header is reachable inside the stage's visible
// area, AND that the window respects the stage's padding gutter.
//
// `position: absolute` children of a padded ancestor ignore the padding —
// `left: 0` is at the padding box's outer edge, which is the same as the
// stage's outer edge here. So the visual 1rem gutter only exists if we
// actively clamp the window's left/top to ≥ padding.
function clampToStage(root: HTMLElement, stage: HTMLElement) {
  if (!stage) return
  // Mobile static layout: nothing to clamp (the layout handles position).
  if (getComputedStyle(root).position === "static") return
  const { padL, padR, padT, padB } = getStageBounds(stage)
  const W = stage.clientWidth
  const H = stage.clientHeight
  if (W <= 0 || H <= 0) return
  const left = parseFloat(root.style.left) || 0
  const top = parseFloat(root.style.top) || 0
  const width = root.offsetWidth || parseFloat(root.style.width) || 240
  // Always leave at least this much of the window inside the stage so the
  // user can grab the header. Header height ≈ 28px on desktop, 40px on mobile.
  const minVisibleX = Math.min(80, width)
  const minLeft = padL
  const minTop = padT
  const maxLeft = Math.max(minLeft, W - padR - minVisibleX)
  const newLeft = Math.max(minLeft, Math.min(maxLeft, left))
  // The stage scrolls vertically (overflow-y: auto), so a window below the fold
  // is still reachable by scrolling — clamping its top into the viewport would
  // yank packed below-the-fold windows up onto the one above. Only clamp the top
  // DOWN-ward when the stage can't scroll vertically. (Horizontal always clamps:
  // overflow-x is hidden.)
  const scrollsY = /(auto|scroll)/.test(getComputedStyle(stage).overflowY)
  const maxTop = Math.max(minTop, H - padB - 28)
  const newTop = scrollsY ? Math.max(minTop, top) : Math.max(minTop, Math.min(maxTop, top))
  if (newLeft !== left) root.style.left = `${newLeft}px`
  if (newTop !== top) root.style.top = `${newTop}px`
}

let stageObserver: ResizeObserver | null = null
function ensureStageObserver(stageEl: HTMLElement) {
  if (stageObserver) return
  stageObserver = new ResizeObserver(() => {
    for (const win of openWindows.values()) {
      // Skip hidden (other-space) windows: they report zero size, so clamping
      // would mis-reposition them before they're shown again.
      if (win.root.classList.contains("space-inactive")) continue
      clampToStage(win.root, stageEl)
    }
    // Windows are settled here (a resize isn't a repack), so measuring is fine.
    setStageBottomSpacer(stageEl, measureMaxWindowBottom(stageEl))
  })
  stageObserver.observe(stageEl)
}

export async function wipe(nappId: string): Promise<void> {
  const origin = nappOriginFor(nappId)
  const boot = document.createElement("iframe")
  boot.src = `${origin}/boot.html`
  boot.style.display = "none"
  document.body.appendChild(boot)

  try {
    const ready = await waitForMessage(origin, "napp-boot-ready", "napp-boot-error")
    if (ready.__nostrapps === "napp-boot-error") {
      throw new Error(`Napp boot failed: ${ready.error}`)
    }
    boot.contentWindow!.postMessage({ __nostrapps: "napp-wipe" }, origin)
    const result = await waitForMessage(origin, "napp-wipe-done", "napp-wipe-error")
    if (result.__nostrapps === "napp-wipe-error") {
      throw new Error(result.error)
    }
  } finally {
    boot.remove()
  }
}

export async function bootNapp(
  origin: string,
  files: NsiteFile[],
  onProgress: (msg: string) => void,
  label: string
) {
  console.debug("[sandbox] bootNapp", { origin, fileCount: files.length, label })
  const boot = document.createElement("iframe")
  boot.src = `${origin}/boot.html`
  boot.style.display = "none"
  document.body.appendChild(boot)

  try {
    const ready = await waitForMessage(origin, "napp-boot-ready", "napp-boot-error")
    if (ready.__nostrapps === "napp-boot-error") {
      throw new Error(`Napp boot failed: ${ready.error}`)
    }

    onProgress(`Installing ${files.length} file(s) for ${label}…`)
    boot.contentWindow!.postMessage({ __nostrapps: "napp-install", files }, origin)

    const result = await waitForMessage(origin, "napp-install-done", "napp-install-error")
    if (result.__nostrapps === "napp-install-error") {
      throw new Error(result.error)
    }
  } finally {
    boot.remove()
  }
}

// ─── Dev apps ───────────────────────────────────────────

const devHandles = new Map<string, FileSystemDirectoryHandle>()
const tempFiles = new Map<string, Map<string, NsiteFile>>()
const devBootIframes = new Map<string, HTMLIFrameElement>()

export function setDevHandle(nappId: string, handle: FileSystemDirectoryHandle) {
  devHandles.set(nappId, handle)
}

export function setTempFiles(nappId: string, files: NsiteFile[]) {
  tempFiles.set(
    nappId,
    new Map(files.map(file => [file.path.startsWith("/") ? file.path : `/${file.path}`, file]))
  )
}

export function removeDevHandle(nappId: string) {
  devHandles.delete(nappId)
  tempFiles.delete(nappId)
  const boot = devBootIframes.get(nappId)
  if (boot) {
    boot.remove()
    devBootIframes.delete(nappId)
  }
}

export function getDevHandle(nappId: string): FileSystemDirectoryHandle | null {
  return devHandles.get(nappId) || null
}

export async function bootDevApp(
  origin: string,
  nappId: string,
  onProgress: (msg: string) => void,
  label: string
) {
  console.debug("[sandbox] bootDevApp", { origin, label })
  const boot = document.createElement("iframe")
  boot.src = `${origin}/boot.html`
  boot.style.display = "none"
  document.body.appendChild(boot)
  devBootIframes.set(nappId, boot)

  try {
    const ready = await waitForMessage(origin, "napp-boot-ready", "napp-boot-error")
    if (ready.__nostrapps === "napp-boot-error") {
      throw new Error(`Napp boot failed: ${ready.error}`)
    }

    onProgress(`Registering dev app ${label}…`)
    boot.contentWindow!.postMessage({ __nostrapps: "napp-dev-install", nappId }, origin)

    const result = await waitForMessage(origin, "napp-dev-install-done", "napp-dev-install-error")
    if (result.__nostrapps === "napp-dev-install-error") {
      throw new Error(result.error)
    }
  } finally {
    // Keep boot iframe alive as relay between SW and host
  }
}

// Listen for file requests from dev app SW (relayed through boot iframe)
window.addEventListener("message", async event => {
  const data = event.data
  if (!data || data.__nostrapps !== "napp-dev-read-file") return

  const { nappId, path, requestId } = data
  const dirHandle = devHandles.get(nappId)
  const tempAppFiles = tempFiles.get(nappId)

  if (!dirHandle && !tempAppFiles) {
    ;(event.source as Window)?.postMessage(
      { __nostrapps: "napp-dev-file-result", requestId, error: "No files for " + nappId },
      "*"
    )
    return
  }

  try {
    const tempFile = tempAppFiles?.get(path.startsWith("/") ? path : `/${path}`)
    if (tempFile) {
      ;(event.source as Window)?.postMessage(
        {
          __nostrapps: "napp-dev-file-result",
          requestId,
          body: await tempFile.body.arrayBuffer(),
          mime: tempFile.mime || "application/octet-stream"
        },
        "*"
      )
      return
    }

    if (!dirHandle) throw new Error("File not found: " + path)

    const parts = path.replace(/^\//, "").split("/").filter(Boolean)
    if (parts.length === 0) throw new Error("Empty path")

    let handle: FileSystemDirectoryHandle | FileSystemFileHandle = dirHandle
    for (let i = 0; i < parts.length - 1; i++) {
      handle = await (handle as FileSystemDirectoryHandle).getDirectoryHandle(parts[i])
    }
    const fileHandle = await (handle as FileSystemDirectoryHandle).getFileHandle(
      parts[parts.length - 1]
    )
    const file = await fileHandle.getFile()
    const body = await file.arrayBuffer()

    ;(event.source as Window)?.postMessage(
      {
        __nostrapps: "napp-dev-file-result",
        requestId,
        body,
        mime: file.type || "application/octet-stream"
      },
      "*"
    )
  } catch (err: any) {
    ;(event.source as Window)?.postMessage(
      { __nostrapps: "napp-dev-file-result", requestId, error: err.message },
      "*"
    )
  }
})

function waitForMessage(
  expectedOrigin: string,
  successType: string,
  errorType: string
): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler)
      reject(new Error(`Timed out waiting for ${successType}`))
    }, BOOT_TIMEOUT_MS)

    const handler = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return
      const data: any = event.data
      if (!data) return
      if (data.__nostrapps === successType || (errorType && data.__nostrapps === errorType)) {
        clearTimeout(timer)
        window.removeEventListener("message", handler)
        resolve(data)
      }
    }
    window.addEventListener("message", handler)
  })
}

async function handleRpc(
  data: Extract<MessageData, { __nostrapps: "rpc" }>,
  iframe: HTMLIFrameElement,
  signer: Signer | SignerGetter,
  nappId: string
) {
  const { id, method, params, instanceId } = data
  try {
    if (isGated(method!)) {
      const allowed = await requireApproval(nappId, method!)
      if (!allowed) throw new Error(`Permission denied: ${method!}`)
    }
    // Signer can be passed either as an object (legacy) or as a getter
    // (`() => currentSigner()`). The getter form lets the user hot-swap
    // signer types (NIP-07 ↔ NIP-46) without forcing a napp reload.
    const resolvedSigner = typeof signer === "function" ? signer() : signer
    const result = await dispatch(resolvedSigner, method!, params, nappId, instanceId)
    iframe.contentWindow?.postMessage({ __nostrapps: "rpc-result", id, result }, "*")
  } catch (err: any) {
    iframe.contentWindow?.postMessage(
      { __nostrapps: "rpc-error", id, error: err?.message ?? String(err) },
      "*"
    )
  }
}

async function startOutboxFeed(
  instanceId: string,
  callbackId: string,
  authors: string[],
  kinds: number[],
  until: number | undefined,
  filter: Filter
) {
  const controller = new AbortController()

  const win = openWindows.get(instanceId)?.iframe?.contentWindow
  let synced = authors.map(() => false)
  const notify = debounce(async () => {
    if (!controller.signal.aborted)
      win?.postMessage(
        {
          __nostrapps: "napp-feed-callback",
          callbackId,
          events: await store.queryEvents(filter),
          synced: synced.every(v => v)
        },
        "*"
      )
  }, 800)
  notify()

  const onSync = (pubkey: string) => {
    const idx = authors.indexOf(pubkey)
    if (idx !== -1) {
      synced[idx] = true
      notify()
    }
  }
  const onBefore = (pubkey: string) => {
    if (authors.includes(pubkey)) notify()
  }
  const onNew = (event: NostrEvent) => {
    if (matchFilter(filter, event)) notify()
  }
  const cleanup = () => {
    outboxCurrent.onsync = outboxCurrent.onsync.filter(listener => listener !== onSync)
    outboxCurrent.onbefore = outboxCurrent.onbefore.filter(listener => listener !== onBefore)
    outboxCurrent.onnew = outboxCurrent.onnew.filter(listener => listener !== onNew)
  }

  outboxCurrent.onsync.push(onSync)
  outboxCurrent.onbefore.push(onBefore)
  outboxCurrent.onnew.push(onNew)

  trackFeedRequest(instanceId, callbackId, { controller, cleanup })
  ;(async () => {
    try {
      await outbox.sync(authors, kinds, { signal: controller.signal })
      if (until && until < Math.round(Date.now() / 1000) - 5)
        await outbox.before(authors, kinds, until, { signal: controller.signal })
    } catch (err) {
      if (!controller.signal.aborted) console.warn("failed to update feed", err)
    }
  })()
}

async function startInboxFeed(
  instanceId: string,
  callbackId: string,
  pubkey: string,
  filter: Filter
) {
  const controller = new AbortController()
  trackFeedRequest(instanceId, callbackId, { controller })

  const win = openWindows.get(instanceId)?.iframe?.contentWindow

  let synced = false
  const notify = debounce(async () => {
    if (!controller.signal.aborted)
      win?.postMessage(
        {
          __nostrapps: "napp-feed-callback",
          callbackId,
          events: await store.queryEvents(filter),
          synced
        },
        "*"
      )
  }, 800)
  notify()

  try {
    const relayList = await loadRelayList(pubkey)
    const relays = relayList.items.filter(relay => relay.read).map(relay => relay.url)
    if (controller.signal.aborted || relays.length === 0) {
      finishFeedRequest(instanceId, callbackId)
      return
    }
    const closer = pool.subscribeMany(relays, filter, {
      label: `inbox-${pubkey.substring(0, 6)}`,
      abort: controller.signal,
      async onevent(event) {
        const isNew = await store.saveEvent(event)
        if (isNew) notify()
      },
      oneose() {
        synced = true
      }
    })
    const requests = feedRequests.get(instanceId)
    const request = requests?.get(callbackId)
    if (request) request.closer = closer
  } catch (err) {
    if (!controller.signal.aborted) console.warn("failed to update inbox feed", err)
    finishFeedRequest(instanceId, callbackId)
  }
}

async function dispatch(
  signer: Signer,
  method: string,
  params: any,
  callerNappId: string,
  instanceId?: string
) {
  switch (method) {
    case "getPublicKey":
      return signer.getPublicKey()
    case "signEvent":
      return signer.signEvent(params)
    case "nip04.encrypt":
      return signer.nip04.encrypt(params.pubkey, params.plaintext)
    case "nip04.decrypt":
      return signer.nip04.decrypt(params.pubkey, params.ciphertext)
    case "nip44.encrypt":
      return signer.nip44.encrypt(params.pubkey, params.plaintext)
    case "nip44.decrypt":
      return signer.nip44.decrypt(params.pubkey, params.ciphertext)
    case "nostrdb.add":
      return store.saveEvent(params.event)
    case "nostrdb.query":
      return store.queryEvents(params.filters)
    case "nostrdb.count":
      const events = await store.queryEvents(params.filters, 10_000)
      return events.length
    case "nostrdb.event":
      const res = await store.queryEvents({ ids: [params.id] }, 1)
      return res[0]
    case "nostrdb.replaceable":
      const result = await getStore().loadReplaceables([
        [params.kind, params.author, params.identifier]
      ])
      return result[0]
    case "napp.action": {
      // The bridge forwards the in-iframe pointer; convert it to screen coords via
      // this napp's iframe rect so cursor-anchored UI (the handler popover) opens
      // under the cursor instead of wherever the launcher cursor last was.
      const pt = params?.pointer
      const iframe = instanceId ? openWindows.get(instanceId)?.iframe : null
      if (pt && iframe) {
        const r = iframe.getBoundingClientRect()
        setPointer(r.left + pt.x, r.top + pt.y)
      }
      return dispatchAction(callerNappId, params?.name ?? "", params?.payload, params?.options)
    }
    case "napp.feeds.profile": {
      const filter: Filter = {
        authors: [params.pubkey],
        kinds: params.kinds,
        limit: params.limit || 100
      }
      if (params.since) filter.since = params.since
      if (params.until) filter.until = params.until
      startOutboxFeed(
        instanceId!,
        params.callbackId,
        [params.pubkey],
        params.kinds,
        params.until,
        filter
      )
      return
    }
    case "napp.feeds.following": {
      const authors = await loadFollowsList(params.source)
      const filter: Filter = {
        authors: authors.items,
        kinds: params.kinds,
        limit: params.limit || 100
      }
      if (params.since) filter.since = params.since
      if (params.until) filter.until = params.until
      startOutboxFeed(
        instanceId!,
        params.callbackId,
        authors.items,
        params.kinds,
        params.until,
        filter
      )
      return
    }
    case "napp.feeds.inbox": {
      const filter: Filter = {
        "#p": [params.pubkey],
        kinds: params.kinds,
        limit: params.limit || 100
      }
      if (params.since) filter.since = params.since
      if (params.until) filter.until = params.until
      startInboxFeed(instanceId!, params.callbackId, params.pubkey, filter)
      return
    }
    case "napp.feeds.cancel":
      return cancelFeedRequest(instanceId, params?.callbackId)
    case "napp.loadBlossomServers":
      return loadBlossomServers(
        params.pubkey,
        params.hints,
        params.refreshStyle,
        params.defaultItems
      )
    case "napp.loadBookmarks":
      return loadBookmarks(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadEmojis":
      return loadEmojis(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadFavoriteRelays":
      return loadFavoriteRelays(
        params.pubkey,
        params.hints,
        params.refreshStyle,
        params.defaultItems
      )
    case "napp.loadFavoriteScrolls":
      return loadFavoriteScrolls(
        params.pubkey,
        params.hints,
        params.refreshStyle,
        params.defaultItems
      )
    case "napp.loadFollowsList":
      return loadFollowsList(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadMuteList":
      return loadMuteList(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadPins":
      return loadPins(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadRelayList":
      return loadRelayList(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadWikiAuthors":
      return loadWikiAuthors(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadWikiRelays":
      return loadWikiRelays(params.pubkey, params.hints, params.refreshStyle, params.defaultItems)
    case "napp.loadEmojiSets":
      return loadEmojiSets(params.pubkey, params.hints, params.forceUpdate)
    case "napp.loadFollowPacks":
      return loadFollowPacks(params.pubkey, params.hints, params.forceUpdate)
    case "napp.loadFollowSets":
      return loadFollowSets(params.pubkey, params.hints, params.forceUpdate)
    case "napp.loadRelaySets":
      return loadRelaySets(params.pubkey, params.hints, params.forceUpdate)
    case "napp.loadRelayInfo":
      return loadRelayInfo(params.url, params.refreshStyle)
    case "napp.loadNostrUser":
      if (typeof params === "string") {
        if (isNip05(params)) {
          const resolved = await queryProfile(params)
          if (resolved) {
            return loadNostrUser({ pubkey: resolved.pubkey, relays: resolved.relays })
          }
        }
        return loadNostrUser(params)
      }
      if (params?.pubkey && isNip05(params.pubkey)) {
        const resolved = await queryProfile(params.pubkey)
        if (resolved) {
          return loadNostrUser({
            ...params,
            pubkey: resolved.pubkey,
            relays: [...(params.relays || []), ...(resolved.relays || [])]
          })
        }
      }
      return loadNostrUser(params)
    case "napp.publish":
      return publishEvent(params.event, params.relays)
    case "napp.loadEvent":
      return loadEvent(params)
    default:
      throw new Error(`unsupported method: ${method}`)
  }
}

export async function loadEvent(params: { code: string; relays?: string[]; author?: string }) {
  let id: string | undefined
  let kind: number | undefined
  let author: string | undefined
  let identifier: string | undefined
  let relayHints: string[] = params.relays || []

  let isReplaceable = false
  if (params.code.startsWith("nevent1")) {
    const { data } = decode(params.code)
    const ptr = data as { id: string; relays?: string[]; author?: string; kind?: number }
    id = ptr.id
    if (ptr.relays) relayHints.push(...ptr.relays)
    author = ptr.author || params.author
    kind = ptr.kind
  } else if (params.code.startsWith("naddr1")) {
    isReplaceable = true
    const { data } = decode(params.code)
    const ptr = data as { identifier: string; pubkey: string; kind: number; relays?: string[] }
    identifier = ptr.identifier
    author = ptr.pubkey
    kind = ptr.kind
    if (ptr.relays) relayHints.push(...ptr.relays)
  } else {
    id = params.code
    author = params.author
  }

  // try store
  let event: NostrEvent | undefined
  if (identifier && author && kind) {
    const results = await store.loadReplaceables([[kind, author, identifier]])
    event = results[0][1] as NostrEvent | undefined
  } else if (id) {
    const results = await store.queryEvents({ ids: [id] }, 1)
    event = results[0]
  }
  if (event) return event

  // prepare filter for relays
  let filter: Record<string, any> = { limit: 1 }
  if (identifier) {
    filter.kinds = [kind]
    filter.authors = [author]
    if (identifier !== "") filter["#d"] = [identifier]
  } else {
    filter.ids = [id!]
  }

  // try relay hints first
  let evt = await queryRelays(relayHints)
  if (evt) return evt

  // then try author's relay list
  if (author) {
    try {
      const list = await loadRelayList(author)
      evt = await queryRelays(list.items.filter(item => item.read).map(item => item.url))
      if (evt) return evt
    } catch {}
  }

  // finally try fallback relays
  evt = await queryRelays(FALLBACK_RELAYS)
  if (evt) return evt

  return null

  async function queryRelays(relays: string[]): Promise<NostrEvent | null> {
    if (relays.length === 0) return null
    const results = await pool.querySync(relays, filter, { maxWait: 4000 })
    if (isReplaceable) results.sort((a, b) => b.created_at - a.created_at)
    const evt = results[0]
    if (evt) await store.saveEvent(evt)
    return evt || null
  }
}

type PublishResult = {
  relays: Record<string, { ok: boolean; error?: string }>
  published: number
  failed: number
}

async function publishEvent(event: NostrEvent, relays?: string[]): Promise<PublishResult> {
  let targetRelays: string[]

  if (relays) {
    targetRelays = relays
  } else {
    const pubkey = event.pubkey
    try {
      const list = await loadRelayList(pubkey)
      targetRelays = list.items.filter(item => item.write).map(item => item.url)
    } catch {
      targetRelays = []
    }

    if (event.kind === 10002) {
      targetRelays.push(
        ...FALLBACK_RELAYS,
        "wss://purplepag.es",
        "wss://indexer.coracle.social",
        "wss://user.kindpag.es",
        "wss://relay.nos.social"
      )
    } else if (event.kind === 3) {
      targetRelays.push(
        ...FALLBACK_RELAYS,
        "wss://purplepag.es",
        "wss://user.kindpag.es",
        "wss://relay.nos.social"
      )
    }

    targetRelays = [...new Set(targetRelays)]
  }

  if (targetRelays.length === 0) {
    return { relays: {}, published: 0, failed: 0 }
  }

  const promises = pool.publish(targetRelays, event)
  const settled = await Promise.allSettled(promises)

  const relaysMap: Record<string, { ok: boolean; error?: string }> = {}
  let published = 0
  let failed = 0

  for (let i = 0; i < targetRelays.length; i++) {
    const result = settled[i]
    const relayUrl = targetRelays[i]
    if (result.status === "fulfilled") {
      relaysMap[relayUrl] = { ok: true }
      published++
    } else {
      relaysMap[relayUrl] = { ok: false, error: result.reason?.message ?? String(result.reason) }
      failed++
    }
  }

  return { relays: relaysMap, published, failed }
}
