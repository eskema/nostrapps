import type { AbstractRelay } from "@nostr/tools/abstract-relay"
import { normalizeURL } from "@nostr/tools/utils"
import type { pool as sharedPool } from "@nostr/gadgets/global"

// Publishing over the shared pool, made to outlast a socket that died
// quietly. nostr-tools gives a relay 4.4s to answer an EVENT and keeps using a
// connection until its ping (every 29s, 20s to answer) finds it dead, so for
// up to ~50s after a sleep or a network change every publish to that relay —
// a retry too — "times out" while the relay itself is fine. Here a relay gets
// 10s to answer, and a publish that still times out checks the connection: one
// that doesn't answer a dummy REQ is closed, and the event goes once more, on
// a fresh connection when it was closed. The relay takes a repeat as a
// duplicate, so a slow write that did land costs nothing.

type Pool = typeof sharedPool

const PUBLISH_TIMEOUT = 10_000
const PROBE_TIMEOUT = 4_000

export function hardenPublish(pool: Pool) {
  const ensureRelay = pool.ensureRelay.bind(pool)
  pool.ensureRelay = async (url, params) => {
    const relay = await ensureRelay(url, params)
    relay.publishTimeout = PUBLISH_TIMEOUT
    return relay
  }

  const publish = pool.publish.bind(pool)
  pool.publish = (relays, event, params) =>
    publish(relays, event, params).map((sent, i) =>
      sent.catch(async err => {
        if (!(err instanceof Error && err.message === "publish timed out")) throw err
        const url = normalizeURL(relays[i])
        if (!(await answers(pool, url))) pool.close([url])
        return publish([url], event, params)[0]
      })
    )
}

// Whether the connection to a relay still carries anything: a REQ for an id
// that can't exist, answered with EOSE (alive) or not in time (dead).
async function answers(pool: Pool, url: string): Promise<boolean> {
  let relay: AbstractRelay
  try {
    relay = await pool.ensureRelay(url, { connectionTimeout: PROBE_TIMEOUT })
  } catch {
    return false
  }
  return new Promise(resolve => {
    let settled = false
    let sub: { close(): void } | undefined
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(alive)
      sub?.close()
    }
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT)
    try {
      sub = relay.subscribe([{ ids: ["0".repeat(64)] }], {
        oneose: () => done(true),
        onclose: () => done(false)
      })
    } catch {
      done(false)
    }
  })
}
