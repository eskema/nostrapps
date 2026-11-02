import type { SubscribeManyParams, SubCloser } from "@nostr/tools/abstract-pool"
import type { NostrEvent } from "@nostr/tools/core"
import type { Filter } from "@nostr/tools/filter"

interface RelayPool {
  subscribeMap(
    requests: Array<{ url: string; filter: Filter }>,
    params: SubscribeManyParams
  ): SubCloser
}

// maxWait alone does not bound discovery, connection, or missing callbacks.
export async function queryManifestEvents(
  pool: RelayPool,
  relays: string[],
  filter: Filter,
  { timeoutMs = 6000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<NostrEvent[]> {
  signal?.throwIfAborted()
  if (!relays.length) return []
  const events = await new Promise<NostrEvent[]>((resolve, reject) => {
    const events: NostrEvent[] = []
    const lifetime = new AbortController()
    let subscription: SubCloser | undefined
    let done = false
    const finish = (error?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      lifetime.abort()
      void Promise.resolve(subscription?.close()).catch(() => {})
      if (error) reject(error)
      else resolve(events)
    }
    const abort = () => finish(signal?.reason ?? new DOMException("Cancelled", "AbortError"))
    const timer = setTimeout(() => finish(), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    try {
      subscription = pool.subscribeMap(
        relays.map(url => ({ url, filter })),
        {
          label: "napplet-manifest",
          maxWait: timeoutMs,
          abort: lifetime.signal,
          onevent: event => {
            if (!done) events.push(event)
          },
          oneose: () => finish(),
          onclose: () => finish()
        }
      )
      if (done) void Promise.resolve(subscription.close()).catch(() => {})
    } catch (error) {
      finish(error)
    }
  })
  signal?.throwIfAborted()
  return events
}

// Optional discovery may improve routing, but must never gate a download.
export function optionalLookup<T>(lookup: Promise<T>, timeoutMs = 1500): Promise<T | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    lookup.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      }
    )
  })
}
