import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

function bridge() {
  const sent: any[] = []
  let receive: (event: any) => void = () => {}
  const parent = { postMessage: (message: any) => sent.push(structuredClone(message)) }
  const window: any = {
    parent,
    __nappletDomains: ["relay"],
    addEventListener: (_: string, listener: typeof receive) => {
      receive = listener
    }
  }
  runInNewContext(readFileSync(new URL("../public/napplet-bridge.js", import.meta.url), "utf8"), {
    window,
    document: { readyState: "complete", addEventListener() {} }
  })
  return {
    relay: window.napplet.relay,
    sent,
    deliver: (data: any) => receive({ source: parent, data })
  }
}

test("SDK relay subscriptions keep callbacks local and deliver result envelopes", () => {
  const { relay, sent, deliver } = bridge()
  const received: any[] = []
  let eose = 0
  const sub = relay.subscribe(
    { kinds: [1] },
    (result: any) => received.push(result),
    () => eose++,
    {
      relay: "wss://relay.example"
    }
  )
  const request = sent.find(message => message.type === "relay.subscribe")
  expect(request.filters).toEqual([{ kinds: [1] }])
  expect(request.relay).toBe("wss://relay.example")
  expect(typeof request.subId).toBe("string")
  const result = { event: { id: "event" }, sidecar: { resources: {} } }
  deliver({ type: "relay.event", subId: request.subId, result })
  deliver({ type: "relay.eose", subId: request.subId })
  expect(received).toEqual([result])
  expect(eose).toBe(1)
  sub.close()
  expect(sent.at(-1)).toMatchObject({ type: "relay.close", subId: request.subId })
  deliver({ type: "relay.event", subId: request.subId, result })
  expect(received).toHaveLength(1)
})

test("legacy relay subscriptions retain event and close callbacks", () => {
  const { relay, deliver } = bridge()
  const received: any[] = []
  relay.subscribe("legacy", [{ kinds: [1] }], {
    onEvent: (event: any) => received.push(event),
    onClosed: (reason: string) => received.push(reason)
  })
  deliver({ type: "relay.event", subId: "legacy", result: { event: { id: "event" } } })
  deliver({ type: "relay.closed", subId: "legacy", reason: "denied" })
  expect(received).toEqual([{ id: "event" }, "denied"])
})
