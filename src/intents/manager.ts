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
import { button, check, el, code } from "../system-napps/ui.js"
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
  action(name: string, payload: unknown): Promise<unknown>
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
  if (!verifyEventFresh(event)) return
  const key = manifestIdentity(event)
  if (!matchesHandler(event, key) || !newer(event, catalog.get(key))) return
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
async function query(
  filter: Filter,
  hints?: string[],
  reportComplete?: (complete: boolean) => void
) {
  let complete = false
  const cached = await safeQueryEvents(filter).catch(() => [])
  const remote = await queryManifestEvents(
    {
      subscribeMap(requests, params) {
        return pool.subscribeMap(requests, {
          ...params,
          oneose() {
            complete = true
            params.oneose?.()
          }
        })
      }
    },
    hints?.length ? hints : await relays(),
    filter
  ).catch(() => [])
  reportComplete?.(complete)
  return [...cached, ...remote]
}
function reset() {
  generation++
  owner = getPubkey()
  loading = undefined
  preferences.clear()
  preferencesSynced = false
  ids.clear()
  emit()
}
onAccountChanged(reset)
export async function refreshIntentPreferences() {
  if (owner !== getPubkey()) reset()
  if (loading) return loading
  const pk = getPubkey(),
    version = generation
  loading = (async () => {
    if (!pk) return
    let complete = false
    const events = await query(
      { kinds: [HANDLER_PREFERENCES_KIND], authors: [pk] },
      undefined,
      value => {
        complete = value
      }
    )
    if (generation !== version) return
    preferencesSynced = complete
    for (const event of events) {
      const role = event.tags.find(t => t[0] === "d")?.[1]
      if (
        event.kind !== HANDLER_PREFERENCES_KIND ||
        event.tags.filter(t => t[0] === "d").length !== 1 ||
        !role ||
        !conventionIdentity(`napplet:${role}/open`) ||
        event.pubkey !== pk ||
        !verifyEventFresh(event) ||
        !newer(event, preferences.get(role)?.event)
      )
        continue
      // Hidden tags are unlocked only when their role is invoked or edited.
      preferences.set(role, { event, privateTags: [], locked: !!event.content })
    }
    emit()
  })().finally(() => {
    if (generation === version) loading = undefined
  })
  return loading
}
export async function unlockIntentPreference(role: string, context?: IntentContext) {
  const preference = preferences.get(role)
  if (!preference?.locked) return
  const pk = getPubkey(),
    version = generation
  if (!pk) throw new Error("Connect an account to unlock handler preferences")
  const plaintext = await currentSigner().nip44.decrypt(pk, preference.event.content)
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
  for (const event of events) observeIntentManifest(event)
}
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
  await getStore()
    .saveEvent(signed)
    .catch(() => {})
  emit()
}

type Choice =
  { reference: string; remember: boolean; hidden: boolean } | { napp: true; remember: boolean }
function routeKey() {
  return `nostrapps:intent-routes:${getPubkey() || "guest"}`
}
export function intentRoutes(): Record<string, "napp" | "napplet"> {
  try {
    return JSON.parse(localStorage.getItem(routeKey()) || "{}")
  } catch {
    return {}
  }
}
export function forgetIntentRoute(convention: string) {
  const routes = intentRoutes()
  delete routes[convention]
  localStorage.setItem(routeKey(), JSON.stringify(routes))
  emit()
}
function rememberRoute(convention: string, route: "napp" | "napplet") {
  localStorage.setItem(routeKey(), JSON.stringify({ ...intentRoutes(), [convention]: route }))
  emit()
}
async function choose(
  request: IntentRequest,
  context: IntentContext,
  message = ""
): Promise<Choice | null> {
  return openDialog<Choice | null>({
    title: "Open with",
    signal: context.signal,
    dismissValue: null,
    build(resolve) {
      const body = el("div", "intent-chooser", code(request.convention))
      if (message) body.append(el("p", "", message))
      const remember = check({ label: "Remember this choice" })
      const hidden = check({ label: "Keep handler preference private" })
      hidden.hidden = !getPubkey()
      body.append(remember, hidden)
      const rememberValue = () => !!remember.querySelector("input")?.checked
      const hiddenValue = () => !!hidden.querySelector("input")?.checked
      for (const [reference, event] of catalog)
        if (supports(event, request.convention)) {
          const title = event.tags.find(t => t[0] === "title")?.[1] || "Napplet"
          const row = el(
            "div",
            "",
            button({
              label: title,
              onClick: () =>
                resolve({ reference, remember: rememberValue(), hidden: hiddenValue() })
            }),
            code(reference)
          )
          body.append(row)
        }
      if (mappedNappAction(request.convention, request.payload))
        body.append(
          button({
            label: "Open in another app",
            onClick: () => resolve({ napp: true, remember: rememberValue() })
          })
        )
      if (![...catalog.values()].some(e => supports(e, request.convention)))
        body.append(el("p", "", "No compatible napplets found."))
      return body
    },
    actions: [{ label: "Cancel", value: null }]
  })
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
  try {
    return await resolveIntent(value, context)
  } finally {
    stop()
  }
}
async function resolveIntent(value: unknown, context: IntentContext): Promise<IntentResult> {
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
    await refreshIntentPreferences()
    checkCurrent()
    await unlockIntentPreference(request.archetype, context)
    checkCurrent()
    if (!hooks) throw new Error("Intent launcher is unavailable")
    let target: NostrEvent | undefined
    let choice: Choice | null = null
    if (request.handler) {
      target = [...catalog.entries()].find(([ref]) => candidateId(ref) === request.handler)?.[1]
      if (!target || !supports(target, request.convention))
        throw new Error("Unknown or incompatible handler")
    } else {
      const preference = preferences.get(request.archetype)
      const route = intentRoutes()[request.convention]
      if (route === "napp" && mappedNappAction(request.convention, request.payload))
        choice = { napp: true, remember: false }
      if (
        !choice &&
        preference &&
        (route === "napplet" || !mappedNappAction(request.convention, request.payload))
      ) {
        for (const ref of preferenceReferences(preference, request.convention)) {
          const tag = [...preference.privateTags, ...preference.event.tags].find(
            t => (t[0] === "a" || t[0] === "e") && t[1] === ref
          )
          const event = await loadReference(ref, tag?.[2] ? [tag[2]] : undefined)
          checkCurrent()
          if (!event || !supports(event, request.convention)) continue
          try {
            if (
              await hooks.deliver(event, request, deliveryFor(request, context.sender), {
                ...context,
                check() {
                  checkCurrent()
                  if (
                    preferences.get(request.archetype)?.event.id !== preference.event.id ||
                    !preferenceReferences(preference, request.convention).includes(ref)
                  )
                    throw new Error("Handler preferences changed")
                  const current = catalog.get(ref)
                  if (current && newer(current, event))
                    throw new Error("The handler manifest changed")
                }
              })
            )
              return success(request, candidateId(ref))
          } catch {
            checkCurrent()
          }
        }
      }
    }
    if (!target && !choice) {
      await discoverIntents(request.convention)
      checkCurrent()
      if (request.handlerHint) {
        const event = await loadReference(request.handlerHint.address, request.handlerHint.relays)
        checkCurrent()
        if (event && supports(event, request.convention)) observeIntentManifest(event)
      }
    }
    // Preserve the launcher's ordinary action flow when discovery finds no
    // napplet for a compatible NAPP action.
    if (
      !target &&
      !choice &&
      ![...catalog.values()].some(event => supports(event, request.convention)) &&
      mappedNappAction(request.convention, request.payload)
    )
      choice = { napp: true, remember: false }
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
        const result = await hooks.action(mapped.name, mapped.payload)
        checkCurrent()
        if (result && typeof result === "object" && "ok" in result && result.ok === false)
          throw new Error("The app could not open this action")
        if (choice.remember) rememberRoute(request.convention, "napp")
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
        if (
          !(await hooks.deliver(target, request, deliveryFor(request, context.sender), {
            ...context,
            check() {
              checkCurrent()
              if (catalog.get(ref)?.id !== target?.id)
                throw new Error("The handler manifest changed")
            }
          }))
        )
          throw new Error("The target could not start")
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
            void openDialog({
              title: "Opened; preference could not be saved",
              body: error instanceof Error ? error.message : String(error),
              dismissValue: null,
              actions: [{ label: "OK", value: null }]
            })
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
    } else
      request = {
        ...normalizeIntentUri(actionConventions[name] ?? name, undefined),
        payload: Object.hasOwn(actionConventions, name)
          ? mappedActionPayload(name, payload)
          : payload
      }
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
  else if (
    event.kind === HANDLER_PREFERENCES_KIND &&
    event.pubkey === getPubkey() &&
    verifyEventFresh(event)
  ) {
    const role = event.tags.find(t => t[0] === "d")?.[1]
    if (
      !role ||
      event.tags.filter(t => t[0] === "d").length !== 1 ||
      !conventionIdentity(`napplet:${role}/open`) ||
      !newer(event, preferences.get(role)?.event)
    )
      return
    preferences.set(role, { event, privateTags: [], locked: !!event.content })
    emit()
  }
})

window.addEventListener("storage", event => {
  if (owner !== getPubkey()) reset()
  else if (event.key === null || event.key === routeKey()) emit()
})
