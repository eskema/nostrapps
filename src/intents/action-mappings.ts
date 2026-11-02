// NAPP compatibility contracts ported from napplet-frame.
import * as nip19 from "@nostr/tools/nip19"
import { verifyEventFresh as verifyEvent } from "../verify.js"
import type { NostrEvent } from "@nostr/tools/core"

const hex = /^[a-f0-9]{64}$/

const eventConventions: Readonly<Record<string, string>> = {
  "0": "napplet:profile/open",
  "1": "napplet:note/open",
  "3": "napplet:contacts/open",
  "6": "napplet:event/open",
  "7": "napplet:reaction/open",
  "1073": "napplet:scrobble/open",
  "1111": "napplet:event/open",
  "1222": "napplet:event/open",
  "1244": "napplet:event/open",
  "4554": "napplet:webarchive/open",
  "9802": "napplet:highlight/open",
  "30023": "napplet:article/open",
  "30064": "napplet:hashtree/open",
  "30617": "napplet:repository/open",
  "30818": "napplet:definition/open",
  "30819": "napplet:definition/open"
}

/** Fixed compatibility contracts, never inferred from manifest parameters. */
export const actionConventions: Readonly<Record<string, string>> = Object.freeze({
  profile: "napplet:profile/open",
  feed: "napplet:feed/open",
  relay: "napplet:relay/open",
  "simple-group": "napplet:group/open",
  htree: "napplet:hashtree/open",
  view: "napplet:event/open",
  ...Object.fromEntries(
    Object.entries(eventConventions).map(([kind, convention]) => [`view:${kind}`, convention])
  )
})

function verifiedEvent(value: unknown): value is NostrEvent {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const event = value as NostrEvent
    // Do not trust nostr-tools' cached verification symbol across this boundary.
    const { id, pubkey, sig, kind, created_at, tags, content } = event
    return (
      Number.isSafeInteger(kind) &&
      kind >= 0 &&
      typeof pubkey === "string" &&
      hex.test(pubkey) &&
      verifyEvent({ id, pubkey, sig, kind, created_at, tags, content })
    )
  } catch {
    return false
  }
}

function relayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "wss:" || url.protocol === "ws:") &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}

function groupAddress(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const decoded = nip19.decode(value)
    return (
      decoded.type === "naddr" &&
      decoded.data.kind === 39000 &&
      !!decoded.data.identifier &&
      hex.test(decoded.data.pubkey) &&
      !!decoded.data.relays?.length &&
      decoded.data.relays.every(relayUrl)
    )
  } catch {
    return false
  }
}

function hashtreeUri(value: unknown): value is string {
  return typeof value === "string" && /^htree:\/\/[^\s/?#]+\/[^\s]+$/.test(value)
}

function eventReference(convention: string, payload: unknown) {
  const kind =
    convention === "napplet:note/open"
      ? 1
      : convention === "napplet:article/open"
        ? 30023
        : undefined
  if (kind === undefined) return
  let reference = payload
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const fields = Object.keys(payload)
    if (fields.length !== 1 || !["id", "uri", "event"].includes(fields[0]!)) return
    reference = (payload as Record<string, unknown>)[fields[0]!]
  }
  if (typeof reference !== "string") return
  const code = reference.replace(/^nostr:/, "")
  if (hex.test(code)) return { kind, code, pointer: { id: code } }
  try {
    const decoded = nip19.decode(code)
    if (decoded.type === "note") return { kind, code, pointer: { id: decoded.data } }
    if (
      decoded.type === "nevent" &&
      (decoded.data.kind === undefined || decoded.data.kind === kind)
    ) {
      return { kind, code, pointer: { id: decoded.data.id, author: decoded.data.author } }
    }
    if (decoded.type === "naddr" && decoded.data.kind === kind)
      return { kind, code, pointer: decoded.data }
  } catch {
    /* Not a supported event reference. */
  }
}

/** Resolve only at delegation time; the original napplet payload stays opaque. */
export async function resolveMappedNappAction(
  convention: string,
  payload: unknown,
  load: (code: string) => Promise<NostrEvent | null>
) {
  const reference = eventReference(convention, payload)
  if (!reference) return mappedNappAction(convention, payload)
  const event = await load(reference.code)
  if (!verifiedEvent(event) || event.kind !== reference.kind)
    throw new Error("Could not resolve a verified event for this intent.")
  const pointer = reference.pointer
  const matches =
    "id" in pointer
      ? event.id === pointer.id &&
        (!("author" in pointer) || !pointer.author || event.pubkey === pointer.author)
      : event.pubkey === pointer.pubkey &&
        event.kind === pointer.kind &&
        event.tags.find(tag => tag[0] === "d")?.[1] === pointer.identifier
  if (!matches) throw new Error("The resolved event does not match the requested reference.")
  return mappedNappAction(convention, { event })
}

/** Validate and wrap an incoming launcher payload without fetching or dropping fields. */
export function mappedActionPayload(name: string, payload: unknown): Record<string, unknown> {
  if (name === "profile" && typeof payload === "string" && hex.test(payload))
    return { pubkey: payload }
  if (
    name === "feed" &&
    Array.isArray(payload) &&
    payload.length > 0 &&
    payload.every(value => typeof value === "string" && hex.test(value))
  )
    return { pubkeys: payload }
  if (name === "relay" && Array.isArray(payload) && payload.length > 0 && payload.every(relayUrl))
    return { relays: payload }
  if (name === "simple-group" && groupAddress(payload)) return { address: payload }
  if (name === "htree" && hashtreeUri(payload)) return { uri: payload }
  if (
    (name === "view" || (Object.hasOwn(actionConventions, name) && name.startsWith("view:"))) &&
    verifiedEvent(payload)
  ) {
    if (name !== "view" && payload.kind !== Number(name.slice(5)))
      throw new Error(`Expected a verified kind ${name.slice(5)} event.`)
    return name === "view:0" ? { pubkey: payload.pubkey } : { event: payload }
  }
  throw new Error(`Invalid payload for NAPP action ${name}.`)
}

/** Delegation candidate; references require resolveMappedNappAction before sending. */
export function mappedNappAction(
  convention: string,
  payload: unknown
): { name: string; payload: unknown } | undefined {
  const reference = eventReference(convention, payload)
  if (reference) return { name: `view:${reference.kind}`, payload: reference.code }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
  const value = payload as Record<string, unknown>
  if (Object.keys(value).length !== 1) return
  if (Object.hasOwn(value, "event") && verifiedEvent(value.event)) {
    const name = convention === "napplet:event/open" ? "view" : `view:${value.event.kind}`
    if (
      name !== "view:0" &&
      Object.hasOwn(actionConventions, name) &&
      actionConventions[name] === convention
    )
      return { name, payload: value.event }
    return
  }
  const candidates = [
    ["profile", "pubkey"],
    ["feed", "pubkeys"],
    ["relay", "relays"],
    ["simple-group", "address"],
    ["htree", "uri"]
  ]
  for (const [name, field] of candidates) {
    if (!name || !field || actionConventions[name] !== convention || !Object.hasOwn(value, field))
      continue
    try {
      mappedActionPayload(name, value[field])
      return { name, payload: value[field] }
    } catch {
      return
    }
  }
}
