import { expect, test } from "bun:test"
import { optionalLookup, queryManifestEvents } from "../src/nsite/relay-query"

test("manifest lookup finishes and closes even if relays never send EOSE or CLOSE", async () => {
  let closed = 0
  let signal: AbortSignal | undefined
  const events = await queryManifestEvents(
    {
      subscribeMap(_requests, params) {
        signal = params.abort
        return {
          close() {
            closed++
          }
        }
      }
    },
    ["wss://silent.example"],
    { kinds: [35129] },
    { timeoutMs: 10 }
  )
  expect(events).toEqual([])
  expect(closed).toBe(1)
  expect(signal?.aborted).toBe(true)
})

test("synchronous relay completion still closes its subscription", async () => {
  let closed = 0
  await queryManifestEvents(
    {
      subscribeMap(_requests, params) {
        params.oneose?.()
        return {
          close() {
            closed++
          }
        }
      }
    },
    ["wss://empty.example"],
    { kinds: [35129] }
  )
  expect(closed).toBe(1)
})

test("cancelling manifest lookup rejects and closes the subscription", async () => {
  let closed = 0
  const controller = new AbortController()
  const result = queryManifestEvents(
    {
      subscribeMap() {
        return {
          close() {
            closed++
          }
        }
      }
    },
    ["wss://silent.example"],
    {},
    { signal: controller.signal }
  )
  controller.abort()
  await expect(result).rejects.toMatchObject({ name: "AbortError" })
  expect(closed).toBe(1)
})

test("optional metadata cannot block forever", async () => {
  expect(await optionalLookup(new Promise(() => {}), 10)).toBeUndefined()
})

test("optional metadata failures fall back without rejecting installation", async () => {
  expect(await optionalLookup(Promise.reject(new Error("offline")))).toBeUndefined()
  expect(await optionalLookup(Promise.resolve(["https://blossom.example"]))).toEqual([
    "https://blossom.example"
  ])
})
