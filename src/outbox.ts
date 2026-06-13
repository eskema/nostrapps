import { pool } from "@nostr/gadgets/global"
import { OutboxManager } from "@nostr/gadgets/outbox"
import { loadFollowsList } from "@nostr/gadgets/lists"
import { NostrEvent } from "@nostr/tools/core"
import { getStore } from "./store"

export const FALLBACK_RELAYS = ["relay.damus.io", "relay.primal.net", "nos.lol"]
const DEFAULT_KINDS = [1, 1111]

export let outbox: OutboxManager
setTimeout(() => {
  outbox = new OutboxManager(getStore(), {
    pool,
    label: "nostrapps",
    onsyncupdate(pubkey) {
      console.debug(":: synced updating", pubkey)
      for (let i = 0; i < current.onsync.length; i++) {
        current.onsync[i](pubkey)
      }
    },
    onbeforeupdate(pubkey) {
      console.debug(":: before updating", pubkey)
      for (let i = 0; i < current.onbefore.length; i++) {
        current.onbefore[i](pubkey)
      }
    },
    onliveupdate(event) {
      console.debug(":: live", event)
      for (let i = 0; i < current.onnew.length; i++) {
        current.onnew[i](event)
      }
    },
    defaultRelaysForConfusedPeople: FALLBACK_RELAYS,
    storeRelaysSeenOn: true
  })
}, 0)

let liveTargets: string[] = []
let controller: AbortController | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined

function restart() {
  if (!liveTargets.length) return
  resetPromises()
  outbox.close()
  startInternal()
}

export function stopOutbox() {
  controller?.abort()
  controller = undefined
  outbox.close()
  clearInterval(refreshTimer)
  refreshTimer = undefined
  liveTargets = []
  resetPromises()
}

export const current: {
  onsync: Array<(pubkey: string) => void>
  onbefore: Array<(pubkey: string) => void>
  onnew: Array<(event: NostrEvent) => void>
} = { onsync: [], onbefore: [], onnew: [] }

let isReady: () => void
let _ready: Promise<void>

function resetPromises() {
  _ready = new Promise<void>(resolve => {
    isReady = resolve
  })
}

resetPromises()

export async function ready(): Promise<void> {
  return _ready
}

const startedListeners: ((len: number) => void)[] = []
export function onStarted(cb: (len: number) => void) {
  startedListeners.push(cb)
}

export async function startOutbox(pubkey: string) {
  controller?.abort()
  outbox.close()
  clearInterval(refreshTimer)
  refreshTimer = undefined

  resetPromises()

  let followings: string[] = []
  try {
    const result = await loadFollowsList(pubkey)
    followings = result.items
  } catch (err) {
    console.warn("failed to load follows list", err)
  }
  liveTargets = [pubkey, ...followings]

  controller = new AbortController()

  startInternal()
  refreshTimer = setInterval(restart, 1000 * 60 * 20 /* 20 minutes */)
}

async function startInternal() {
  const signal = controller!.signal

  startedListeners.forEach(cb => cb(liveTargets.length))

  if (0 === (await getStore().queryEvents({}, 1)).length) {
    // this means the database has no events.
    // let's wait some time to do our first sync, as the user right now is likely to
    // be doing the preliminary fallback query and we don't want to interfere with it
    await new Promise(resolve => setTimeout(resolve, 15000))
  }

  await outbox.sync(liveTargets, DEFAULT_KINDS, {
    signal
  })

  isReady()

  outbox.live(liveTargets, DEFAULT_KINDS, { signal: undefined })
}
