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
import { getStore, safeQueryEvents } from "../store.js"
import { createNappWindow } from "./napp-window.js"
// The napplet-only bridge (window.napplet, no window.nostr), inlined verbatim
// into a napplet's srcdoc before its verified bytes.
import nappletBridgeSource from "../../public/napplet-bridge.js?raw"
import { fetchBlob } from "../nsite/fetch.js"
import {
  loadBlossomServers,
  loadBookmarks,
  loadEmojis,
  loadFavoriteRelays,
  loadFollowsList,
  loadMuteList,
  loadPins,
  loadRelayList,
  loadWikiAuthors,
  loadWikiRelays
} from "@nostr/gadgets/lists"
import { loadBlockedRelays, loadDmRelays, loadSearchRelays } from "../extra-lists.js"
import { loadEmojiSets, loadFollowSets, loadRelaySets } from "@nostr/gadgets/sets"
import { outboxFilterRelayBatch } from "@nostr/gadgets/outbox"
import { loadNostrUser } from "@nostr/gadgets/metadata"
import { loadRelayInfo } from "@nostr/gadgets/relays"
import { pool } from "@nostr/gadgets/global"
import type { SubCloser } from "@nostr/tools/abstract-pool"
import type { NostrEvent } from "@nostr/tools/core"
import { matchFilter, type Filter } from "@nostr/tools/filter"
import { isNip05, queryProfile } from "@nostr/tools/nip05"
import {
  decode,
  naddrEncode,
  neventEncode,
  noteEncode,
  nprofileEncode,
  npubEncode
} from "@nostr/tools/nip19"
import { verifyEvent } from "@nostr/tools/pure"
import { isAddressableKind, isReplaceableKind } from "@nostr/tools/kinds"
import {
  getInstalledApp,
  getNappletConfig,
  getPolicy,
  getStoredPolicy,
  nappletStorageGet,
  nappletStorageKeys,
  nappletStorageRemove,
  nappletStorageSet,
  rememberEphemeralOrigin,
  setNappletConfigSchema,
  updateOpen
} from "../persistence.js"
import {
  effectiveConfigValues,
  openNappConfigSettings,
  validateConfigSchema
} from "../napp-config.js"
import type { NappPolicy } from "../types.js"
import { getPubkey, subscribe as onAccountChanged } from "../account.js"
import { currentSigner } from "../signers/index.js"
import { current as outboxCurrent, outbox, FALLBACK_RELAYS, goLive } from "../outbox.js"
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

// Same flag, for a window arriving from another space: to the packed space it
// lands in it may as well be new, and the position it carries describes the
// layout it just left. Packing it last first-fits it into the leftover space
// instead of letting it claim a cell and reflow its new neighbours.
// bestFitPack clears the flag once consumed.
export function markPackNew(instanceId: string) {
  const win = openWindows.get(instanceId)
  if (win) win.root.dataset.packNew = "1"
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

export function hasOpenWindow(instanceId: string): boolean {
  return openWindows.has(instanceId)
}

// Re-tag a live window to another space. It stays mounted (no reload); moving to
// a non-active space just hides it via .space-inactive until that space is
// shown. The persisted entry is relocated separately (persist.moveOpenToSpace).
export function moveWindowToSpace(instanceId: string, targetSpaceId: string) {
  const win = openWindows.get(instanceId)
  if (!win) return
  win.root.dataset.space = targetSpaceId
  win.root.classList.toggle("space-inactive", targetSpaceId !== activeSpace)
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
  // NIP-5D theme push — only napps granted the `theme` domain hear it.
  broadcastNappletThemeChanged()
}

// ─── NIP-5D (window.napplet) — the NAP capability seam ──────────────
// Additive, and entirely separate from our napp surface (window.napp /
// window.nostr): a napplet speaks the NIP-5D wire dialect
// ({type:"domain.action", id, ...} → {type:"...result", id, ...fields}) over
// postMessage. Per the spec there is NO shell handshake — availability is
// signalled by PRESENCE of a domain object on window.napplet, and the shell
// injects only the domains it grants (see the SW's __nappletDomains injection
// + bridge.js). So the host's job is just: service a granted-domain call with
// its exact per-domain result shape, and silently ignore everything else.
//
// Result shapes are the @napplet/nap contracts verbatim — each result carries
// named top-level fields (pubkey / relays / profile / pubkeys / entries /
// theme …), NOT a generic {ok, result} wrapper, so an app built with
// @napplet/shim runs here unchanged.

// Capability domains the launcher implements (NAPPLET_OFFERED). Keep in sync
// with DOMAIN_INFO in napp-permissions.ts and the bridge's factory set.
const NAPPLET_OFFERED = [
  "identity",
  "theme",
  "storage",
  "resource",
  "relay",
  "outbox",
  "common",
  "inc",
  "link",
  "config"
]

// The capability domains this napp is actually granted: declared (via
// ["requires", "<domain>"] manifest tags or a metadata.json `requires` array)
// ∩ what we implement ∩ what the user granted in the permission screen. Empty
// for a plain napp that declared nothing — it never enters the seam.
export function nappletDomainsFor(nappId: string): string[] {
  const app = getInstalledApp(nappId)
  if (!app) return []
  const declared = new Set<string>()
  for (const t of app.event?.tags ?? []) {
    if (t[0] === "requires" && typeof t[1] === "string" && t[1]) declared.add(t[1])
  }
  for (const d of app.requires ?? []) declared.add(d)
  if (declared.size === 0) return []
  const granted = new Set(getPolicy(nappId).domains)
  return NAPPLET_OFFERED.filter(d => declared.has(d) && granted.has(d))
}

function nappletTheme() {
  const cs = getComputedStyle(document.documentElement)
  const surface = cs.getPropertyValue("--surface").trim()
  const text = cs.getPropertyValue("--text").trim()
  const primary = cs.getPropertyValue("--primary").trim() || text
  return { title: currentTheme(), colors: { background: surface, text, primary } }
}

function broadcastNappletThemeChanged() {
  const theme = nappletTheme()
  for (const [, win] of openWindows) {
    const nappId = win.root?.dataset.nappId
    if (!nappId || !nappletDomainsFor(nappId).includes("theme")) continue
    if (!win.iframe?.contentWindow) continue
    try {
      win.iframe.contentWindow.postMessage(
        { type: "theme.changed", theme },
        iframeTargetOrigin(win.iframe)
      )
    } catch {}
  }
}

// srcdoc napplets have no src (opaque origin) — pushes to them must target "*".
const iframeTargetOrigin = (iframe: HTMLIFrameElement) =>
  iframe.src ? new URL(iframe.src).origin : "*"

// identity.changed: pushed when the launcher account connects/disconnects.
onAccountChanged(pk => {
  for (const [, win] of openWindows) {
    const nappId = win.root?.dataset.nappId
    if (!nappId || !nappletDomainsFor(nappId).includes("identity")) continue
    if (!win.iframe?.contentWindow) continue
    try {
      win.iframe.contentWindow.postMessage(
        { type: "identity.changed", pubkey: pk || "" },
        iframeTargetOrigin(win.iframe)
      )
    } catch {}
  }
})

const NAPPLET_LISTS: Record<string, (pk: string) => Promise<{ items: unknown[] }>> = {
  bookmarks: pk => loadBookmarks(pk),
  pins: pk => loadPins(pk),
  emojis: pk => loadEmojis(pk),
  "blossom-servers": pk => loadBlossomServers(pk),
  "favorite-relays": pk => loadFavoriteRelays(pk),
  "wiki-authors": pk => loadWikiAuthors(pk),
  "wiki-relays": pk => loadWikiRelays(pk)
}

// Request/response napplet ops. Each case returns the FULL result message
// (its own `type` + named fields) — the @napplet/nap contracts differ per
// domain (resource uses a `.error` type; relay.publish carries `ok`), so the
// handler owns its exact shape rather than a generic wrapper. `id` is attached
// by the caller. Streaming ops (relay.subscribe/close, resource.cancel) are
// handled in handleNapplet, not here — they have no single .result.
async function dispatchNapplet(
  type: string,
  data: any,
  nappId: string
): Promise<Record<string, unknown>> {
  const pk = getPubkey()
  switch (type) {
    // ── identity (read-only; never prompts the signer) ──
    case "identity.getPublicKey":
      return { type: "identity.getPublicKey.result", pubkey: pk || "" }
    case "identity.getRelays": {
      const relays: Record<string, { read: boolean; write: boolean }> = {}
      if (pk)
        for (const item of (await loadRelayList(pk)).items)
          relays[item.url] = { read: !!item.read, write: !!item.write }
      return { type: "identity.getRelays.result", relays }
    }
    case "identity.getProfile": {
      const profile = pk ? ((await loadNostrUser(pk))?.metadata ?? null) : null
      return { type: "identity.getProfile.result", profile }
    }
    case "identity.getFollows":
      return {
        type: "identity.getFollows.result",
        pubkeys: pk ? (await loadFollowsList(pk)).items : []
      }
    case "identity.getMutes":
      return {
        type: "identity.getMutes.result",
        pubkeys: pk ? (await loadMuteList(pk)).items : []
      }
    case "identity.getList": {
      const loader = NAPPLET_LISTS[data?.listType]
      if (!loader) throw new Error(`unknown list: ${data?.listType}`)
      return { type: "identity.getList.result", entries: pk ? (await loader(pk)).items : [] }
    }

    // ── theme (read-only) ──
    case "theme.get":
      return { type: "theme.get.result", theme: nappletTheme() }

    // ── storage (host-backed KV, per-napp) ──
    case "storage.get":
      return {
        type: "storage.get.result",
        value: nappletStorageGet(nappId, data?.scope, String(data?.key ?? ""))
      }
    case "storage.set":
      nappletStorageSet(nappId, data?.scope, String(data?.key ?? ""), String(data?.value ?? ""))
      return { type: "storage.set.result" }
    case "storage.remove":
      nappletStorageRemove(nappId, data?.scope, String(data?.key ?? ""))
      return { type: "storage.remove.result" }
    case "storage.keys":
      return { type: "storage.keys.result", keys: nappletStorageKeys(nappId, data?.scope) }

    // ── resource (the sanctioned fetch — works even when direct network is
    //    locked, because the host, not the napplet, makes the request) ──
    case "resource.bytes":
      return fetchNappletResource(data?.url)
    case "resource.bytesMany": {
      const urls: string[] = Array.isArray(data?.urls) ? data.urls : []
      const items = await Promise.all(
        urls.map(async url => {
          const r = await fetchNappletResource(url)
          return r.type === "resource.bytes.result"
            ? { ok: true, url, blob: r.blob, mime: r.mime }
            : { ok: false, url, error: r.error, message: r.message }
        })
      )
      return { type: "resource.bytesMany.result", items }
    }

    // ── relay (the napplet never holds keys: publish sends an UNSIGNED
    //    template, the host signs behind a permission prompt) ──
    case "relay.publish":
      return publishNappletEvent(nappId, data?.event, null)
    case "relay.publishEncrypted":
      return publishNappletEvent(nappId, data?.event, {
        recipient: String(data?.recipient ?? ""),
        encryption: data?.encryption === "nip04" ? "nip04" : "nip44"
      })
    case "relay.query": {
      const filters: any[] = Array.isArray(data?.filters) ? data.filters : []
      const relays = await nappletReadRelays(pk)
      const seen = new Set<string>()
      const events: { event: NostrEvent }[] = []
      for (const f of filters) {
        const filter = sanitizeFilter(f)
        if (!filter) continue
        for (const e of await pool.querySync(relays, filter, { maxWait: 4000 })) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          events.push({ event: e })
        }
      }
      return { type: "relay.query.result", events }
    }

    // ── outbox (NIP-65 outbox-model routing: the host discovers each author's
    //    write relays, queries there, dedups; publish fans out to writer +
    //    recipient inboxes) ──
    case "outbox.getEvent": {
      const eventId = String(data?.eventId ?? "")
      if (!isHex64(eventId)) {
        return { type: "outbox.getEvent.result", error: "invalid-request" }
      }
      const opts = data?.options ?? {}
      const authorHint = isHex64(opts?.author) ? [opts.author] : []
      const events = await outboxQueryEvents([{ ids: [eventId] }], {
        authors: authorHint,
        relays: Array.isArray(opts?.relays) ? opts.relays : [],
        limit: 1
      })
      return events.length
        ? { type: "outbox.getEvent.result", result: { event: events[0] } }
        : { type: "outbox.getEvent.result", incomplete: true }
    }
    case "outbox.query": {
      const filters = Array.isArray(data?.filters) ? data.filters : [data?.filters]
      const opts = data?.options ?? {}
      const events = await outboxQueryEvents(filters, {
        authors: Array.isArray(opts?.authors) ? opts.authors.filter(isHex64) : [],
        relays: Array.isArray(opts?.relays) ? opts.relays : [],
        limit: Number.isFinite(opts?.limit) ? opts.limit : undefined
      })
      return { type: "outbox.query.result", events: events.map(event => ({ event })) }
    }
    case "outbox.publish":
      return publishNappletOutbox(nappId, data?.event, data?.options ?? {})
    case "outbox.resolveRelays":
      return { type: "outbox.resolveRelays.result", plan: await outboxResolvePlan(data?.target) }

    // ── common (NAP-COMMON social actions: the shell owns nip19, profile
    //    lookup and event construction; each write prompts like a publish).
    //    Results carry `ok` per contract — ok:false is an answer, not an error.
    case "common.encodeNip19":
      return commonEncodeNip19(data?.input)
    case "common.decodeNip19":
      return commonDecodeNip19(data?.value)
    case "common.getProfile":
      return commonGetProfile(data?.target)
    case "common.follows": {
      if (!pk)
        return { type: "common.follows.result", ok: false, pubkeys: [], error: "no user connected" }
      return { type: "common.follows.result", ok: true, pubkeys: (await loadFollowsList(pk)).items }
    }
    case "common.follow":
      return commonFollowChange(nappId, data?.pubkeys, true)
    case "common.unfollow":
      return commonFollowChange(nappId, data?.pubkeys, false)
    case "common.react":
      return commonReact(nappId, data)
    case "common.report":
      return commonReport(nappId, data)

    // ── link (open a URL in a new tab, behind a prompt) ──
    case "link.open":
      return linkOpen(nappId, data)

    // ── config (shell-owned settings: the app registers a schema, the shell
    //    renders/stores the form; get answers with a config.values message) ──
    case "config.registerSchema": {
      const bad = validateConfigSchema(data?.schema)
      if (bad) {
        return {
          type: "config.registerSchema.result",
          ok: false,
          code: bad.code,
          error: `${bad.code}: ${bad.error}`
        }
      }
      const version = Number.isFinite(data?.version) ? Number(data.version) : undefined
      const cur = getNappletConfig(nappId)
      if (version !== undefined && cur.version !== undefined && version < cur.version) {
        return {
          type: "config.registerSchema.result",
          ok: false,
          code: "version-conflict",
          error: `version-conflict: stored v${cur.version} is newer`
        }
      }
      setNappletConfigSchema(nappId, data.schema, version)
      return { type: "config.registerSchema.result", ok: true }
    }
    case "config.get":
      return { type: "config.values", values: effectiveConfigValues(nappId) }

    default:
      throw new Error(`unsupported napplet call: ${type}`)
  }
}

// Union of hex64 authors across a set of (possibly array) filters.
function authorsFromFilters(filters: any[]): string[] {
  const out = new Set<string>()
  for (const f of filters) {
    if (Array.isArray(f?.authors)) for (const a of f.authors) if (isHex64(a)) out.add(a)
  }
  return [...out]
}

// Outbox-model read (one-shot): resolve each author's write relays (NIP-65) and
// query there, deduping by id. Filters with no authors fall back to the user's
// read relays (+ any relay hints). Bounded by a wall-clock budget.
async function outboxQueryEvents(
  rawFilters: any[],
  opts: { authors?: string[]; relays?: string[]; limit?: number }
): Promise<NostrEvent[]> {
  const clean = rawFilters.map(f => sanitizeFilter(f)).filter(Boolean) as any[]
  if (clean.length === 0) return []
  const authors = [...new Set([...(opts.authors ?? []), ...authorsFromFilters(clean)])]
  const hintRelays = (opts.relays ?? []).filter(u => typeof u === "string" && u)

  const seen = new Set<string>()
  const events: NostrEvent[] = []
  const collect = (event: NostrEvent) => {
    if (seen.has(event.id)) return
    seen.add(event.id)
    events.push(event)
  }

  if (authors.length) {
    // Outbox routing needs authors. Strip `authors` from the base filter and let
    // outboxFilterRelayBatch fan it out across each author's write relays.
    const maps = await outboxFilterRelayBatch(
      authors,
      clean.map(({ authors: _drop, ...rest }) => rest),
      { fallbackRelays: [...hintRelays, ...FALLBACK_RELAYS] }
    )
    if (maps.length) {
      await new Promise<void>(resolve => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          try {
            sub.close()
          } catch {}
          resolve()
        }
        const timer = setTimeout(finish, 4500)
        const sub: SubCloser = pool.subscribeMap(maps, {
          label: "napplet-outbox",
          onevent: collect,
          oneose: finish
        })
      })
    }
  } else {
    const relays = [...hintRelays, ...FALLBACK_RELAYS]
    for (const filter of clean)
      for (const e of await pool.querySync(relays, filter, { maxWait: 4000 })) collect(e)
  }

  const limit = opts.limit
  return typeof limit === "number" && limit >= 0 ? events.slice(0, limit) : events
}

// Resolve the relay plan the shell would use for a read/write target. Reading
// someone's notes uses their WRITE relays (outbox); writing to them (an inbox)
// uses their READ relays. Mirrors OutboxRelayPlan.
async function outboxResolvePlan(
  target: any
): Promise<{ relays: string[]; source: string; missingAuthors?: string[] }> {
  const direction: "read" | "write" = target?.direction === "write" ? "write" : "read"
  const authors = new Set<string>()
  if (isHex64(target?.pubkey)) authors.add(target.pubkey)
  if (Array.isArray(target?.authors)) for (const a of target.authors) if (isHex64(a)) authors.add(a)
  if (authors.size === 0) return { relays: [...FALLBACK_RELAYS], source: "fallback" }

  const relays = new Set<string>()
  const missing: string[] = []
  for (const pk of authors) {
    try {
      // read the author's notes  → their write relays; write to their inbox → read.
      const items = (await loadRelayList(pk)).items.filter(i =>
        direction === "read" ? i.write : i.read
      )
      if (items.length) for (const i of items) relays.add(i.url)
      else missing.push(pk)
    } catch {
      missing.push(pk)
    }
  }
  if (relays.size === 0)
    return { relays: [...FALLBACK_RELAYS], source: "fallback", missingAuthors: missing }
  const plan: { relays: string[]; source: string; missingAuthors?: string[] } = {
    relays: [...relays],
    source: "nip65"
  }
  if (missing.length) plan.missingAuthors = missing
  return plan
}

// Outbox publish: sign the template (behind a prompt), then fan out to the
// user's write relays (toOutbox, default on), each recipient's read relays
// (toInboxes), and any explicit relay hints. Returns per-relay success.
async function publishNappletOutbox(
  nappId: string,
  template: any,
  options: any
): Promise<Record<string, unknown>> {
  const resultType = "outbox.publish.result"
  if (!template || typeof template !== "object") {
    return { type: resultType, ok: false, error: "invalid event template" }
  }
  const signer = currentSigner()
  if (!signer) return { type: resultType, ok: false, error: "no signer connected" }

  const kind = Number(template.kind)
  if (
    !(await requireApproval(
      nappId,
      "outbox.publish",
      `Sign and publish a kind ${kind} event on your behalf.`
    ))
  ) {
    return { type: resultType, ok: false, error: "permission denied" }
  }

  try {
    const signed = await signer.signEvent({
      kind,
      content: String(template.content ?? ""),
      tags: Array.isArray(template.tags) ? template.tags : [],
      created_at: Number(template.created_at) || Math.floor(Date.now() / 1000)
    })

    const targets = new Set<string>()
    if (options?.toOutbox !== false)
      for (const u of await nappletWriteRelays(getPubkey())) targets.add(u)
    if (Array.isArray(options?.relays))
      for (const u of options.relays) if (typeof u === "string" && u) targets.add(u)
    const inboxes: string[] = Array.isArray(options?.toInboxes)
      ? options.toInboxes.filter(isHex64)
      : []
    for (const pk of inboxes) {
      try {
        for (const i of (await loadRelayList(pk)).items) if (i.read) targets.add(i.url)
      } catch {}
    }
    if (targets.size === 0) for (const u of FALLBACK_RELAYS) targets.add(u)

    const urls = [...targets]
    const results = await Promise.allSettled(pool.publish(urls, signed))
    const relays: Record<string, boolean> = {}
    urls.forEach((u, i) => (relays[u] = results[i]?.status === "fulfilled"))
    const ok = Object.values(relays).some(Boolean)
    return { type: resultType, ok, event: signed, eventId: signed.id, relays }
  } catch (err: any) {
    return { type: resultType, ok: false, error: err?.message ?? String(err) }
  }
}

// Fetch a URL's bytes on the host. Returns a resource.bytes result (Blob +
// content-type) or a typed resource.bytes.error.
async function fetchNappletResource(url: unknown): Promise<Record<string, unknown>> {
  if (typeof url !== "string" || !url) {
    return { type: "resource.bytes.error", error: "invalid-request", message: "missing url" }
  }
  // blossom:<sha256> (optional "sha256:" prefix) — resolve the blob from Blossom
  // by hash, where napplet assets and nostr avatars actually live. fetchBlob
  // verifies sha256(blob) === hash across the user's servers + our default.
  if (url.startsWith("blossom:")) {
    const sha = url.slice("blossom:".length).replace(/^sha256:/, "")
    if (!isHex64(sha)) {
      return {
        type: "resource.bytes.error",
        error: "invalid-request",
        message: "expected blossom:<sha256>"
      }
    }
    try {
      const pk = getPubkey()
      const userServers = pk ? ((await loadBlossomServers(pk)).items ?? []) : []
      const servers = ["relay.nostrapps.com", ...new Set(userServers)].filter(Boolean) as string[]
      const blob = await fetchBlob(servers, sha)
      if (!blob) {
        return {
          type: "resource.bytes.error",
          error: "not-found",
          message: `blossom blob ${sha} unreachable`
        }
      }
      return {
        type: "resource.bytes.result",
        blob,
        mime: blob.type || "application/octet-stream"
      }
    } catch (err: any) {
      return {
        type: "resource.bytes.error",
        error: "fetch-failed",
        message: err?.message ?? String(err)
      }
    }
  }
  try {
    const u = new URL(url)
    if (!["https:", "http:", "data:", "blob:"].includes(u.protocol)) {
      return {
        type: "resource.bytes.error",
        error: "unsupported-scheme",
        message: `scheme ${u.protocol} not allowed`
      }
    }
    const res = await fetch(url)
    if (!res.ok) {
      return { type: "resource.bytes.error", error: "http-error", message: `HTTP ${res.status}` }
    }
    const blob = await res.blob()
    return {
      type: "resource.bytes.result",
      blob,
      mime: res.headers.get("content-type") || blob.type || "application/octet-stream"
    }
  } catch (err: any) {
    return {
      type: "resource.bytes.error",
      error: "fetch-failed",
      message: err?.message ?? String(err)
    }
  }
}

// Sign (and optionally encrypt) a napplet's event template with the user's
// signer, behind a permission prompt, then publish. The napplet never sees a
// key. Returns a relay.publish(.Encrypted).result.
async function publishNappletEvent(
  nappId: string,
  template: any,
  enc: { recipient: string; encryption: "nip44" | "nip04" } | null
): Promise<Record<string, unknown>> {
  const resultType = enc ? "relay.publishEncrypted.result" : "relay.publish.result"
  if (!template || typeof template !== "object") {
    return { type: resultType, ok: false, error: "invalid event template" }
  }
  const signer = currentSigner()
  if (!signer) return { type: resultType, ok: false, error: "no signer connected" }

  const kind = Number(template.kind)
  const detail = enc
    ? `Encrypt (${enc.encryption}) and publish a kind ${kind} event to ${enc.recipient.slice(0, 12)}…`
    : `Sign and publish a kind ${kind} event on your behalf.`
  if (!(await requireApproval(nappId, enc ? "relay.publishEncrypted" : "relay.publish", detail))) {
    return { type: resultType, ok: false, error: "permission denied" }
  }

  try {
    const tags: string[][] = Array.isArray(template.tags) ? template.tags : []
    let content = String(template.content ?? "")
    let finalTags = tags
    if (enc) {
      content = await signer[enc.encryption].encrypt(enc.recipient, content)
      if (!finalTags.some(t => t[0] === "p" && t[1] === enc.recipient))
        finalTags = [...finalTags, ["p", enc.recipient]]
    }
    const signed = await signer.signEvent({
      kind,
      content,
      tags: finalTags,
      created_at: Number(template.created_at) || Math.floor(Date.now() / 1000)
    })
    const relays = await nappletWriteRelays(getPubkey())
    await Promise.allSettled(pool.publish(relays, signed))
    return { type: resultType, ok: true, event: signed, eventId: signed.id }
  } catch (err: any) {
    return { type: resultType, ok: false, error: err?.message ?? String(err) }
  }
}

// ── common (NAP-COMMON) ──

function commonEncodeNip19(input: any): Record<string, unknown> {
  const resultType = "common.encodeNip19.result"
  try {
    let value: string
    switch (input?.type) {
      case "npub":
        value = npubEncode(String(input.hex))
        break
      case "note":
        value = noteEncode(String(input.hex))
        break
      case "nprofile":
        value = nprofileEncode({ pubkey: String(input.pubkey), relays: input.relays ?? [] })
        break
      case "nevent":
        value = neventEncode({
          id: String(input.eventId),
          relays: input.relays ?? [],
          ...(isHex64(input.author) ? { author: input.author } : {}),
          ...(typeof input.kind === "number" ? { kind: input.kind } : {})
        })
        break
      case "naddr":
        value = naddrEncode({
          identifier: String(input.identifier ?? ""),
          pubkey: String(input.pubkey),
          kind: Number(input.kind),
          relays: input.relays ?? []
        })
        break
      default:
        return { type: resultType, ok: false, error: `unsupported type: ${input?.type}` }
    }
    return { type: resultType, ok: true, value, nip19Type: input.type }
  } catch (err: any) {
    return { type: resultType, ok: false, error: err?.message ?? String(err) }
  }
}

// nsec deliberately stays out of the seam.
function commonDecodeNip19(value: unknown): Record<string, unknown> {
  const resultType = "common.decodeNip19.result"
  try {
    const d = decode(String(value ?? "").replace(/^nostr:/, ""))
    switch (d.type) {
      case "npub":
        return { type: resultType, ok: true, nip19Type: "npub", hex: d.data, pubkey: d.data }
      case "note":
        return { type: resultType, ok: true, nip19Type: "note", hex: d.data }
      case "nprofile":
        return {
          type: resultType,
          ok: true,
          nip19Type: "nprofile",
          pubkey: d.data.pubkey,
          relays: d.data.relays ?? []
        }
      case "nevent":
        return {
          type: resultType,
          ok: true,
          nip19Type: "nevent",
          eventId: d.data.id,
          relays: d.data.relays ?? [],
          ...(d.data.author ? { author: d.data.author } : {}),
          ...(typeof d.data.kind === "number" ? { kind: d.data.kind } : {})
        }
      case "naddr":
        return {
          type: resultType,
          ok: true,
          nip19Type: "naddr",
          identifier: d.data.identifier,
          pubkey: d.data.pubkey,
          kind: d.data.kind,
          relays: d.data.relays ?? []
        }
      default:
        return { type: resultType, ok: false, error: `unsupported nip19 type: ${d.type}` }
    }
  } catch (err: any) {
    return { type: resultType, ok: false, error: err?.message ?? String(err) }
  }
}

// hex pubkey, npub or nprofile → hex, or "".
function commonTargetPubkey(target: unknown): string {
  const s = String(target ?? "").replace(/^nostr:/, "")
  // HEX64 directly: the isHex64 guard would narrow s to `never` past a return.
  if (HEX64.test(s)) return s
  try {
    const d = decode(s)
    if (d.type === "npub") return d.data
    if (d.type === "nprofile") return d.data.pubkey
  } catch {}
  return ""
}

async function commonGetProfile(target: unknown): Promise<Record<string, unknown>> {
  const resultType = "common.getProfile.result"
  const pk = commonTargetPubkey(target)
  if (!pk) return { type: resultType, ok: false, pubkey: "", error: "invalid target" }
  try {
    const user = await loadNostrUser(pk)
    const m = user?.metadata ?? null
    const hasProfile = !!(m && Object.keys(m).length)
    return {
      type: resultType,
      ok: true,
      pubkey: pk,
      profile: hasProfile
        ? { ...m, ...(m.display_name ? { displayName: m.display_name } : {}) }
        : null,
      // gadgets caches parsed kind-0s, not raw events — reconstruct the shape
      // callers read (content/created_at); id/sig are not recoverable.
      ...(hasProfile
        ? {
            result: {
              event: {
                kind: 0,
                pubkey: pk,
                content: JSON.stringify(m),
                created_at: user.lastUpdated || 0,
                tags: [],
                id: "",
                sig: ""
              }
            }
          }
        : {})
    }
  } catch (err: any) {
    return { type: resultType, ok: false, pubkey: pk, error: err?.message ?? String(err) }
  }
}

// Sign-and-broadcast core shared by the common write actions. Same shape as
// publishNappletEvent but with per-action approval keys and prompt copy.
async function commonAction(
  nappId: string,
  action: string,
  detail: string,
  template: { kind: number; content: string; tags: string[][] }
): Promise<Record<string, unknown>> {
  const resultType = `${action}.result`
  const signer = currentSigner()
  if (!signer) return { type: resultType, ok: false, error: "no signer connected" }
  if (!(await requireApproval(nappId, action, detail))) {
    return { type: resultType, ok: false, error: "permission denied" }
  }
  try {
    const signed = await signer.signEvent({
      ...template,
      created_at: Math.floor(Date.now() / 1000)
    })
    await Promise.allSettled(pool.publish(await nappletWriteRelays(getPubkey()), signed))
    return { type: resultType, ok: true, event: signed, eventId: signed.id }
  } catch (err: any) {
    return { type: resultType, ok: false, error: err?.message ?? String(err) }
  }
}

async function commonFollowChange(
  nappId: string,
  raw: unknown,
  add: boolean
): Promise<Record<string, unknown>> {
  const resultType = add ? "common.follow.result" : "common.unfollow.result"
  const pk = getPubkey()
  if (!pk) return { type: resultType, ok: false, error: "no user connected" }
  const targets = new Set<string>()
  for (const t of Array.isArray(raw) ? raw : []) {
    const hex = commonTargetPubkey(t)
    if (hex) targets.add(hex)
  }
  if (!targets.size) return { type: resultType, ok: false, error: "no valid pubkeys" }

  // Base the rewrite on the latest kind 3 we can see so petnames, content and
  // unrelated tags survive. If relays hid the current list this can still
  // clobber it — same view identity.getFollows serves, so at least consistent.
  const current = await loadFollowsList(pk)
  const base: string[][] = current.event?.tags ?? current.items.map(p => ["p", p])
  const have = new Set(base.filter(t => t[0] === "p").map(t => t[1]))
  const wanted = [...targets].filter(t => (add ? !have.has(t) : have.has(t)))
  if (!wanted.length) return { type: resultType, ok: true } // already there
  const tags = add
    ? [...base, ...wanted.map(t => ["p", t])]
    : base.filter(t => t[0] !== "p" || !targets.has(t[1]))
  const detail = `${add ? "Follow" : "Unfollow"} ${wanted.length} profile${
    wanted.length === 1 ? "" : "s"
  } (rewrites your follow list).`
  return commonAction(nappId, add ? "common.follow" : "common.unfollow", detail, {
    kind: 3,
    content: current.event?.content ?? "",
    tags
  })
}

async function commonReact(nappId: string, data: any): Promise<Record<string, unknown>> {
  const resultType = "common.react.result"
  const id = String(data?.targetEventId ?? "")
  if (!isHex64(id)) return { type: resultType, ok: false, error: "invalid event id" }
  const reaction = String(data?.reaction ?? "+") || "+"
  // NIP-25 wants e + p (+ k) — find the target for author/kind; react with a
  // bare e-tag when it's unreachable.
  const [target] = await outboxQueryEvents([{ ids: [id] }], { limit: 1 })
  const tags: string[][] = [["e", id]]
  if (target) tags.push(["p", target.pubkey], ["k", String(target.kind)])
  const shortcode = /^:(.+):$/.exec(reaction)?.[1]
  if (shortcode && typeof data?.customEmojiHref === "string" && data.customEmojiHref) {
    tags.push(["emoji", shortcode, data.customEmojiHref])
  }
  return commonAction(nappId, "common.react", `React ${reaction} to event ${id.slice(0, 8)}….`, {
    kind: 7,
    content: reaction,
    tags
  })
}

async function commonReport(nappId: string, data: any): Promise<Record<string, unknown>> {
  const resultType = "common.report.result"
  const t = data?.target
  const reason = String(data?.reason ?? "other")
  const tags: string[][] = []
  if (t?.type === "event" && isHex64(String(t.id ?? ""))) {
    tags.push(["e", String(t.id), reason])
    if (isHex64(String(t.pubkey ?? ""))) tags.push(["p", String(t.pubkey)])
  } else if (t?.type === "pubkey") {
    const hex = commonTargetPubkey(t.pubkey)
    if (!hex) return { type: resultType, ok: false, error: "invalid pubkey" }
    tags.push(["p", hex, reason])
  } else {
    return { type: resultType, ok: false, error: "invalid target" }
  }
  return commonAction(nappId, "common.report", `Publish a NIP-56 ${reason} report.`, {
    kind: 1984,
    content: String(data?.text ?? ""),
    tags
  })
}

// ── link (NAP-LINK) ──

async function linkOpen(nappId: string, data: any): Promise<Record<string, unknown>> {
  const resultType = "link.open.result"
  let url: URL
  try {
    url = new URL(String(data?.url ?? ""))
  } catch {
    return { type: resultType, error: "invalid-url" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { type: resultType, error: "unsupported-scheme" }
  }
  const label = typeof data?.options?.label === "string" ? ` — "${data.options.label}"` : ""
  if (!(await requireApproval(nappId, "link.open", `Open ${url.href} in a new tab${label}.`))) {
    return { type: resultType, status: "denied" }
  }
  // A remembered allow arrives with no user activation left; report a blocked
  // popup as denied rather than pretending it opened.
  const win = window.open(url.href, "_blank", "noopener,noreferrer")
  return { type: resultType, status: win ? "opened" : "denied" }
}

// The user's read/write relays, or fallbacks — used for relay.query/subscribe
// and relay.publish targets.
async function nappletReadRelays(pk: string | null): Promise<string[]> {
  if (!pk) return FALLBACK_RELAYS
  try {
    const r = (await loadRelayList(pk)).items.filter(i => i.read).map(i => i.url)
    return r.length ? r : FALLBACK_RELAYS
  } catch {
    return FALLBACK_RELAYS
  }
}
async function nappletWriteRelays(pk: string | null): Promise<string[]> {
  if (!pk) return FALLBACK_RELAYS
  try {
    const r = (await loadRelayList(pk)).items.filter(i => i.write).map(i => i.url)
    return r.length ? r : FALLBACK_RELAYS
  } catch {
    return FALLBACK_RELAYS
  }
}

// ── relay streaming (relay.subscribe → relay.event/eose, relay.close) ──
// Each subscription is an AbortController keyed by nappId+subId; the napplet
// owns its lifecycle via subId. Cleared for a napp when it's uninstalled.
const nappletSubs = new Map<string, AbortController>()
const nappletSubKey = (nappId: string, subId: string) => `${nappId}\u0000${subId}`

async function nappletRelaySubscribe(nappId: string, data: any, post: (msg: object) => void) {
  const subId = String(data?.subId ?? "")
  if (!subId) return
  const filters: any[] = Array.isArray(data?.filters) ? data.filters : []
  const key = nappletSubKey(nappId, subId)
  nappletSubs.get(key)?.abort() // replace an existing sub with the same id
  const controller = new AbortController()
  nappletSubs.set(key, controller)
  const relays = data?.relay ? [String(data.relay)] : await nappletReadRelays(getPubkey())
  let eosed = false
  const clean = filters.map(f => sanitizeFilter(f)).filter(Boolean) as any[]
  if (clean.length === 0) {
    post({ type: "relay.eose", subId })
    return
  }
  for (const filter of clean) {
    pool.subscribeMany(relays, filter, {
      label: `napplet-${nappId.slice(0, 8)}-${subId}`,
      abort: controller.signal,
      onevent(event: NostrEvent) {
        if (controller.signal.aborted) return
        post({ type: "relay.event", subId, result: { event } })
      },
      oneose() {
        if (!eosed && !controller.signal.aborted) {
          eosed = true
          post({ type: "relay.eose", subId })
        }
      }
    })
  }
}

// Live outbox subscription: outbox-route the filters, then stream matching
// events as outbox.event. Same AbortController lifecycle as relay.subscribe,
// keyed by nappId+subId; the outbox wire has no eose, only event/closed.
async function nappletOutboxSubscribe(nappId: string, data: any, post: (msg: object) => void) {
  const subId = String(data?.subId ?? "")
  if (!subId) return
  const key = nappletSubKey(nappId, subId)
  nappletSubs.get(key)?.abort()
  const controller = new AbortController()
  nappletSubs.set(key, controller)

  const clean = (Array.isArray(data?.filters) ? data.filters : [data?.filters])
    .map((f: any) => sanitizeFilter(f))
    .filter(Boolean) as any[]
  if (clean.length === 0) {
    post({ type: "outbox.closed", subId, reason: "empty filter" })
    nappletSubs.delete(key)
    return
  }
  const opts = data?.options ?? {}
  const hints = Array.isArray(opts?.relays)
    ? opts.relays.filter((u: any) => typeof u === "string" && u)
    : []
  const authors = [
    ...new Set([
      ...(Array.isArray(opts?.authors) ? opts.authors.filter(isHex64) : []),
      ...authorsFromFilters(clean)
    ])
  ]
  const emit = (event: NostrEvent) => {
    if (!controller.signal.aborted) post({ type: "outbox.event", subId, result: { event } })
  }
  try {
    const maps = authors.length
      ? await outboxFilterRelayBatch(
          authors,
          clean.map(({ authors: _drop, ...rest }) => rest),
          { fallbackRelays: [...hints, ...FALLBACK_RELAYS] }
        )
      : []
    if (controller.signal.aborted) return
    const label = `napplet-outbox-${nappId.slice(0, 8)}-${subId}`
    if (maps.length) {
      pool.subscribeMap(maps, { label, abort: controller.signal, onevent: emit })
    } else {
      const relays = [...hints, ...FALLBACK_RELAYS]
      for (const filter of clean)
        pool.subscribeMany(relays, filter, { label, abort: controller.signal, onevent: emit })
    }
  } catch (err: any) {
    post({ type: "outbox.closed", subId, reason: err?.message ?? String(err) })
    nappletSubs.delete(key)
  }
}

function nappletOutboxClose(nappId: string, subId: unknown, post: (msg: object) => void) {
  const key = nappletSubKey(nappId, String(subId ?? ""))
  const controller = nappletSubs.get(key)
  if (controller) {
    controller.abort()
    nappletSubs.delete(key)
  }
  post({ type: "outbox.closed", subId: String(subId ?? "") })
}

function nappletRelayClose(nappId: string, subId: unknown, post: (msg: object) => void) {
  const key = nappletSubKey(nappId, String(subId ?? ""))
  const controller = nappletSubs.get(key)
  if (controller) {
    controller.abort()
    nappletSubs.delete(key)
  }
  post({ type: "relay.closed", subId: String(subId ?? "") })
}

// Abort every live subscription of a napp (called on uninstall/reset).
export function closeNappletSubs(nappId: string) {
  const prefix = `${nappId}\u0000`
  for (const [key, controller] of nappletSubs) {
    if (key.startsWith(prefix)) {
      controller.abort()
      nappletSubs.delete(key)
    }
  }
  for (const [iframe, sub] of incSubs) if (sub.nappId === nappId) incSubs.delete(iframe)
  for (const [iframe, id] of configSubs) if (id === nappId) configSubs.delete(iframe)
}

// ── config subscribers (per-iframe) ── the settings dialog saves, then this
// pushes the fresh values to every open window of that napp.
const configSubs = new Map<HTMLIFrameElement, string>() // iframe → nappId

export function pushNappletConfig(nappId: string) {
  const values = effectiveConfigValues(nappId)
  for (const [iframe, id] of configSubs) {
    if (!iframe.isConnected) {
      configSubs.delete(iframe)
      continue
    }
    if (id !== nappId || !nappletDomainsFor(nappId).includes("config")) continue
    iframe.contentWindow?.postMessage({ type: "config.values", values }, iframeTargetOrigin(iframe))
  }
}

// ── inc (NAP-INC: in-session topic bus between open napplet windows; nothing
// leaves the page) ── subscriptions live per-iframe; emit fans out to every
// OTHER subscribed window whose napp still holds the inc grant. Dead iframes
// are pruned lazily.
const incSubs = new Map<HTMLIFrameElement, { nappId: string; topics: Set<string> }>()

function incSubscribe(iframe: HTMLIFrameElement, nappId: string, topic: string) {
  let sub = incSubs.get(iframe)
  if (!sub) incSubs.set(iframe, (sub = { nappId, topics: new Set() }))
  sub.topics.add(topic)
}

function incUnsubscribe(iframe: HTMLIFrameElement, topic: string) {
  const sub = incSubs.get(iframe)
  if (!sub) return
  sub.topics.delete(topic)
  if (sub.topics.size === 0) incSubs.delete(iframe)
}

function incEmit(sender: HTMLIFrameElement, senderNappId: string, data: any) {
  const topic = String(data?.topic ?? "")
  if (!topic) return
  for (const [iframe, sub] of incSubs) {
    if (!iframe.isConnected) {
      incSubs.delete(iframe)
      continue
    }
    if (iframe === sender || !sub.topics.has(topic)) continue
    if (!nappletDomainsFor(sub.nappId).includes("inc")) continue
    iframe.contentWindow?.postMessage(
      {
        type: "inc.event",
        topic,
        sender: senderNappId,
        ...("payload" in (data ?? {}) ? { payload: data.payload } : {})
      },
      iframeTargetOrigin(iframe)
    )
  }
}

// Service one inbound napplet message. No handshake, no session: availability
// is presence (the shell injected only granted domains), so here we re-check
// the grant as defense-in-depth and answer with the exact result shape. An
// ungranted or unknown domain is SILENTLY IGNORED — per NIP-5D, unrecognized
// messages get no reply, which also prevents capability probing.
function handleNapplet(
  data: { type: string; id?: string; subId?: string },
  iframe: HTMLIFrameElement,
  origin: string,
  nappId: string
) {
  const domain = data.type.split(".")[0]
  if (!nappletDomainsFor(nappId).includes(domain)) return
  const post = (msg: object) => iframe.contentWindow?.postMessage(msg, origin)

  // Streaming ops have no single .result — they push by subId.
  if (data.type === "relay.subscribe") return void nappletRelaySubscribe(nappId, data, post)
  if (data.type === "relay.close") return nappletRelayClose(nappId, data.subId, post)
  if (data.type === "outbox.subscribe") return void nappletOutboxSubscribe(nappId, data, post)
  if (data.type === "outbox.close") return nappletOutboxClose(nappId, data.subId, post)

  // inc rides the bus, not dispatch: emit/unsubscribe are fire-and-forget.
  if (data.type === "inc.emit") return incEmit(iframe, nappId, data)
  if (data.type === "inc.subscribe") {
    const topic = String((data as any).topic ?? "")
    if (topic) incSubscribe(iframe, nappId, topic)
    return post({
      type: "inc.subscribe.result",
      id: data.id,
      ...(topic ? {} : { error: "missing topic" })
    })
  }
  if (data.type === "inc.unsubscribe")
    return incUnsubscribe(iframe, String((data as any).topic ?? ""))

  // config.subscribe answers with an immediate snapshot; openSettings is a UI
  // request, answered only by a schemaError when there's nothing to render.
  if (data.type === "config.subscribe") {
    configSubs.set(iframe, nappId)
    return post({ type: "config.values", values: effectiveConfigValues(nappId) })
  }
  if (data.type === "config.unsubscribe") return void configSubs.delete(iframe)
  if (data.type === "config.openSettings") {
    if (!getNappletConfig(nappId).schema) {
      return post({ type: "config.schemaError", code: "no-schema", error: "no schema registered" })
    }
    const app = getInstalledApp(nappId)
    void openNappConfigSettings(nappId, {
      title: app?.petname || app?.title || nappId,
      section: typeof (data as any).section === "string" ? (data as any).section : undefined
    })
    return
  }

  dispatchNapplet(data.type, data, nappId)
    .then(result => post({ ...result, id: data.id }))
    .catch(err =>
      post({ type: `${data.type}.result`, id: data.id, error: err?.message ?? String(err) })
    )
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
      minimized: !!st.status.minimized,
      root: win.root
    })
  }
  // Order by stage DOM position so the taskbar matches the stage / open / mobile
  // order — reordering either the taskbar or the stage keeps them in sync.
  out.sort((a, b) =>
    a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )
  return out.map(({ root, ...rest }) => rest)
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
// Swap every open window of a napplet onto freshly verified bytes (after an
// update). A srcdoc document is baked at launch, so a plain reload would just
// re-run the old bytes; reassigning srcdoc reloads with the new ones.
export function reloadNappletWindows(nappId: string, html: string): number {
  let count = 0
  const doc = buildNappletDoc(html, nappletDomainsFor(nappId))
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId && win.iframe) {
      resetInstanceRuntimeState(win.root.dataset.instanceId || "")
      win.iframe.srcdoc = doc
      count++
    }
  }
  return count
}

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
  captureWindowGeom(win.root)
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
      // NIP-5D dialect (window.napplet) carries `type`; legacy carries
      // `__nostrapps`. Same channel, two routers.
      if (typeof (data as any).type === "string" && !data.__nostrapps) {
        handleNapplet(data as any, iframe, origin, nappId)
        return
      }
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
        case "napp-link": {
          // Same gate as the napplet link domain: validate, prompt, noopener.
          void linkOpen(nappId, { url: data.url })
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
  captureWindowGeom(win.root)
  return win
}

// ─── NIP-5D napplet loader (kind 35129 — separate from the nsite path) ──
// A napplet is a single verified index.html run in an opaque-origin
// (allow-scripts only) srcdoc iframe with no service worker and no window.nostr.
// The spec's conservative baseline: sealed to itself, every resource/socket via
// a NAP domain over postMessage (not CSP-governed).
const NAPPLET_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; " +
  "child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; " +
  "manifest-src 'none'; base-uri 'none'; form-action 'none'"

// Wrap the verified bytes with the runtime injection — CSP meta FIRST in <head>,
// then the granted-domain declaration, then the napplet bridge. All of this is
// outside the bytes that were hashed (per NIP-5D), so it doesn't affect identity.
function buildNappletDoc(html: string, domains: string[]): string {
  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${NAPPLET_CSP}">` +
    `<script>window.__nappletDomains=${JSON.stringify(domains).replace(/</g, "\\u003c")}</script>` +
    `<script>${nappletBridgeSource}</script>`
  const headMatch = html.match(/<head[^>]*>/i)
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length
    return html.slice(0, idx) + inject + html.slice(idx)
  }
  return `<!doctype html><head>${inject}</head>${html}`
}

// Load a resolved+verified napplet into a window. nappId must already be a
// stored InstalledApp (so nappletDomainsFor sees its requires) with a policy.
export function launchNapplet(
  stageEl: HTMLElement,
  nappId: string,
  html: string,
  opts: LaunchOpts = {}
) {
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
  const srcdoc = buildNappletDoc(html, nappletDomainsFor(nappId))
  const win = createNappWindow({
    nappId,
    instanceId,
    srcdoc,
    sourceRouting: true,
    sandbox: "allow-scripts",
    petname,
    position,
    status,
    onMessage: (data, iframe) => {
      // Napplets speak only NIP-5D; postback targets '*' (opaque origin).
      if (typeof (data as any).type === "string" && !data.__nostrapps) {
        handleNapplet(data as any, iframe, "*", nappId)
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
  ensureStageObserver(stageEl)
  clampToStage(win.root, stageEl)
  captureWindowGeom(win.root)
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
      // NIP-5D dialect — same routing as mount() above.
      if (typeof (data as any).type === "string" && !data.__nostrapps) {
        handleNapplet(data as any, iframe, origin, nappId)
        return
      }
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
        case "napp-link": {
          // Same gate as the napplet link domain: validate, prompt, noopener.
          void linkOpen(nappId, { url: data.url })
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
  captureWindowGeom(win.root)
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

// The pack/tile grid steps down with the stage width so cells never get too
// narrow. We skip ODD column counts on purpose: a 2-of-4-column window (half
// width) maps cleanly to 1-of-2, whereas 1.5-of-3 would round and leave a gap.
// So columns only halve: 4 → 2. Below ~760px inner the windows switch to the
// mobile flow layout (CSS @media), which is what a 1-column grid would be — no
// point maintaining both.
function gridForWidth(innerW: number): { cols: number; rows: number } {
  if (innerW >= 1080) return { cols: 4, rows: 3 }
  return { cols: 2, rows: 2 }
}
// Grid the windows were last packed at — the resize observer re-packs only when
// a width change steps to a DIFFERENT grid; within a band it rescales smoothly.
let lastPackGrid: { cols: number; rows: number } = { cols: 0, rows: 0 }

// Remembered pack layout per grid config, so narrowing then widening returns to
// the SAME layout instead of re-deriving from pixels (at 1×1 every window is
// full-width, which would otherwise read as full-width at every wider grid).
// Keyed "<cols>x<rows>" → instanceId → cell. A snapshot is reused when its grid
// is revisited only if it still covers the current window set; otherwise we
// re-pack and overwrite it (which also handles windows opening/closing).
const packLayouts = new Map<string, Map<string, PackCell>>()

function gridKey(g: { cols: number; rows: number }) {
  return `${g.cols}x${g.rows}`
}

function isPackable(root: HTMLElement): boolean {
  return (
    root.isConnected &&
    !root.classList.contains("space-inactive") &&
    !root.classList.contains("minimized") &&
    !root.classList.contains("maximized") &&
    getComputedStyle(root).position !== "static"
  )
}

// Snapshot each packable window's current cell, keyed by instanceId.
function snapshotCells(stageEl: HTMLElement): Map<string, PackCell> {
  const out = new Map<string, PackCell>()
  for (const [root, cell] of capturePackSnapshot(stageEl) as Map<HTMLElement, PackCell>) {
    const id = root.dataset.instanceId
    if (id) out.set(id, cell)
  }
  return out
}

// Does a stored layout include every packable window currently on the stage?
function packLayoutCovers(snap: Map<string, PackCell>): boolean {
  let n = 0
  for (const w of openWindows.values()) {
    if (!isPackable(w.root)) continue
    n++
    const id = w.root.dataset.instanceId
    if (!id || !snap.has(id)) return false
  }
  return n > 0
}

// Re-apply a stored layout. Cells are grid-relative; pixels follow the current
// cell size, so the layout scales to whatever width we're at within this grid.
function applyPackLayout(stageEl: HTMLElement, snap: Map<string, PackCell>) {
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return
  const { cols: COLS, rows: ROWS } = gridForWidth(innerW)
  const cellW = innerW / COLS
  const cellH = innerH / ROWS
  for (const w of openWindows.values()) {
    if (!isPackable(w.root)) continue
    const cell = w.root.dataset.instanceId ? snap.get(w.root.dataset.instanceId) : undefined
    if (cell) applyCellRect(w, cell.col, cell.row, cell.cols, cell.rows, padL, padT, cellW, cellH)
  }
}

// Drop all remembered layouts. Called when the user makes a real geometry edit
// (drag/resize) — that invalidates the OTHER grids' snapshots; the grid being
// edited is re-recorded by the re-pack that follows the edit.
export function invalidatePackLayouts() {
  packLayouts.clear()
}

// Snapshot every visible window's current cell. Used at drag start so the
// live-pack can default to the pre-drag layout: as long as the dragged
// window isn't blocking a window's original cell, that window returns to
// where it started. This lets the user "undo" mid-drag by moving back.
export function capturePackSnapshot(stageEl: HTMLElement) {
  if (!stageEl) return new Map()
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return new Map()
  const { cols: COLS, rows: ROWS } = gridForWidth(innerW)
  const cellW = innerW / COLS
  const cellH = innerH / ROWS
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
  const { cols: COLS, rows: ROWS } = gridForWidth(innerW)
  const cellW = innerW / COLS
  const cellH = innerH / ROWS
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
  snapshot: Map<HTMLElement, PackCell> | null = null,
  resize: boolean | "h" | "v" = false
) {
  if (!stageEl) return
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return

  const { cols: COLS, rows: ROWS } = gridForWidth(innerW)
  // Grid stepped since the last pack (e.g. 4×3 → 2×2)? Then each window's
  // pixel-derived cell is stale and doesn't translate to the new grid, so we
  // pack compactly in reading order instead of honoring those cells (which
  // would leave gaps and open needless new rows).
  const gridChanged = COLS !== lastPackGrid.cols || ROWS !== lastPackGrid.rows
  lastPackGrid = { cols: COLS, rows: ROWS }
  const cellW = innerW / COLS
  const cellH = innerH / ROWS

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

  // On a grid step, order items top-left → bottom-right so compaction fills the
  // grid in reading order (a window that was top-left stays top-left, etc.).
  if (gridChanged) {
    items.sort((a, b) => {
      const ca = cellFromPx(a)
      const cb = cellFromPx(b)
      return ca.row - cb.row || ca.col - cb.col
    })
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
    if (!isNew && !gridChanged) {
      // 1. Try the exact desired cell.
      if (fits(desired.col, desired.row, desired.cols, desired.rows)) {
        placed = {
          col: desired.col,
          row: desired.row,
          cols: desired.cols,
          rows: desired.rows
        }
      }
      if (resize) {
        // Resize: a neighbor the resized window overlaps always yields by
        // SHRINKING — carve the focus footprint out of it (largest sub-rect
        // that clears the focus) rather than displacing it. No size rules. Only
        // when nothing is left (the resize swallowed its whole cell — e.g. its
        // width would drop below one column) does it fall through to relocation.
        if (!placed && focusCell && overlaps(desired, focusCell)) {
          placed = shrinkAroundFocus(
            desired,
            focusCell,
            fits,
            typeof resize === "string" ? resize : undefined
          )
        }
      } else {
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
    }
    // 3. Last resort. New windows AND grid-step repacks use top-left first-fit
    //    (earliest gap) so the grid fills compactly with no stray rows. A
    //    displaced EXISTING window (same grid) instead takes the free cell
    //    NEAREST its desired spot, so it shifts locally into a nearby gap rather
    //    than teleporting to the top-left — which can grab a not-yet-placed
    //    window's cell and cascade a third window.
    if (!placed && (isNew || gridChanged)) {
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

  // Remember this layout so revisiting the grid restores it (instead of guessing
  // from pixels). Read-back via the same px the layout just wrote.
  packLayouts.set(gridKey({ cols: COLS, rows: ROWS }), snapshotCells(stageEl))
}

// Find a window arriving from another space a spot of its own. The coordinates
// it brings describe the layout it just left, so reusing them drops it on top of
// whatever already occupies those pixels here. Scan the pack grid in reading
// order and take the first position where the window's current size clears every
// other window in this space, growing downward past them if it has to (the stage
// scrolls). Only the arriving window moves — in a freeform space the arrangement
// is the user's. Packed spaces don't need this: markPackNew + bestFitPack slots
// the window in there.
export function placeInFreeSpot(stageEl: HTMLElement, instanceId: string) {
  const win = openWindows.get(instanceId)
  if (!stageEl || !win || !isPackable(win.root)) return
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl)
  if (innerW <= 0 || innerH <= 0) return

  const { cols: COLS, rows: ROWS } = gridForWidth(innerW)
  const cellW = innerW / COLS
  const cellH = innerH / ROWS
  const w = win.root.offsetWidth
  const h = win.root.offsetHeight

  const obstacles = Array.from(openWindows.values())
    .filter(o => o !== win && isPackable(o.root))
    .map(o => {
      const left = parseFloat(o.root.style.left) || padL
      const top = parseFloat(o.root.style.top) || padT
      return { left, top, right: left + o.root.offsetWidth, bottom: top + o.root.offsetHeight }
    })

  const clears = (left: number, top: number) =>
    obstacles.every(
      o =>
        left + w + TILE_GAP <= o.left ||
        left >= o.right + TILE_GAP ||
        top + h + TILE_GAP <= o.top ||
        top >= o.bottom + TILE_GAP
    )

  // One row past the lowest window is always clear, so the scan is bounded.
  const lowest = obstacles.reduce((m, o) => Math.max(m, o.bottom), padT)
  const maxRow = Math.ceil((lowest - padT) / cellH) + 1

  let spot: { left: number; top: number } | null = null
  for (let row = 0; row <= maxRow && !spot; row++) {
    for (let col = 0; col < COLS; col++) {
      const left = Math.round(padL + col * cellW)
      const top = Math.round(padT + row * cellH)
      if (left + w > padL + innerW + 1) break // wider than the columns left of here
      if (!clears(left, top)) continue
      spot = { left, top }
      break
    }
  }
  // Wider than the whole stage, so no column start ever clears: park it below.
  if (!spot) spot = { left: Math.round(padL), top: Math.round(lowest + TILE_GAP) }

  const left = `${spot.left}px`
  const top = `${spot.top}px`
  if (win.root.style.left === left && win.root.style.top === top) return
  win.root.style.left = left
  win.root.style.top = top
  win.notifyState?.() // persist the new position
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
  fits: (col: number, row: number, cols: number, rows: number) => boolean,
  axis?: "h" | "v"
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

  // Filter to ones that actually fit.
  const valid = candidates.filter(
    c => c.cols > 0 && c.rows > 0 && fits(c.col, c.row, c.cols, c.rows)
  )
  if (valid.length === 0) return null
  // Prefer subtracting along the resize axis: a horizontal resize keeps the
  // full-height sliver beside the focus (rows === desired.rows), a vertical one
  // keeps the full-width sliver (cols === desired.cols). Then by most cells.
  // Without the axis bias an equal-area tie (e.g. a 1×3 right sliver vs a 3×1
  // below sliver) picks the wrong shape — the neighbor flips to a flat strip.
  const onAxis = (c: PackCell) =>
    axis === "h" ? c.rows === desired.rows : axis === "v" ? c.cols === desired.cols : false
  valid.sort((a, b) => {
    const aa = onAxis(a)
    const ba = onAxis(b)
    if (aa !== ba) return aa ? -1 : 1
    return b.cols * b.rows - a.cols * a.rows
  })
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

  // Grid dimensions step down with the stage width (4×3 → 3×3 → 2×2 → 1×1),
  // then grow rows so we always have enough cells (one per window minimum).
  const { cols, rows: baseRows } = gridForWidth(innerW)
  const rows = Math.max(baseRows, Math.ceil(n / cols))
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

// ─── viewport-relative geometry (recompose on resize) ──────────────────
// A window's geometry is kept as a REFERENCE pixel rect plus the stage inner
// size it was set against. On stage resize we re-derive pixels proportionally
// from that reference, so windows reposition AND resize with the viewport
// instead of keeping fixed pixels (which clip on a smaller stage).
//
// The reference is the source of truth: captured at every geometry COMMIT (via
// the window's notifyState) and never re-read from a render, so it survives any
// number of resizes without drift. Windows scale fully (no size floor) so they
// keep their relative layout and never overlap a neighbour on a smaller stage.
type GeomRef = {
  left: number
  top: number
  width: number
  height?: number
  innerW: number
  innerH: number
}
const windowGeomRef = new WeakMap<HTMLElement, GeomRef>()

export function captureWindowGeom(root: HTMLElement) {
  const stage = root.parentElement
  // Mobile (static flow) and detached windows have no meaningful pixel geometry.
  if (!stage || getComputedStyle(root).position === "static") return
  const { width: iw, height: ih } = getStageBounds(stage)
  if (iw <= 0 || ih <= 0) return
  const h = parseFloat(root.style.height)
  windowGeomRef.set(root, {
    left: parseFloat(root.style.left) || 0,
    top: parseFloat(root.style.top) || 0,
    // Prefer the inline width (the intended size) over offsetWidth, which a
    // maximized window reports as the CSS-inset full size.
    width: parseFloat(root.style.width) || root.offsetWidth || 0,
    height: Number.isFinite(h) && h > 0 ? h : undefined,
    innerW: iw,
    innerH: ih
  })
}

export function rescaleWindowGeom(root: HTMLElement) {
  const stage = root.parentElement
  if (!stage || getComputedStyle(root).position === "static") return
  const ref = windowGeomRef.get(root)
  if (!ref) {
    captureWindowGeom(root) // first sight: nothing to scale from yet
    return
  }
  const { width: iw, height: ih, padL, padT } = getStageBounds(stage)
  if (iw <= 0 || ih <= 0 || ref.innerW <= 0 || ref.innerH <= 0) return
  const sx = iw / ref.innerW
  const sy = ih / ref.innerH
  root.style.left = `${Math.round(padL + (ref.left - padL) * sx)}px`
  root.style.top = `${Math.round(padT + (ref.top - padT) * sy)}px`
  root.style.width = `${Math.round(ref.width * sx)}px`
  // Scale the 240px min-width floor with the recompose. Otherwise a window whose
  // scaled width drops under that floor stops shrinking while its left keeps
  // sliding inward, so neighbors overlap. A small absolute backstop keeps them
  // from getting absurdly tiny; clear the override once we're back at/above the
  // reference size so the CSS floor (240) takes over again.
  root.style.minWidth = sx >= 1 ? "" : `${Math.round(Math.max(120, 240 * sx))}px`
  if (ref.height != null) {
    root.style.height = `${Math.round(ref.height * sy)}px`
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
function measureMaxWindowBottom(_stage: HTMLElement): number {
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
function clampToStage(root: HTMLElement, stage: HTMLElement, opts: { pullIn?: boolean } = {}) {
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
  // pullIn (default) drags an out-of-bounds window back inside — wanted when a
  // window is first placed. On RESIZE we don't pull in: that would nudge
  // right/bottom-edge windows inward on every shrink and they'd never return
  // ("windows lose their place"). There we only keep them from going above/left
  // of the padding; an off-screen-right window reappears as the stage grows.
  const pullIn = opts.pullIn !== false
  // Always leave at least this much of the window inside the stage so the
  // user can grab the header. Header height ≈ 28px on desktop, 40px on mobile.
  const minVisibleX = Math.min(80, width)
  const minLeft = padL
  const minTop = padT
  const maxLeft = Math.max(minLeft, W - padR - minVisibleX)
  const newLeft = pullIn ? Math.max(minLeft, Math.min(maxLeft, left)) : Math.max(minLeft, left)
  // The stage scrolls vertically (overflow-y: auto), so a window below the fold
  // is still reachable by scrolling — clamping its top into the viewport would
  // yank packed below-the-fold windows up onto the one above. Only clamp the top
  // DOWN-ward when the stage can't scroll vertically. (Horizontal always clamps:
  // overflow-x is hidden.)
  const scrollsY = /(auto|scroll)/.test(getComputedStyle(stage).overflowY)
  const maxTop = Math.max(minTop, H - padB - 28)
  const newTop =
    scrollsY || !pullIn ? Math.max(minTop, top) : Math.max(minTop, Math.min(maxTop, top))
  if (newLeft !== left) root.style.left = `${newLeft}px`
  if (newTop !== top) root.style.top = `${newTop}px`
}

// Restore mounts windows one by one, and the stage's bounds only settle once
// the last one is in (scrollbar, bar heights). Rescaling against those
// transient bounds is how windows shrank a little on every reload — while
// settling, the observer only re-baselines the geometry refs; the release
// re-captures them once against the final bounds.
let stageSettling = false
export function setStageSettling(on: boolean) {
  stageSettling = on
  if (!on) for (const win of openWindows.values()) captureWindowGeom(win.root)
}

let stageObserver: ResizeObserver | null = null
function ensureStageObserver(stageEl: HTMLElement) {
  if (stageObserver) return
  stageObserver = new ResizeObserver(() => {
    if (stageSettling) {
      for (const win of openWindows.values()) captureWindowGeom(win.root)
      setStageBottomSpacer(stageEl, measureMaxWindowBottom(stageEl))
      return
    }
    const grid = gridForWidth(getStageBounds(stageEl).width)
    const stepped = grid.cols !== lastPackGrid.cols || grid.rows !== lastPackGrid.rows
    if (stageEl.classList.contains("pack-mode") && stepped) {
      // The grid changed band (e.g. 4×3 → 3×3). If we've laid windows out at
      // this grid before, restore that exact layout; otherwise pack fresh.
      const snap = packLayouts.get(gridKey(grid))
      if (snap && packLayoutCovers(snap)) {
        applyPackLayout(stageEl, snap)
        lastPackGrid = grid
      } else {
        bestFitPack(stageEl)
      }
    } else {
      for (const win of openWindows.values()) {
        // Skip hidden (other-space) windows: they report zero size, so rescaling
        // would mis-place them before they're shown again.
        if (win.root.classList.contains("space-inactive")) continue
        // Recompose proportionally with the new stage size (reposition + resize).
        rescaleWindowGeom(win.root)
      }
    }
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
  label: string,
  // The versioned stored record (domains + v) — written verbatim to /__policy__.
  policy?: { domains: string[]; v?: number }
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
    // Ship the granted policy alongside the files so the SW's CSP is correct on
    // the napp's very first load (no unlocked window before the grant applies).
    boot.contentWindow!.postMessage({ __nostrapps: "napp-install", files, policy }, origin)

    const result = await waitForMessage(origin, "napp-install-done", "napp-install-error")
    if (result.__nostrapps === "napp-install-error") {
      throw new Error(result.error)
    }
  } finally {
    boot.remove()
  }
}

// Write a new policy for an already-installed napp and reload its open windows
// so the SW re-serves their documents under the updated CSP. Spins up a
// transient boot iframe (same channel as install) to write the record into the
// napp-origin IDB, which the launcher can't touch directly (cross-origin).
export async function applyNappPolicy(origin: string, nappId: string) {
  const boot = document.createElement("iframe")
  boot.src = `${origin}/boot.html`
  boot.style.display = "none"
  document.body.appendChild(boot)
  try {
    const ready = await waitForMessage(origin, "napp-boot-ready", "napp-boot-error")
    if (ready.__nostrapps === "napp-boot-error") throw new Error(ready.error)
    // Ship the versioned stored record so the SW honors the exact grant.
    boot.contentWindow!.postMessage(
      { __nostrapps: "napp-set-policy", policy: getStoredPolicy(nappId) },
      origin
    )
    const result = await waitForMessage(origin, "napp-set-policy-done", "napp-set-policy-error")
    if (result.__nostrapps === "napp-set-policy-error") throw new Error(result.error)
  } finally {
    boot.remove()
  }
  // Reload every open window of this napp so the new CSP takes effect now.
  for (const [, win] of openWindows) {
    if (win.root?.dataset.nappId === nappId) win.reload?.()
  }
}

// ─── Dev apps ───────────────────────────────────────────

const devHandles = new Map<string, FileSystemDirectoryHandle>()
const devUrls = new Map<string, string>()
const tempFiles = new Map<string, Map<string, NsiteFile>>()
const devBootIframes = new Map<string, HTMLIFrameElement>()

export function setDevHandle(nappId: string, handle: FileSystemDirectoryHandle) {
  devHandles.set(nappId, handle)
}

export function setDevUrl(nappId: string, baseUrl: string) {
  devUrls.set(nappId, baseUrl)
}

export function setTempFiles(nappId: string, files: NsiteFile[]) {
  tempFiles.set(
    nappId,
    new Map(files.map(file => [file.path.startsWith("/") ? file.path : `/${file.path}`, file]))
  )
}

export function removeDevHandle(nappId: string) {
  devHandles.delete(nappId)
  devUrls.delete(nappId)
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

export function getDevUrl(nappId: string): string | null {
  return devUrls.get(nappId) || null
}

export async function bootDevApp(
  origin: string,
  nappId: string,
  onProgress: (msg: string) => void,
  label: string
) {
  console.debug("[sandbox] bootDevApp", { origin, label })
  // Every ephemeral napp (both /dev flavours and both temp~ paths) boots through
  // here. Note the id BEFORE anything touches the origin: if the boot dies
  // half-way, having registered a service worker, that origin still has to be
  // reachable for the wipe.
  rememberEphemeralOrigin(nappId)
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

  // The dev SW asks for /__policy__ the same way it asks for a file; answer it
  // from the policy store (dev apps have no IDB record to read).
  if (path === "/__policy__") {
    ;(event.source as Window)?.postMessage(
      {
        __nostrapps: "napp-dev-file-result",
        requestId,
        body: JSON.stringify(getPolicy(nappId)),
        mime: "application/json"
      },
      "*"
    )
    return
  }

  const dirHandle = devHandles.get(nappId)
  const devUrl = devUrls.get(nappId)
  const tempAppFiles = tempFiles.get(nappId)

  if (!dirHandle && !devUrl && !tempAppFiles) {
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

    if (devUrl) {
      const rel = path.replace(/^\//, "")
      const target = new URL(rel, devUrl).toString()
      const res = await fetch(target)
      if (!res.ok) throw new Error(`Fetch ${target} failed: ${res.status}`)
      const body = await res.arrayBuffer()
      ;(event.source as Window)?.postMessage(
        {
          __nostrapps: "napp-dev-file-result",
          requestId,
          body,
          mime: res.headers.get("content-type") || "application/octet-stream"
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

// The NIP-07 signer surface (window.nostr) — gated on the `identity` grant.
const SIGNER_METHODS = new Set([
  "getPublicKey",
  "signEvent",
  "nip04.encrypt",
  "nip04.decrypt",
  "nip44.encrypt",
  "nip44.decrypt"
])

async function handleRpc(
  data: Extract<MessageData, { __nostrapps: "rpc" }>,
  iframe: HTMLIFrameElement,
  signer: Signer | SignerGetter,
  nappId: string
) {
  const { id, method, params, instanceId } = data
  try {
    // Signer access (NIP-07 / window.nostr) requires the granted `identity`
    // capability. The bridge pins window.nostr to undefined when it's ungranted,
    // but a site could postMessage this rpc directly, so enforce it here too —
    // this is the real boundary.
    if (SIGNER_METHODS.has(method!) && !getPolicy(nappId).domains.includes("identity")) {
      throw new Error(`identity access not granted: ${method!}`)
    }
    if (isGated(method!)) {
      const detail =
        method === "napp.saveFile"
          ? describeSaveFile(params)
          : method === "napp.copyText"
            ? describeCopyText(params)
            : undefined
      const allowed = await requireApproval(nappId, method!, detail)
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
          events: await safeQueryEvents(filter),
          synced: synced.every(v => v)
        },
        "*"
      )
  }, 800)
  notify()

  const onSync = (pubkey?: string) => {
    if (!pubkey) return
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
      // Live streaming is opt-in now — a feed being open is the request.
      // (Idempotent: the manager skips authors/kinds already subscribed.)
      void goLive({ authors, kinds })
      try {
        await outbox.sync(authors, kinds, { signal: controller.signal })
        // The sync writes into the store from inside the gadgets package,
        // past any ingest hook — re-apply stored deletions so a tombstoned
        // event a lagging relay just re-delivered does not reach the next
        // callback.
        await sweepStoredDeletions()
      } catch (err) {
        // A failed sync must not skip the heal below — a flaky sync is one
        // of the ways events go missing in the first place.
        if (!controller.signal.aborted) console.warn("sync failed", err)
      }
      notify()
      // Outbox-bounds poisoning heal. gadgets' sync stamps EVERY requested
      // kind as caught-up-to-now after any non-empty round — including kinds
      // it fetched nothing for (outbox.ts sync(), the bounds-update loop).
      // Once stamped, later syncs skip (2h window) or use since≈stamp-time,
      // so a replaceable event older than the stamp that the local store
      // doesn't hold becomes permanently unreachable: publishing a first
      // kind 10007 was enough to lock a user's older 10002 out of the
      // relays napp. Until fixed upstream, any replaceable/addressable kind
      // still absent from the store after sync gets one direct boundless
      // query on the author's write relays. Single-author feeds only — the
      // per-author fan-out would turn following-feeds into a REQ storm.
      if (authors.length === 1 && !controller.signal.aborted) {
        const author = authors[0]
        const missing: number[] = []
        for (const kind of kinds) {
          if (!isReplaceableKind(kind) && !isAddressableKind(kind)) continue
          const have = await store.queryEvents({ authors: [author], kinds: [kind] }, 1)
          if (have.length === 0) missing.push(kind)
        }
        if (missing.length) {
          try {
            // Write relays when resolvable, but never ONLY them: when the
            // missing kind is the 10002 itself, the relay list may be
            // exactly what we can't resolve — the indexers the launcher
            // broadcasts 10002 to on publish are the reliable source then.
            const relays = new Set<string>(FALLBACK_RELAYS)
            try {
              for (const r of (await loadRelayList(author)).items) {
                if (r.write) relays.add(r.url)
              }
            } catch {}
            if (missing.includes(10002)) {
              relays.add("wss://purplepag.es")
              relays.add("wss://indexer.coracle.social")
              relays.add("wss://user.kindpag.es")
              relays.add("wss://relay.nos.social")
            }
            const targets = [...relays].slice(0, 10)
            const healed = await pool.querySync(
              targets,
              { kinds: missing, authors: [author], limit: missing.length * 4 },
              { label: "bounds-heal", maxWait: 4000 }
            )
            console.debug(
              ":: bounds-heal", author.slice(0, 8),
              "missing", missing, "asked", targets, "got", healed.length, healed
            )
            for (const event of healed) await store.saveEvent(event)
            if (healed.length) notify()
          } catch (err) {
            console.warn(":: bounds-heal failed", err)
          }
        }
      }
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
          events: await safeQueryEvents(filter),
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
        if (await tombstoned(event)) return
        const isNew = await store.saveEvent(event)
        if (isNew) {
          await applyDeletionLocally(event)
          notify()
        }
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

function resolvePubkey(user: string): string {
  if (typeof user !== "string") return user
  if (user.startsWith("npub1") || user.startsWith("nprofile1")) {
    const { type, data } = decode(user)
    if (type === "npub") return data as string
    if (type === "nprofile") return (data as { pubkey: string }).pubkey
  }
  return user
}

// A 64-char hex string (event id / pubkey). Anything reaching the redstore wasm
// as an id/author MUST match this: a malformed value panics query_events, and
// its no_threads mutex stays locked afterward, poisoning the shared store for
// the whole session ("cannot recursively acquire mutex" on every later call).
const HEX64 = /^[0-9a-f]{64}$/i
const isHex64 = (s: unknown): s is string => typeof s === "string" && HEX64.test(s)

// Strip non-hex ids/authors from a napp-supplied filter before it hits the
// store (handles a single filter or an array of them). A filter whose only
// id/author constraint is emptied by this is dropped, so it can't silently
// widen into a match-everything query.
function sanitizeFilter(filter: any): any | null {
  if (Array.isArray(filter)) {
    const arr = filter.map(sanitizeFilter).filter(Boolean)
    return arr.length ? arr : null
  }
  if (!filter || typeof filter !== "object") return null
  const g: any = { ...filter }
  if (Array.isArray(g.ids)) {
    g.ids = g.ids.filter(isHex64)
    if (g.ids.length === 0) return null
  }
  if (Array.isArray(g.authors)) {
    g.authors = g.authors.filter(isHex64)
    if (g.authors.length === 0) return null
  }
  return g
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
    case "nostrdb.add": {
      const saved = await store.saveEvent(params.event)
      await applyDeletionLocally(params.event)
      return saved
    }
    case "nostrdb.query": {
      const filter = sanitizeFilter(params.filters)
      return filter ? safeQueryEvents(filter) : []
    }
    case "nostrdb.count": {
      const filter = sanitizeFilter(params.filters)
      if (!filter) return 0
      const events = await safeQueryEvents(filter, 10_000)
      return events.length
    }
    case "nostrdb.event": {
      if (!isHex64(params.id)) return undefined
      const res = await store.queryEvents({ ids: [params.id] }, 1)
      return res[0]
    }
    case "nostrdb.replaceable":
      // loadReplaceables returns [lastAttempt, event] tuples; napps are
      // promised the bare event (env.d.ts).
      const result = await getStore().loadReplaceables([
        [params.kind, params.author, params.identifier]
      ])
      return result[0][1]
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
    case "napp.loadBlockedRelays":
      return loadBlockedRelays(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadBlossomServers":
      return loadBlossomServers(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadBookmarks":
      return loadBookmarks(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadDmRelays":
      return loadDmRelays(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadEmojis":
      return loadEmojis(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadFavoriteRelays":
      return loadFavoriteRelays(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadFollowsList":
      return loadFollowsList(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadMuteList":
      return loadMuteList(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadPins":
      return loadPins(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadRelayList":
      return loadRelayList(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadSearchRelays":
      return loadSearchRelays(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadWikiAuthors":
      return loadWikiAuthors(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadWikiRelays":
      return loadWikiRelays(resolvePubkey(params), undefined, undefined, undefined)
    case "napp.loadEmojiSets":
      return loadEmojiSets(resolvePubkey(params))
    case "napp.loadFollowSets":
      return loadFollowSets(resolvePubkey(params))
    case "napp.loadRelaySets":
      return loadRelaySets(resolvePubkey(params))
    case "napp.loadRelayInfo":
      return loadRelayInfo(params)
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
    case "napp.saveFile":
      return saveFileForNapp(params)
    case "napp.copyText":
      return copyTextForNapp(params)
    case "napp.publish":
      return publishEvent(params.event, params.relays)
    case "napp.loadEvent":
      return loadEvent(params)
    case "napp.loadEvents":
      return loadEvents(params)
    case "napp.verifyEvent":
      // params is the event; verifyEvent checks id + signature.
      return verifyEvent(params)
    default:
      throw new Error(`unsupported method: ${method}`)
  }
}

// A napp filename is untrusted input. Keep only a basename, drop anything that
// could steer where the file lands or confuse the OS, and never let it be empty.
function sanitizeFilename(raw: unknown): string {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[:*?"<>|]/g, "")
    .replace(/^\.+/, "") // no ".." and no accidental dotfiles
    .trim()
    .slice(0, 200)
  return cleaned || "download"
}

export function describeSaveFile(params: any): string | undefined {
  const name = sanitizeFilename(params?.name)
  const size = params?.data?.size ?? params?.data?.byteLength ?? params?.data?.length
  if (typeof size !== "number") return `Save “${name}” to your downloads folder.`
  const units = ["B", "KiB", "MiB", "GiB"]
  let n = size
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  const pretty = `${u === 0 ? n : n.toFixed(1)} ${units[u]}`
  return `Save “${name}” (${pretty}) to your downloads folder.`
}

// The clipboard preview shows enough to recognise what is being copied (an
// address, a key, a url). It renders as a wrapping code block in the dialog —
// these strings have no spaces, so a plain paragraph would overflow the card.
export function describeCopyText(params: any): { text: string; code: string } {
  const text = typeof params?.text === "string" ? params.text : ""
  const oneLine = text.replace(/\s+/g, " ").trim()
  const preview = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine
  return {
    text: `Copy ${text.length} character${text.length === 1 ? "" : "s"} to your clipboard:`,
    code: preview
  }
}

// The napp sandbox has no clipboard-write delegation, so navigator.clipboard
// rejects inside the iframe with nothing the user ever sees. Napps hand the
// text here instead: this document is not sandboxed, so the write works, and
// routing it through an rpc puts it behind the permission gate with a prompt
// that shows the actual text about to land on the clipboard.
async function copyTextForNapp(params: { text?: unknown }) {
  const text = params?.text
  if (typeof text !== "string") throw new Error("copyText: text must be a string")
  // A clipboard payload is not a file transfer; cap it well below anything a
  // reference, key or url needs so a napp cannot dump megabytes there.
  if (text.length > 100_000) throw new Error("copyText: text too large")
  await navigator.clipboard.writeText(text)
  return { length: text.length }
}

// Napp iframes deliberately omit `allow-downloads`, so a napp cannot write to
// disk on its own — and a blocked download throws nothing and logs nothing the
// napp can see, so there is no way for it to even detect the refusal. Napps
// hand the bytes here instead: this document is not sandboxed, so the save
// works, and routing it through an rpc puts it behind the permission gate with
// a prompt that can name the actual file.
async function saveFileForNapp(params: {
  name?: string
  data?: Blob | ArrayBuffer | ArrayBufferView
  type?: string
}) {
  const name = sanitizeFilename(params?.name)
  const raw = params?.data
  if (!raw) throw new Error("saveFile: no data")

  // Blobs survive structured clone by reference, so a napp passing one avoids
  // copying the bytes across the frame boundary at all.
  const blob =
    raw instanceof Blob
      ? raw
      : new Blob([raw as BlobPart], { type: params?.type || "application/octet-stream" })

  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.rel = "noopener"
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Long enough for the download to be picked up, short enough not to pin
    // large blobs in memory for the session.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return { name, size: blob.size }
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
  } else if (params.code.startsWith("note1")) {
    // Bare note reference — the decoded data IS the hex event id.
    id = decode(params.code).data as string
  } else {
    id = params.code
    author = params.author
  }

  // Validate BEFORE any store/relay query. A malformed id/author (a note1 that
  // didn't decode, junk hex, …) panics redstore's wasm and — because its
  // no_threads mutex stays locked after a panic — poisons the shared store for
  // the rest of the session. Bail to null instead of querying.
  // identifier != null (not truthiness): an naddr with an empty d tag ("") is a
  // valid replaceable coordinate, so "" must still take the replaceable path.
  if (identifier != null) {
    if (!isHex64(author) || kind == null) return null
  } else if (!isHex64(id)) {
    return null
  }

  // try store
  let event: NostrEvent | undefined
  if (identifier != null) {
    const results = await store.loadReplaceables([[kind!, author!, identifier]])
    event = results[0]?.[1] as NostrEvent | undefined
  } else {
    const results = await store.queryEvents({ ids: [id!] }, 1)
    event = results[0]
  }
  if (event) return event

  // prepare filter for relays (id / author+kind validated above)
  let filter: Record<string, any> = { limit: 1 }
  if (identifier != null) {
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

// Batched by-id fetch: dedupe + validate the ids (drop anything not 64-hex —
// see the redstore-poisoning note above), serve what the store has, then fetch
// only the misses from the fallback relays in ONE REQ (id union) rather than N.
export async function loadEvents(ids: unknown): Promise<NostrEvent[]> {
  if (!Array.isArray(ids)) return []
  const valid = [...new Set(ids.filter(isHex64))]
  if (valid.length === 0) return []
  const found = await store.queryEvents({ ids: valid })
  const seen = new Set(found.map(e => e.id))
  const missing = valid.filter(id => !seen.has(id))
  if (missing.length === 0) return found
  const fromRelays = await pool.querySync(FALLBACK_RELAYS, { ids: missing }, { maxWait: 4000 })
  for (const e of fromRelays) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    await store.saveEvent(e)
    found.push(e)
  }
  return found
}

type PublishResult = {
  relays: Record<string, { ok: boolean; error?: string }>
  published: number
  failed: number
}

// ─── NIP-09 deletions ──────────────────────────────────────────
// RedEventStore saves kind 5s like any other event but does not interpret
// them, so without help the local store keeps serving events their author has
// deleted — feeds then re-import "deleted" things and they come back.

async function applyDeletionLocally(event: NostrEvent) {
  if (event.kind !== 5) return
  try {
    const ids = event.tags.filter(t => t[0] === "e" && isHex64(t[1])).map(t => t[1])
    if (ids.length) {
      // NIP-09: only the author's own events are deletable.
      const targets = await store.queryEvents({ ids }, ids.length)
      const own = targets.filter(t => t.pubkey === event.pubkey).map(t => t.id)
      if (own.length) await store.deleteEvents(own)
    }
    for (const tag of event.tags) {
      if (tag[0] !== "a" || typeof tag[1] !== "string") continue
      const [kindStr, author, ...rest] = tag[1].split(":")
      const kind = Number(kindStr)
      if (!Number.isFinite(kind) || author !== event.pubkey) continue
      const filter: any = { kinds: [kind], authors: [author] }
      const d = rest.join(":")
      if (d) filter["#d"] = [d]
      // An address deletion covers versions up to its own timestamp — a
      // version published after it is a legitimate re-publish.
      filter.until = event.created_at
      await store.deleteEventsFilters([filter])
    }
  } catch (err) {
    console.warn("[store] applying deletion failed", err)
  }
}

// Whether a stored kind 5 already covers this addressable event — checked
// before feed ingest re-saves one, so a deleted tree/article does not
// resurrect from a relay that missed (or ignored) the deletion. Scoped to
// addressable kinds: rare in feed traffic, and where resurrection bites.
async function tombstoned(event: NostrEvent): Promise<boolean> {
  if (event.kind < 30000 || event.kind >= 40000) return false
  try {
    const d = event.tags.find(t => t[0] === "d")?.[1] ?? ""
    const addr = `${event.kind}:${event.pubkey}:${d}`
    const dels = await store.queryEvents({ kinds: [5], authors: [event.pubkey], "#a": [addr] }, 5)
    return dels.some(del => del.created_at >= event.created_at)
  } catch {
    return false
  }
}

// Re-apply every stored deletion — run after outbox syncs, which write into
// the store from inside the gadgets package where ingest cannot be hooked.
let lastDeletionSweep = 0
async function sweepStoredDeletions() {
  if (Date.now() - lastDeletionSweep < 2000) return
  lastDeletionSweep = Date.now()
  try {
    const dels = await store.queryEvents({ kinds: [5] }, 500)
    for (const del of dels) await applyDeletionLocally(del)
  } catch {}
}

async function publishEvent(event: NostrEvent, relays?: string[]): Promise<PublishResult> {
  // A published deletion must also take effect here — the napp's own feeds
  // answer from this store, and relays alone cannot clean it.
  if (event.kind === 5) {
    try {
      await store.saveEvent(event)
    } catch {}
    await applyDeletionLocally(event)
  }
  return publishEventToRelays(event, relays)
}

async function publishEventToRelays(event: NostrEvent, relays?: string[]): Promise<PublishResult> {
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

  // update cache for known replaceable kinds
  switch (event.kind) {
    case 3:
      loadFollowsList(event.pubkey, undefined, event).catch(() => {})
      break
    case 10000:
      loadMuteList(event.pubkey, undefined, event).catch(() => {})
      break
    case 10001:
      loadPins(event.pubkey, undefined, event).catch(() => {})
      break
    case 10002:
      loadRelayList(event.pubkey, undefined, event).catch(() => {})
      break
    case 10003:
      loadBookmarks(event.pubkey, undefined, event).catch(() => {})
      break
    case 10012:
      loadFavoriteRelays(event.pubkey, undefined, event).catch(() => {})
      break
    case 10030:
      loadEmojis(event.pubkey, undefined, event).catch(() => {})
      break
    case 10063:
      loadBlossomServers(event.pubkey, undefined, event).catch(() => {})
      break
    case 10101:
      loadWikiAuthors(event.pubkey, undefined, event).catch(() => {})
      break
    case 10102:
      loadWikiRelays(event.pubkey, undefined, event).catch(() => {})
      break
    case 30000:
      loadFollowSets(event.pubkey).catch(() => {})
      break
    case 30002:
      loadEmojiSets(event.pubkey).catch(() => {})
      break
  }

  return { relays: relaysMap, published, failed }
}
