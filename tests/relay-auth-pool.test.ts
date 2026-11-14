import { afterEach, expect, test } from "bun:test"
import { AbstractSimplePool } from "@nostr/tools/abstract-pool"
import { configureRelayAuth } from "../src/relay-auth-pool"

class Socket {
  static instances: Socket[] = []
  static initialNotice = false
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: object) => void
  sent: any[][] = []
  authenticated = false
  constructor() {
    Socket.instances.push(this)
    queueMicrotask(() => {
      this.onopen?.()
      this.receive(["AUTH", "test-challenge"])
      if (Socket.initialNotice) this.receive(["NOTICE", "auth-required: login"])
    })
  }
  receive(message: any[]) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  send(raw: string) {
    const message = JSON.parse(raw)
    this.sent.push(message)
    if (message[0] === "AUTH") {
      this.authenticated = true
      this.receive(["OK", message[1].id, true, ""])
    } else if (message[0] === "REQ") {
      this.receive(
        this.authenticated ? ["EOSE", message[1]] : ["CLOSED", message[1], "auth-required: login"]
      )
    } else if (message[0] === "EVENT") {
      this.receive([
        "OK",
        message[1].id,
        this.authenticated,
        this.authenticated ? "" : "auth-required: login"
      ])
    }
  }
  close() {
    this.onclose?.({})
  }
}

const pools: AbstractSimplePool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.destroy()
  Socket.instances = []
  Socket.initialNotice = false
})
function setup() {
  const drafts: any[] = []
  const signer = async (draft: any) => {
    drafts.push(draft)
    return { ...draft, id: "a".repeat(64), pubkey: "b".repeat(64), sig: "c".repeat(128) }
  }
  const pool = new AbstractSimplePool({
    verifyEvent: (() => true) as any,
    websocketImplementation: Socket as any,
    maxWaitForConnection: 1000
  })
  pools.push(pool)
  configureRelayAuth(pool, signer as any)
  return { pool, drafts, signer }
}
const url = "wss://relay.example/"
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test("a challenge alone never invokes the signer", async () => {
  const { pool, drafts } = setup()
  await pool.ensureRelay(url)
  await tick()
  expect(drafts).toHaveLength(0)
})

test("auth-required NOTICE uses the stored challenge, ordinary NOTICE does not", async () => {
  const { pool, drafts } = setup()
  await pool.ensureRelay(url)
  await tick()
  const socket = Socket.instances[0]
  socket.receive(["NOTICE", "hello"])
  await tick()
  expect(drafts).toHaveLength(0)
  socket.receive(["NOTICE", "auth-required: login"])
  socket.receive(["NOTICE", "auth-required: login"])
  await tick()
  expect(drafts).toHaveLength(1)
  expect(drafts[0].tags).toContainEqual(["challenge", "test-challenge"])
})

test("CLOSED authenticates and retries the subscription", async () => {
  const { pool, drafts } = setup()
  await new Promise<void>(resolve =>
    pool.subscribe([url], { kinds: [1] }, { onevent() {}, oneose: resolve })
  )
  expect(drafts).toHaveLength(1)
  expect(Socket.instances[0].sent.filter(m => m[0] === "REQ")).toHaveLength(2)
})

test("rejected OK preserves the operation-specific signer and retries publishing", async () => {
  const { pool, drafts, signer } = setup()
  let calls = 0
  const event = {
    id: "d".repeat(64),
    pubkey: "b".repeat(64),
    sig: "c".repeat(128),
    kind: 1,
    content: "",
    tags: [],
    created_at: 1
  }
  await Promise.all(
    pool.publish([url], event, {
      onauth: async draft => {
        calls++
        return signer(draft) as any
      }
    })
  )
  expect(calls).toBe(1)
  expect(drafts).toHaveLength(1)
  expect(Socket.instances[0].sent.filter(m => m[0] === "EVENT")).toHaveLength(2)
})

test("an initial auth-required NOTICE is handled before ensureRelay resolves", async () => {
  Socket.initialNotice = true
  const { pool, drafts } = setup()
  await pool.ensureRelay(url)
  await tick()
  expect(drafts).toHaveLength(1)
})
