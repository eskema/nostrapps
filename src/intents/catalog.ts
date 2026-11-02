import type { NostrEvent } from "@nostr/tools/core"
import { verifyEventFresh } from "../verify.js"

export type IntentRequest = {
  archetype: string
  action: string
  convention: string
  payload?: unknown
  handler?: string
  handlerHint?: { address: string; relays?: string[] }
  behavior?: { focus?: boolean; reuse?: boolean }
}
export type IntentDelivery = Pick<IntentRequest, "archetype" | "action" | "convention" | "payload"> & { sender: string }
export type IntentResult = { ok: true; archetype: string; action: string; convention: string; handler: string } | { ok: false; error: string }
export type IntentCandidate = { id: string; title: string; actions: string[]; conventions: string[]; contracts: { convention: string; params: string[] }[] }
export type IntentAvailability = { archetype: string; available: boolean; candidates: IntentCandidate[]; hasDefault: boolean }
export const HANDLER_PREFERENCES_KIND = 31129
export const conventionPattern = /^napplet:([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/
export function conventionIdentity(value: string) {
  const match = conventionPattern.exec(value)
  return match ? { archetype: match[1], action: match[2], convention: value } : undefined
}
export function manifestIdentity(event: NostrEvent): string {
  return event.kind === 5129 ? event.id : `${event.kind}:${event.pubkey}:${event.kind === 35129 ? event.tags.find(t => t[0] === "d")?.[1] ?? "" : ""}`
}
export function handlerPointer(reference: string, relays: string[] = []) {
  if (/^[a-f0-9]{64}$/.test(reference)) return { id: reference, relays }
  const match = /^(15129|35129):([a-f0-9]{64}):(.*)$/.exec(reference)
  if (!match || (match[1] === "35129" ? !match[3] : !!match[3])) return undefined
  return { kind: Number(match[1]), pubkey: match[2], identifier: match[3], relays }
}
export function matchesHandler(event: NostrEvent, reference: string) {
  return !!handlerPointer(reference) && [5129, 15129, 35129].includes(event.kind) &&
    manifestIdentity(event) === reference && verifyEventFresh(event) &&
    !event.tags.some(t => t[0] === "path" || t[0] === "x" && t[2] === "aggregate") &&
    event.tags.filter(t => t[0] === "x").length === 1 &&
    /^[a-f0-9]{64}$/.test(event.tags.find(t => t[0] === "x")?.[1] ?? "") &&
    (event.kind !== 35129 || event.tags.filter(t => t[0] === "d").length === 1 && !!event.tags.find(t => t[0] === "d")?.[1])
}
export function canReceiveIntent(event: NostrEvent) {
  return event.tags.some(t => (t[0] === "R" || t[0] === "O") && t[1] === "intent")
}
export function manifestContracts(event: NostrEvent) {
  const roles = new Set(event.tags.filter(t => t[0] === "z").map(t => t[1]))
  return event.tags.flatMap(tag => {
    const request = tag[0] === "i" && conventionIdentity(tag[1] ?? "")
    return request && roles.has(request.archetype) ? [{ ...request, params: tag.slice(2) }] : []
  })
}
export interface HandlerPreference { event: NostrEvent; privateTags: string[][]; locked: boolean }
export function preferenceReferences(preference: HandlerPreference, convention: string): string[] {
  const request = conventionIdentity(convention)
  if (!request || preference.locked || preference.event.tags.find(t => t[0] === "d")?.[1] !== request.archetype) return []
  const specific = (tags: string[][]) => tags.filter(t => t[0] === "i" && t[1] === convention).map(t => t[2])
  const general = (tags: string[][]) => tags.filter(t => t[0] === "a" && t[1]?.includes(":") || t[0] === "e" && /^[a-f0-9]{64}$/.test(t[1])).map(t => t[1])
  return [...new Set([...specific(preference.privateTags), ...specific(preference.event.tags), ...general(preference.privateTags), ...general(preference.event.tags)])].filter(ref => typeof ref === "string" && !!handlerPointer(ref))
}
export function validateRequest(value: unknown): IntentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intent request")
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !["archetype", "action", "convention", "payload", "handler", "handlerHint", "behavior"].includes(key))) throw new Error("Unsupported intent request fields")
  const identity = typeof source.convention === "string" && conventionIdentity(source.convention)
  if (!identity || identity.archetype !== source.archetype || identity.action !== source.action) throw new Error("Invalid intent convention")
  return source as IntentRequest
}
export function newer(event: NostrEvent, previous?: NostrEvent) {
  return !previous || event.created_at > previous.created_at || event.created_at === previous.created_at && event.id < previous.id
}
