import { describe, expect, test } from "bun:test"
import { naddrEncode } from "@nostr/tools/nip19"
import { normalizeIntentUri } from "../src/intents/uri"

describe("NAP-INTENT URI normalization", () => {
  test("derives identity and preserves opaque payload", () => {
    expect(normalizeIntentUri("napplet:note/open?text=hello%20world&literal=a%2Bb", undefined)).toEqual({ archetype: "note", action: "open", convention: "napplet:note/open", payload: { text: "hello world", literal: "a+b" } })
    const payload = { event: { content: "secret" }, list: [1, null] }
    expect(normalizeIntentUri("napplet:note/open", { payload, behavior: { focus: false, reuse: false }, handler: "opaque-id" })).toEqual({ archetype: "note", action: "open", convention: "napplet:note/open", payload, behavior: { focus: false, reuse: false }, handler: "opaque-id" })
  })
  test("a named naddr fragment is a recommendation, not a forced handler", () => {
    const pubkey = "a".repeat(64)
    const naddr = naddrEncode({ kind: 35129, pubkey, identifier: "reader", relays: ["wss://relay.example"] })
    expect(normalizeIntentUri(`napplet:note/open#${naddr}`, undefined).handlerHint).toEqual({ address: `35129:${pubkey}:reader`, relays: ["wss://relay.example"] })
    expect(normalizeIntentUri(`napplet:note/open#${naddr}`, undefined).handler).toBeUndefined()
  })
  test("rejects ambiguous payloads, duplicate decoded keys and spoofed options", () => {
    for (const uri of ["napplet:Note/open", "napplet:note", "napplet:note/open?x=1&%78=2", "napplet:note/open?x=%GG", "napplet:note/open?x=1=2", "napplet:note/open#bad"]) expect(() => normalizeIntentUri(uri, undefined)).toThrow()
    expect(() => normalizeIntentUri("napplet:note/open?x=1", { payload: {} })).toThrow()
    expect(() => normalizeIntentUri("napplet:note/open", { sender: "forged" })).toThrow()
    expect(() => normalizeIntentUri("napplet:note/open", { behavior: { reuse: "true" } })).toThrow()
  })
})
