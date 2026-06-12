import { setReplaceableStore } from "@nostr/gadgets/global"
import { RedEventStore } from "@nostr/gadgets/redstore"

let instance: RedEventStore | null

export function getStore() {
  if (!instance) {
    instance = new RedEventStore(null)
    setReplaceableStore(instance)
  }
  return instance
}

// Vite HMR: when this module reloads, the old RedEventStore worker still
// holds the OPFS access handle. Dispose it so the new instance can reopen
// the SQLite file. Without this, dev-mode HMR makes every nostrdb.* call
// hang behind a NoModificationAllowedError on the locked file.
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const old = instance
    instance = null
    if (!old) return
    try {
      await old.close()
    } catch {}
    try {
      // @ts-ignore
      old.worker?.terminate?.()
    } catch {}
  })
}
