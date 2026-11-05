import type { NostrEvent } from "@nostr/tools/core"
import type { Filter } from "@nostr/tools/filter"
import { pool } from "@nostr/gadgets/global"
import { loadRelayList } from "@nostr/gadgets/lists"
import { getPubkey, subscribe as onAccountChanged } from "../account.js"
import { getInstalledApps } from "../persistence.js"
import { safeQueryEvents, getStore, onStoreSaved } from "../store.js"
import { currentSigner } from "../signers/index.js"
import { queryManifestEvents, optionalLookup } from "../nsite/relay-query.js"
import { FALLBACK_RELAYS } from "../relay-health.js"
import { verifyEventFresh } from "../verify.js"
import { openDialog } from "../dialog.js"
import { check, el } from "../system-napps/ui.js"
import { handlerChoice, buildNappHandlerChoices } from "../system-napps/handler.js"
import { hasUserActionHandler, findHandlersForAction, type ActionTarget } from "../handlers.js"
import { normalizeIntentUri } from "./uri.js"
import {
  actionConventions,
  mappedActionPayload,
  mappedNappAction,
  resolveMappedNappAction
} from "./action-mappings.js"
import { editHandlerTags, type HandlerEdit } from "./preferences.js"
import {
  canReceiveIntent,
  conventionIdentity,
  handlerPointer,
  manifestContracts,
  manifestIdentity,
  matchesHandler,
  newer,
  preferenceReferences,
  validateRequest,
  HANDLER_PREFERENCES_KIND,
  type HandlerPreference,
  type IntentAvailability,
  type IntentDelivery,
  type IntentRequest,
  type IntentResult
} from "./catalog.js"

export type IntentContext = { sender: string; signal?: AbortSignal; check(): void }
type Hooks = {
  deliver(
    event: NostrEvent,
    request: IntentRequest,
    delivery: IntentDelivery,
    context: IntentContext
  ): Promise<boolean>
  action(name: string, payload: unknown, target?: ActionTarget): Promise<unknown>
  loadEvent(code: string): Promise<NostrEvent | null>
}
let hooks: Hooks | undefined
export function configureIntents(value: Hooks) {
  hooks = value
}
const catalog = new Map<string, NostrEvent>()
const preferences = new Map<string, HandlerPreference>()
const listeners = new Set<() => void>()
const ids = new Map<string, string>()
let serial = 0
let generation = 0
let loading: Promise<void> | undefined
let preferencesSynced = false
let localLoading: Promise<void> | undefined
let cachedPreferences = false
let owner: string | null = getPubkey()
const candidateId = (reference: string) => {
  if (!ids.has(reference)) ids.set(reference, `intent-handler:${++serial}`)
  return ids.get(reference)!
}
function emit() {
  for (const fn of listeners) fn()
}
export function subscribeIntents(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function observeIntentManifest(event: NostrEvent) {
  const key = manifestIdentity(event)
  const known = catalog.get(key)
  // Catalog entries are already verified; skip re-verifying them or older revisions.
  if (known?.id === event.id || !newer(event, known)) return
  if (!verifyEventFresh(event) || !matchesHandler(event, key)) return
  catalog.set(key, event)
  emit()
}
function installed() {
  for (const app of getInstalledApps())
    if (app.event && [5129, 15129, 35129].includes(app.event.kind)) observeIntentManifest(app.event)
}
async function relays(write = false) {
  const pk = getPubkey()
  if (pk)
    try {
      const list = (await optionalLookup(loadRelayList(pk)))?.items
        .filter(r => (write ? r.write : r.read))
        .map(r => r.url)
      if (list?.length) return list
    } catch {}
  return FALLBACK_RELAYS
}
// The relays of the user's own NIP-65 list, or null when it can't be found in
// time. Fallback relays don't hold the user's preferences, so they never count:
// a slow lookup leaves the sync incomplete (and saving refused), never empty.
async function ownPreferenceRelays(pk: string): Promise<string[] | null> {
  try {
    const list = (await optionalLookup(loadRelayList(pk)))?.items
      .filter(r => r.write || r.read)
      .map(r => r.url)
    return list?.length ? list : null
  } catch {
    return null
  }
}
// Query each relay on its own so that only a real EOSE counts as an answer.
// The pool reports EOSE for a relay that closed or failed to connect too, but
// then calls onclose right away, in the same turn; a timeout is ours.
async function queryAnswered(urls: string[], filter: Filter, timeoutMs = 6000) {
  const events: NostrEvent[] = []
  let answered = 0
  await Promise.all(
    urls.map(
      url =>
        new Promise<void>(resolve => {
          let settled = false,
            closed = false
          const finish = (eose: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (eose) answered++
            void Promise.resolve(sub?.close()).catch(() => {})
            resolve()
          }
          const timer = setTimeout(() => finish(false), timeoutMs)
          let sub: { close(): unknown } | undefined
          try {
            sub = pool.subscribeMap([{ url, filter }], {
              label: "intent-preferences",
              // Longer than our own timer, so the pool never passes off a
              // timeout as an EOSE.
              maxWait: timeoutMs * 2,
              onevent: event => {
                if (!settled) events.push(event)
              },
              oneose: () => queueMicrotask(() => finish(!closed)),
              onclose: () => {
                closed = true
                finish(false)
              }
            })
            if (settled) void Promise.resolve(sub.close()).catch(() => {})
          } catch {
            finish(false)
          }
        })
    )
  )
  return { events, answered }
}
async function query(filter: Filter, hints?: string[]) {
  const cached = await safeQueryEvents(filter).catch(() => [])
  const remote = await queryManifestEvents(
    pool,
    hints?.length ? hints : await relays(),
    filter
  ).catch(() => [])
  return [...cached, ...remote]
}
function reset() {
  generation++
  owner = getPubkey()
  loading = undefined
  preferences.clear()
  preferencesSynced = false
  localLoading = undefined
  cachedPreferences = false
  ids.clear()
  emit()
}
onAccountChanged(reset)
// Persist signed events only; decrypted private handler tags stay in memory.
const preferenceCacheKey = (pk: string) => `nostrapps:intent-preferences:v1:${pk}`
function acceptPreference(event: NostrEvent, pk: string): boolean {
  if (event?.kind !== HANDLER_PREFERENCES_KIND || event.pubkey !== pk || !verifyEventFresh(event))
    return false
  const role = event.tags.find(t => t[0] === "d")?.[1]
  if (
    event.tags.filter(t => t[0] === "d").length !== 1 ||
    !role ||
    !conventionIdentity(`napplet:${role}/open`)
  )
    return false
  if (newer(event, preferences.get(role)?.event))
    preferences.set(role, { event, privateTags: [], locked: !!event.content })
  return true
}
function savePreferenceSnapshot(pk: string) {
  try {
    localStorage.setItem(
      preferenceCacheKey(pk),
      JSON.stringify([...preferences.values()].map(p => p.event))
    )
  } catch {} // The verified event store remains a second local cache.
}
async function loadLocalPreferences() {
  if (owner !== getPubkey()) reset()
  if (localLoading) return localLoading
  const pk = getPubkey(),
    version = generation
  localLoading = (async () => {
    if (!pk) return
    try {
      const snapshot: unknown = JSON.parse(localStorage.getItem(preferenceCacheKey(pk)) || "null")
      if (Array.isArray(snapshot)) {
        // An empty snapshot records a completed sync with no saved preferences.
        // Accept every valid entry, but only a fully valid snapshot counts as complete.
        let allValid = true
        for (const event of snapshot) if (!acceptPreference(event, pk)) allValid = false
        cachedPreferences = allValid
      }
    } catch {}
    const events = await safeQueryEvents({
      kinds: [HANDLER_PREFERENCES_KIND],
      authors: [pk]
    }).catch(() => [])
    if (version !== generation || pk !== getPubkey()) return
    for (const event of events) acceptPreference(event, pk)
    emit()
  })()
  return localLoading
}
export async function refreshIntentPreferences() {
  if (owner !== getPubkey()) reset()
  if (loading) return loading
  const pk = getPubkey(),
    version = generation
  loading = (async () => {
    if (!pk) return
    await loadLocalPreferences()
    if (generation !== version || pk !== getPubkey()) return
    const filter = { kinds: [HANDLER_PREFERENCES_KIND], authors: [pk] }
    const own = await ownPreferenceRelays(pk)
    if (generation !== version || pk !== getPubkey()) return
    // Complete only when one of the user's own relays actually answered;
    // otherwise an empty result must not stand in for "no preferences".
    const { events, answered } = own
      ? await queryAnswered(own, filter)
      : { events: await query(filter, FALLBACK_RELAYS), answered: 0 }
    const complete = answered > 0
    if (generation !== version || pk !== getPubkey()) return
    preferencesSynced = complete
    for (const event of events) acceptPreference(event, pk)
    if (complete) {
      cachedPreferences = true
      savePreferenceSnapshot(pk)
    }
    emit()
    // Keep verified relay preferences available after reload or while offline.
    await Promise.all(
      [...preferences.values()].map(({ event }) =>
        getStore()
          .saveEvent(event)
          .catch(() => {})
      )
    )
  })().finally(() => {
    if (generation === version) loading = undefined
  })
  return loading
}
const UNLOCK_TIMEOUT_MS = 60_000
// A preference that can't be unlocked (a signer that refuses, can't decrypt
// or never answers) must not block its archetype: route with its public tags.
async function tryUnlock(role: string, context: IntentContext, checkCurrent: () => void) {
  try {
    await unlockIntentPreference(role, context)
  } catch (error) {
    checkCurrent()
    console.warn(`[intents] could not unlock ${role} preferences`, error)
  }
}
export async function unlockIntentPreference(role: string, context?: IntentContext) {
  const preference = preferences.get(role)
  if (!preference?.locked) return
  const pk = getPubkey(),
    version = generation
  if (!pk) throw new Error("Connect an account to unlock handler preferences")
  // The decrypt takes no signal of its own: bound it, so a signer that never
  // answers can't hold the request (or settings) pending forever.
  const limit = AbortSignal.timeout(UNLOCK_TIMEOUT_MS)
  const signal = context?.signal ? AbortSignal.any([context.signal, limit]) : limit
  const plaintext = await new Promise<string>((resolve, reject) => {
    const abort = () =>
      reject(
        limit.aborted
          ? new Error("The signer did not decrypt the handler preferences")
          : signal.reason
      )
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    currentSigner()
      .nip44.decrypt(pk, preference.event.content)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
  context?.check()
  if (version !== generation || pk !== getPubkey() || preferences.get(role) !== preference)
    throw new Error("Your account or preferences changed")
  const tags: unknown = JSON.parse(plaintext)
  if (
    !Array.isArray(tags) ||
    tags.some(t => !Array.isArray(t) || t.some(v => typeof v !== "string"))
  )
    throw new Error("Invalid private handler preferences")
  preference.privateTags = tags
  preference.locked = false
}
export async function discoverIntents(convention?: string) {
  installed()
  const identity = convention && conventionIdentity(convention)
  const events = await query({
    kinds: [15129, 35129],
    ...(identity ? { "#z": [identity.archetype], "#i": [identity.convention] } : {}),
    limit: 500
  })
  for (const event of events) {
    observeIntentManifest(event)
    if (matchesHandler(event, manifestIdentity(event)))
      void getStore()
        .saveEvent(event)
        .catch(() => {})
  }
}
// Later store saves reach the catalog through onStoreSaved, so load once per session.
let localCatalog: Promise<void> | undefined
function loadLocalCatalog() {
  localCatalog ??= safeQueryEvents({ kinds: [5129, 15129, 35129] }).then(
    events => {
      for (const event of events) observeIntentManifest(event)
    },
    () => {
      localCatalog = undefined
    }
  )
  return localCatalog
}
const refreshing = new Map<string, Promise<void>>()
async function loadReference(reference: string, hints?: string[]) {
  const pointer = handlerPointer(reference, hints)
  if (!pointer) return
  const filter: Filter =
    "id" in pointer
      ? { ids: [pointer.id!] }
      : {
          kinds: [pointer.kind],
          authors: [pointer.pubkey],
          ...(pointer.kind === 35129 ? { "#d": [pointer.identifier] } : {})
        }
  const known = catalog.get(reference)
  const cached = await safeQueryEvents(filter).catch(() => [])
  let local = known && matchesHandler(known, reference) ? known : undefined
  for (const event of cached)
    if (matchesHandler(event, reference) && newer(event, local)) local = event
  if (local) {
    // A verified cached handler is usable immediately. Refresh its revision
    // independently; delivery rechecks catalog revisions before disclosure.
    // Event ids are immutable, and references outside the catalog (such as
    // private ones) would discard the result, so only refresh catalog addresses.
    if (!("id" in pointer) && catalog.has(reference) && !refreshing.has(reference))
      refreshing.set(
        reference,
        query(filter, hints)
          .then(events => {
            for (const event of events)
              if (catalog.has(reference) && matchesHandler(event, reference))
                observeIntentManifest(event)
          })
          .catch(() => {})
          .finally(() => refreshing.delete(reference))
      )
    return local
  }
  const events = await query(filter, hints)
  let best: NostrEvent | undefined
  for (const event of events)
    if (matchesHandler(event, reference) && newer(event, best)) best = event
  return best
}
function supports(event: NostrEvent, convention: string) {
  return canReceiveIntent(event) && manifestContracts(event).some(c => c.convention === convention)
}
export function intentAvailability(): IntentAvailability[] {
  installed()
  const groups = new Map<string, IntentAvailability>()
  for (const [reference, event] of catalog) {
    if (!canReceiveIntent(event)) continue
    const contracts = manifestContracts(event)
    for (const role of new Set(contracts.map(c => c.archetype))) {
      const own = contracts.filter(c => c.archetype === role)
      const group = groups.get(role) ?? {
        archetype: role,
        available: true,
        candidates: [],
        hasDefault: false
      }
      group.candidates.push({
        id: candidateId(reference),
        title: event.tags.find(t => t[0] === "title")?.[1] || "Napplet",
        actions: [...new Set(own.map(c => c.action))],
        conventions: own.map(c => c.convention),
        contracts: own.map(({ convention, params }) => ({ convention, params }))
      })
      group.hasDefault ||= own.some(
        c =>
          !!preferences.get(role) &&
          preferenceReferences(preferences.get(role)!, c.convention).length > 0
      )
      groups.set(role, group)
    }
  }
  return [...groups.values()].sort((a, b) => a.archetype.localeCompare(b.archetype))
}
export async function readIntentAvailability() {
  await Promise.all([discoverIntents(), refreshIntentPreferences()])
  return intentAvailability()
}
export function intentPreferences() {
  return new Map(preferences)
}
export async function editIntentPreference(role: string, edit: HandlerEdit) {
  const pk = getPubkey(),
    version = generation
  if (!pk) throw new Error("Connect an account to save intent handlers")
  await refreshIntentPreferences()
  if (!preferencesSynced)
    throw new Error("Handler preferences could not be synced. Refresh before saving.")
  // Clearing replaces the whole event, so a preference whose private part
  // can't be decrypted can still be cleared (its private entries are dropped).
  if (!(edit.action === "clear" && preferences.get(role)?.locked))
    await unlockIntentPreference(role)
  const previous = preferences.get(role)
  const checkAccount = () => {
    if (pk !== getPubkey() || version !== generation || preferences.get(role) !== previous)
      throw new Error("Your account or preferences changed. Try again.")
  }
  checkAccount()
  if (
    !conventionIdentity(`napplet:${role}/open`) ||
    (edit.identity && conventionIdentity(edit.identity)?.archetype !== role)
  )
    throw new Error("Invalid handler chain")
  const [tags, hidden] = editHandlerTags(
    previous?.event.tags ?? [["d", role]],
    previous?.privateTags ?? [],
    edit
  )
  const signer = currentSigner()
  const content = hidden.length ? await signer.nip44.encrypt(pk, JSON.stringify(hidden)) : ""
  checkAccount()
  const template = {
    kind: HANDLER_PREFERENCES_KIND,
    created_at: Math.max(Math.floor(Date.now() / 1000), (previous?.event.created_at ?? 0) + 1),
    tags,
    content
  }
  const snapshot = JSON.stringify(template)
  const signed = await signer.signEvent(template)
  checkAccount()
  if (
    !verifyEventFresh(signed) ||
    signed.pubkey !== pk ||
    JSON.stringify({
      kind: signed.kind,
      created_at: signed.created_at,
      tags: signed.tags,
      content: signed.content
    }) !== snapshot
  )
    throw new Error("The signer returned an unexpected preference event")
  const results = await Promise.allSettled(pool.publish(await relays(true), signed))
  checkAccount()
  if (!results.some(r => r.status === "fulfilled"))
    throw new Error("No relay accepted the preferences")
  preferences.set(role, { event: signed, privateTags: hidden, locked: false })
  savePreferenceSnapshot(pk)
  await getStore()
    .saveEvent(signed)
    .catch(() => {})
  emit()
}

type Choice =
  | { reference: string; remember: boolean; hidden: boolean }
  | { napp: true; remember: boolean; target?: ActionTarget }
function routeKey() {
  return `nostrapps:intent-routes:${getPubkey() || "guest"}`
}
function readRoutes(suffix = ""): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(`${routeKey()}${suffix}`) || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}
export function intentRoutes(): Record<string, "napp" | "napplet"> {
  return Object.fromEntries(
    Object.entries(readRoutes()).filter(
      ([convention, route]) =>
        conventionIdentity(convention) && (route === "napp" || route === "napplet")
    )
  ) as Record<string, "napp" | "napplet">
}
function rememberedNappTargets(): Record<string, ActionTarget> {
  return Object.fromEntries(
    Object.entries(readRoutes(":targets")).flatMap(([convention, value]) => {
      if (!conventionIdentity(convention) || !value || typeof value !== "object") return []
      const { nappId } = value as Partial<ActionTarget>
      // Window IDs expire; remembered choices always open the app afresh.
      return typeof nappId === "string" && nappId ? [[convention, { nappId }]] : []
    })
  )
}
export function forgetIntentRoute(convention: string) {
  const targets = rememberedNappTargets()
  delete targets[convention]
  localStorage.setItem(`${routeKey()}:targets`, JSON.stringify(targets))
  const routes = intentRoutes()
  delete routes[convention]
  localStorage.setItem(routeKey(), JSON.stringify(routes))
  emit()
}
function rememberRoute(convention: string, route: "napp" | "napplet") {
  localStorage.setItem(routeKey(), JSON.stringify({ ...intentRoutes(), [convention]: route }))
  emit()
}
// Compatibility is an optional alternative to an action, never its routing policy.
export function intentForNappAction(name: string, payload: unknown): IntentRequest | undefined {
  if (!Object.hasOwn(actionConventions, name)) return
  try {
    return {
      ...normalizeIntentUri(actionConventions[name]!, undefined),
      payload: mappedActionPayload(name, payload)
    }
  } catch {
    return
  }
}
export function hasInstalledIntentHandlers(request: IntentRequest): boolean {
  return getInstalledApps().some(
    app =>
      !!app.event &&
      [5129, 15129, 35129].includes(app.event.kind) &&
      supports(app.event, request.convention)
  )
}
export function hasIntentHandlers(request: IntentRequest): boolean {
  installed()
  return [...catalog.values()].some(event => supports(event, request.convention))
}
// A live list of compatible handlers. Rows are added, removed or swapped
// individually so the row under the cursor or focus is never rebuilt.
export function mountIntentHandlerChoices(
  request: IntentRequest,
  select: (handler: string) => void
): { element: HTMLElement; dispose(): void } {
  const body = el("div", "intent-handler-options")
  const empty = el("p", "", "No compatible napplets found.")
  const rows = new Map<string, { id: string; node: HTMLElement }>()
  const row = (reference: string, event: NostrEvent) =>
    handlerChoice({
      title: event.tags.find(t => t[0] === "title")?.[1] || "Napplet",
      pubkey: event.pubkey,
      iconSources: () =>
        import("../nsite/icon.js")
          .then(m => m.nappletIconSrc(event))
          .then(src => (src ? [src] : [])),
      onSelect: () => select(candidateId(reference))
    })
  const sync = () => {
    installed()
    const seen = new Set<string>()
    for (const [reference, event] of catalog) {
      if (!supports(event, request.convention)) continue
      seen.add(reference)
      const existing = rows.get(reference)
      if (existing?.id === event.id) continue
      const node = row(reference, event)
      if (existing) existing.node.replaceWith(node)
      else body.append(node)
      rows.set(reference, { id: event.id, node })
    }
    for (const [reference, { node }] of rows)
      if (!seen.has(reference)) {
        node.remove()
        rows.delete(reference)
      }
    if (rows.size) empty.remove()
    else if (!empty.isConnected) body.append(empty)
  }
  let scheduled = false
  const unsubscribe = subscribeIntents(() => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      sync()
    })
  })
  sync()
  return { element: body, dispose: unsubscribe }
}
async function choose(
  request: IntentRequest,
  context: IntentContext,
  message = ""
): Promise<Choice | null> {
  let dispose = () => {}
  try {
    return await openDialog<Choice | null>({
      title: "Open with",
      class: "app-dialog-handler",
      signal: context.signal,
      dismissValue: null,
      build(resolve) {
        const readable = (value: string) => value.replace(/[-_]+/g, " ")
        const action = readable(request.action)
        const body = el(
          "div",
          "intent-chooser",
          el("p", "", `Choose an app to ${action} ${readable(request.archetype)}.`)
        )
        if (message) body.append(el("p", "", message))
        const remember = check({ label: "Remember this choice" })
        const hidden = check({ label: "Keep handler preference private" })
        hidden.hidden = true
        remember.querySelector("input")?.addEventListener("change", () => {
          hidden.hidden = !getPubkey() || !rememberValue()
        })
        const rememberValue = () => !!remember.querySelector("input")?.checked
        const hiddenValue = () => !!hidden.querySelector("input")?.checked
        const choices = mountIntentHandlerChoices(request, handler => {
          const reference = [...catalog.keys()].find(ref => candidateId(ref) === handler)!
          resolve({ reference, remember: rememberValue(), hidden: hiddenValue() })
        })
        dispose = choices.dispose
        const napplets = el("div", "", choices.element)
        body.append(el("section", "intent-handler-section", el("h4", "", "Napplets"), napplets))
        const mapped = mappedNappAction(request.convention, request.payload)
        const napps =
          mapped &&
          buildNappHandlerChoices(mapped.name, mapped.payload, target =>
            resolve({ napp: true, target, remember: rememberValue() })
          )
        if (napps)
          body.append(el("section", "intent-handler-section", el("h4", "", "Napps"), napps))
        body.append(remember, hidden)
        return body
      },
      actions: [{ label: "Cancel", value: null }]
    })
  } finally {
    dispose()
  }
}
export async function invokeIntent(value: unknown, source: IntentContext): Promise<IntentResult> {
  const controller = new AbortController(),
    pk = getPubkey()
  const signal = source.signal
    ? AbortSignal.any([source.signal, controller.signal])
    : controller.signal
  const stop = onAccountChanged(() => {
    if (pk !== getPubkey()) controller.abort()
  })
  const context: IntentContext = {
    ...source,
    signal,
    check() {
      signal.throwIfAborted()
      source.check()
      if (pk !== getPubkey()) throw new Error("Your account changed")
    }
  }
  const progressController = new AbortController()
  const progress = openDialog({
    title: "Open with",
    class: "app-dialog-handler",
    body: "Finding apps for your request…",
    signal: AbortSignal.any([signal, progressController.signal]),
    dismissValue: null,
    actions: [{ label: "Cancel", value: null }]
  }).then(() => {
    if (!progressController.signal.aborted) controller.abort()
  })
  const ready = () => progressController.abort()
  let aborted: (() => void) | undefined
  const cancelled = new Promise<IntentResult>(resolve => {
    aborted = () => resolve({ ok: false, error: "Intent selection was cancelled" })
    if (signal.aborted) aborted()
    else signal.addEventListener("abort", aborted, { once: true })
  })
  try {
    // Shared preference sync and discovery can finish in the background. Their
    // context checks prevent delivery after cancellation; callers need not wait.
    return await Promise.race([resolveIntent(value, context, ready), cancelled])
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted)
    ready()
    await progress
    stop()
  }
}
// Thrown by delivery checks when the chosen route was superseded before disclosure.
class StaleRouteError extends Error {}
const MAX_ROUTE_PASSES = 3
async function resolveIntent(
  value: unknown,
  context: IntentContext,
  ready: () => void
): Promise<IntentResult> {
  try {
    const input = validateRequest(structuredClone(value))
    // Validate every option again at the authenticated host boundary.
    const request: IntentRequest = normalizeIntentUri(
      input.convention,
      Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => !["archetype", "action", "convention"].includes(key)
        )
      )
    )
    context.check()
    const pk = getPubkey(),
      version = generation
    const checkCurrent = () => {
      context.check()
      if (pk !== getPubkey() || version !== generation) throw new Error("Your account changed")
    }
    installed()
    // Discovery is independent of account preferences; start both together.
    // Catch here as an explicit handler/default may never need discovery.
    const discovery = request.handler
      ? Promise.resolve()
      : Promise.all([
          discoverIntents(request.convention),
          // Napplet-supplied relay hints are ignored: they would let a napplet
          // choose which relays the launcher connects to.
          request.handlerHint
            ? loadReference(request.handlerHint.address).then(event => {
                if (event && supports(event, request.convention)) observeIntentManifest(event)
              })
            : Promise.resolve()
        ])
          .then(() => {})
          .catch(() => {})
    if (!request.handler) {
      await loadLocalCatalog()
      checkCurrent()
      await loadLocalPreferences()
      checkCurrent()
      const sync = refreshIntentPreferences()
      // A first-ever account sync still discovers remote defaults. Returning
      // accounts can use verified local preferences without waiting for EOSE.
      if (!cachedPreferences && !preferences.has(request.archetype)) await sync
      else void sync.catch(() => {})
      checkCurrent()
      // Signers may need their own confirmation dialog.
      if (preferences.get(request.archetype)?.locked) ready()
      await tryUnlock(request.archetype, context, checkCurrent)
      checkCurrent()
    }
    if (!hooks) throw new Error("Intent launcher is unavailable")
    let target: NostrEvent | undefined
    let choice: Choice | null = null
    if (request.handler) {
      target = [...catalog.entries()].find(([ref]) => candidateId(ref) === request.handler)?.[1]
      if (!target || !supports(target, request.convention))
        throw new Error("Unknown or incompatible handler")
    } else {
      const route = intentRoutes()[request.convention]
      // Intent defaults belong to the napplet protocol, even when a NAPP mapping exists.
      // Cached preferences and manifests are used before relays answer. If either
      // changes before the payload is posted, restart with the current state
      // rather than falling back to the chooser. A change that lands after the
      // payload was posted cannot be undone; that is the cost of a fast cold start.
      preferenceWalk: for (let pass = 0; pass < MAX_ROUTE_PASSES; pass++) {
        const preference = preferences.get(request.archetype)
        if (!preference) break
        if (preference.locked) {
          ready()
          await tryUnlock(request.archetype, context, checkCurrent)
          checkCurrent()
        }
        for (const ref of preferenceReferences(preference, request.convention)) {
          const tag = [...preference.privateTags, ...preference.event.tags].find(
            t => (t[0] === "a" || t[0] === "e") && t[1] === ref
          )
          const event = await loadReference(ref, tag?.[2] ? [tag[2]] : undefined)
          checkCurrent()
          if (preferences.get(request.archetype) !== preference) continue preferenceWalk
          if (!event || !supports(event, request.convention)) continue
          try {
            ready()
            if (
              await hooks.deliver(event, request, deliveryFor(request, context.sender), {
                ...context,
                check() {
                  checkCurrent()
                  if (
                    preferences.get(request.archetype)?.event.id !== preference.event.id ||
                    !preferenceReferences(preference, request.convention).includes(ref)
                  )
                    throw new StaleRouteError("Handler preferences changed")
                  const current = catalog.get(ref)
                  if (current && newer(current, event))
                    throw new StaleRouteError("The handler manifest changed")
                }
              })
            )
              return success(request, candidateId(ref))
          } catch (error) {
            checkCurrent()
            if (error instanceof StaleRouteError) continue preferenceWalk
          }
        }
        break
      }
      const mapped = mappedNappAction(request.convention, request.payload)
      const saved = rememberedNappTargets()[request.convention]
      if (
        route === "napp" &&
        saved &&
        mapped &&
        findHandlersForAction(mapped.name)[0].includes(saved.nappId)
      )
        choice = { napp: true, target: saved, remember: false }
    }
    if (!target && !choice) {
      const mapped = mappedNappAction(request.convention, request.payload)
      if (!hasIntentHandlers(request) && !(mapped && hasUserActionHandler(mapped.name)))
        await discovery
      checkCurrent()
    }
    // With no installed choice in either protocol, retain the existing Apps discovery flow.
    const mappedFallback = mappedNappAction(request.convention, request.payload)
    if (
      !target &&
      !choice &&
      !hasIntentHandlers(request) &&
      mappedFallback &&
      !hasUserActionHandler(mappedFallback.name)
    )
      choice = { napp: true, remember: false }
    ready()
    let message = ""
    while (true) {
      checkCurrent()
      if (!target && !choice) choice = await choose(request, context, message)
      checkCurrent()
      if (!target && !choice) throw new Error("Intent selection was cancelled")
      if (choice && "napp" in choice) {
        const mapped = await resolveMappedNappAction(
          request.convention,
          request.payload,
          hooks.loadEvent
        )
        checkCurrent()
        if (!mapped) throw new Error("This payload cannot be opened as a NAPP action")
        const result = await hooks.action(mapped.name, mapped.payload, choice.target)
        checkCurrent()
        if (result && typeof result === "object" && "ok" in result && result.ok === false)
          throw new Error("The app could not open this action")
        if (choice.remember && choice.target) {
          try {
            localStorage.setItem(
              `${routeKey()}:targets`,
              JSON.stringify({
                ...rememberedNappTargets(),
                [request.convention]: { nappId: choice.target.nappId }
              })
            )
            rememberRoute(request.convention, "napp")
          } catch (error) {
            reportPreferenceSaveFailure(error)
          }
        }
        return success(request, `napp:${mapped.name}`)
      }
      const selected = choice && "reference" in choice ? choice : undefined
      target ??= selected ? catalog.get(selected.reference) : undefined
      if (
        !target ||
        !supports(target, request.convention) ||
        !matchesHandler(target, manifestIdentity(target))
      )
        throw new Error("The handler is no longer compatible")
      const ref = manifestIdentity(target)
      try {
        // The user picked a handler, not a revision: follow compatible updates.
        for (let pass = 0; ; pass++) {
          const attempt: NostrEvent = target
          try {
            if (
              !(await hooks.deliver(attempt, request, deliveryFor(request, context.sender), {
                ...context,
                check() {
                  checkCurrent()
                  if (catalog.get(ref)?.id !== attempt.id)
                    throw new StaleRouteError("The handler manifest changed")
                }
              }))
            )
              throw new Error("The target could not start")
            break
          } catch (error) {
            checkCurrent()
            const latest = catalog.get(ref)
            if (
              !(error instanceof StaleRouteError) ||
              pass + 1 >= MAX_ROUTE_PASSES ||
              !latest ||
              latest.id === attempt.id ||
              !supports(latest, request.convention)
            )
              throw error
            target = latest
          }
        }
        checkCurrent()
        if (selected?.remember) {
          try {
            if (pk)
              await editIntentPreference(request.archetype, {
                action: "prefer",
                identity: request.convention,
                reference: ref,
                hidden: selected.hidden
              })
            checkCurrent()
            rememberRoute(request.convention, "napplet")
          } catch (error) {
            // Delivery already succeeded. Never retry it because saving failed.
            reportPreferenceSaveFailure(error)
          }
        }
        return success(request, candidateId(ref))
      } catch (error) {
        checkCurrent()
        if (request.handler) throw error
        message = error instanceof Error ? error.message : "Could not open this napplet"
        target = undefined
        choice = null
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
function reportPreferenceSaveFailure(error: unknown) {
  // A storage or relay failure must not turn completed delivery into failure.
  void openDialog({
    title: "Opened; preference could not be saved",
    body: error instanceof Error ? error.message : String(error),
    dismissValue: null,
    actions: [{ label: "OK", value: null }]
  })
}
function deliveryFor(request: IntentRequest, sender: string): IntentDelivery {
  return {
    sender,
    archetype: request.archetype,
    action: request.action,
    convention: request.convention,
    ...(Object.hasOwn(request, "payload") ? { payload: request.payload } : {})
  }
}
function success(request: IntentRequest, handler: string): IntentResult {
  return {
    ok: true,
    archetype: request.archetype,
    action: request.action,
    convention: request.convention,
    handler
  }
}
export function isIntentAction(name: string) {
  return name === "nap-intent" || !!conventionIdentity(name)
}
export async function dispatchIntentAction(
  name: string,
  payload: unknown,
  sender = "nostrapps:external-action"
) {
  try {
    let request: IntentRequest
    if (name === "nap-intent") {
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.keys(payload).some(k => !["uri", "payload"].includes(k))
      )
        throw new Error("Expected uri and optional payload")
      const envelope = payload as { uri: string; payload?: unknown }
      request = normalizeIntentUri(
        envelope.uri,
        Object.hasOwn(envelope, "payload") ? { payload: envelope.payload } : undefined
      )
    } else request = { ...normalizeIntentUri(name, undefined), payload }
    const controller = new AbortController(),
      pk = getPubkey()
    const stop = onAccountChanged(() => controller.abort())
    try {
      return await invokeIntent(request, {
        sender,
        signal: controller.signal,
        check() {
          controller.signal.throwIfAborted()
          if (pk !== getPubkey()) throw new Error("Your account changed")
        }
      })
    } finally {
      stop()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function intentCatalog() {
  installed()
  return new Map(catalog)
}

onStoreSaved(event => {
  if ([5129, 15129, 35129].includes(event.kind)) observeIntentManifest(event)
  else if (event.kind === HANDLER_PREFERENCES_KIND) {
    const pk = getPubkey()
    const role = event.tags.find(t => t[0] === "d")?.[1]
    const previous = role ? preferences.get(role) : undefined
    if (pk && acceptPreference(event, pk) && role && preferences.get(role) !== previous) {
      if (cachedPreferences) savePreferenceSnapshot(pk)
      emit()
    }
  }
})

window.addEventListener("storage", event => {
  if (owner !== getPubkey()) reset()
  else if (event.key === null || event.key === routeKey()) emit()
})
