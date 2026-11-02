import { expect, test } from "bun:test"
import { isValidNamedNapplet } from "../src/nsite/napplet-manifest"

const hash = "ab".repeat(32)
const manifest = () => ({
  kind: 35129,
  content: "A single-file napplet",
  tags: [
    ["d", "example"],
    ["x", hash]
  ]
})

test("accepts named napplets without requiring optional metadata", () => {
  expect(isValidNamedNapplet(manifest())).toBe(true)
})

test("rejects unrelated plugin records using the same kind", () => {
  expect(
    isValidNamedNapplet({
      kind: 35129,
      content: '{"name":"Starbright"}',
      tags: [["d", "org.omni.plugin.starbright"]]
    })
  ).toBe(false)
})

test.each([
  ["empty description", { content: " \n\t" }],
  ["missing hash", { tags: [["d", "example"]] }],
  [
    "invalid hash",
    {
      tags: [
        ["d", "example"],
        ["x", "not-a-hash"]
      ]
    }
  ],
  [
    "uppercase hash",
    {
      tags: [
        ["d", "example"],
        ["x", hash.toUpperCase()]
      ]
    }
  ],
  ["duplicate hash", { tags: [...manifest().tags, ["x", hash]] }],
  ["missing identifier", { tags: [["x", hash]] }],
  [
    "empty identifier",
    {
      tags: [
        ["d", ""],
        ["x", hash]
      ]
    }
  ],
  ["duplicate identifier", { tags: [...manifest().tags, ["d", "other"]] }],
  ["snapshot kind", { kind: 5129 }],
  ["root kind", { kind: 15129 }]
])("rejects %s", (_name, override) => {
  expect(isValidNamedNapplet({ ...manifest(), ...override })).toBe(false)
})

test("does not blacklist identifiers or publishers", () => {
  const event = manifest()
  event.tags[0][1] = "org.omni.plugin.starbright"
  expect(isValidNamedNapplet(event)).toBe(true)
})
