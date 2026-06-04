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

export async function add(event: any) {
  return getStore().saveEvent(event)
}

export async function query(filters: unknown) {
  const list = Array.isArray(filters) ? filters : [filters]
  const batches = await Promise.all(list.map(f => getStore().queryEvents(f)))
  const seen = new Map()
  for (const batch of batches) {
    for (const e of batch as any[]) seen.set(e.id, e)
  }
  return [...seen.values()]
}

export async function count(filters: unknown) {
  const events = await query(filters)
  return events.length
}

export async function event(id: string) {
  const [e] = await getStore().queryEvents({ ids: [id], limit: 1 })
  return e
}

export async function replaceable(kind: number, author: string, identifier?: string) {
  const result = await getStore().loadReplaceables([[kind, author, identifier]])
  if (!result) return undefined
  const arr = result as unknown as any[]
  if (!arr[0]) return undefined
  const value = arr[0]?.[1]
  if (Array.isArray(value)) {
    return value.sort((a: any, b: any) => b.created_at - a.created_at)[0]
  }
  return value
}
