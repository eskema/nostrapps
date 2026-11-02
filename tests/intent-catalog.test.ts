import { describe, test, expect } from "bun:test"
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure"
import {
  canReceiveIntent,
  manifestContracts,
  manifestIdentity,
  matchesHandler,
  preferenceReferences
} from "../src/intents/catalog"
import { editHandlerTags, handlerEntries } from "../src/intents/preferences"
import { mappedActionPayload, mappedNappAction } from "../src/intents/action-mappings"

const key = generateSecretKey()
const sign = (kind: number, tags: string[][]) =>
  finalizeEvent({ kind, tags, content: "fixture", created_at: 1 }, key)
const manifest = sign(35129, [
  ["d", "reader"],
  ["x", "0".repeat(64)],
  ["R", "intent"],
  ["z", "note"],
  ["i", "napplet:note/open", "id"],
  ["i", "napplet:article/open"]
])
const ref = manifestIdentity(manifest)
const snapshot = sign(5129, [["x", "1".repeat(64)]])

describe("intent trust and preference contracts", () => {
  test("signatures and exact role/convention declarations bind a handler", () => {
    expect(matchesHandler(manifest, ref)).toBe(true)
    expect(matchesHandler({ ...manifest, content: "changed" }, ref)).toBe(false)
    expect(matchesHandler(manifest, manifest.id)).toBe(false)
    expect(matchesHandler(snapshot, snapshot.id)).toBe(true)
    expect(manifestContracts(manifest)).toEqual([
      { archetype: "note", action: "open", convention: "napplet:note/open", params: ["id"] }
    ])
    expect(
      canReceiveIntent(
        sign(35129, [
          ["d", "legacy"],
          ["O", "inc"]
        ])
      )
    ).toBe(false)
  })
  test("private and public convention overrides precede archetype fallbacks; locked preferences fail closed", () => {
    const a = `35129:${manifest.pubkey}:a`,
      b = `35129:${manifest.pubkey}:b`,
      c = `35129:${manifest.pubkey}:c`
    const event = sign(31129, [
      ["d", "note"],
      ["a", a],
      ["i", "napplet:note/open", b]
    ])
    const preference = {
      event,
      privateTags: [
        ["e", snapshot.id],
        ["i", "napplet:note/open", c]
      ],
      locked: false
    }
    expect(preferenceReferences(preference, "napplet:note/open")).toEqual([c, b, snapshot.id, a])
    expect(preferenceReferences({ ...preference, locked: true }, "napplet:note/open")).toEqual([])
    expect(preferenceReferences(preference, "napplet:article/open")).toEqual([])
  })
  test("chain edits preserve other conventions, extension tags, and relay hints", () => {
    const publicTags = [
      ["d", "note"],
      ["a", ref, "wss://hint"],
      ["i", "napplet:note/share", ref],
      ["extension", "keep"]
    ]
    const [pub, priv] = editHandlerTags(publicTags, [], {
      action: "visibility",
      reference: ref,
      hidden: true
    })
    expect(pub).toEqual([
      ["d", "note"],
      ["i", "napplet:note/share", ref],
      ["extension", "keep"]
    ])
    expect(priv).toEqual([["a", ref, "wss://hint"]])
    expect(publicTags).toHaveLength(4)
    const [resetPub, resetPriv] = editHandlerTags(pub, priv, {
      action: "reset",
      identity: "napplet:note/share"
    })
    expect(resetPub).toEqual([
      ["d", "note"],
      ["extension", "keep"]
    ])
    expect(resetPriv).toEqual(priv)
    expect(handlerEntries({ event: sign(31129, pub), privateTags: priv, locked: false })).toEqual([
      { reference: ref, hidden: true }
    ])
  })
  test("NAPP aliases use fixed payload contracts and inverse routing rejects unrelated data", () => {
    expect(mappedActionPayload("profile", manifest.pubkey)).toEqual({ pubkey: manifest.pubkey })
    expect(mappedNappAction("napplet:profile/open", { pubkey: manifest.pubkey })).toEqual({
      name: "profile",
      payload: manifest.pubkey
    })
    expect(
      mappedNappAction("napplet:profile/open", { pubkey: manifest.pubkey, secret: "extra" })
    ).toBeUndefined()
    expect(() => mappedActionPayload("profile", "invalid")).toThrow()
    expect(() => mappedActionPayload("view:1", manifest)).toThrow()
  })
})
