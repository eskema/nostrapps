// A 64-char hex string (event id / pubkey). Anything reaching the redstore
// wasm as an id/author MUST match this: a malformed value panics query_events
// and poisons the store's mutex until the worker is respawned (store.ts) —
// and the list/metadata loaders save blank marker events carrying the pubkeys
// they were asked about, so garbage must not even reach those.
export const HEX64 = /^[0-9a-f]{64}$/i
export const isHex64 = (s: unknown): s is string => typeof s === "string" && HEX64.test(s)

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>
  let first = 0 // start of the current burst, 0 when idle

  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (!first) first = now
    clearTimeout(timer)
    // Fire `delay` after the last call, but never later than `delay` after
    // the burst's first — a steady stream can't starve the callback.
    timer = setTimeout(
      () => {
        first = 0
        fn(...args)
      },
      Math.max(0, Math.min(delay, first + delay - now))
    )
  }
}

// Per-relay publish outcomes, aligned with `relays` (pool.publish returns one
// promise per relay in order). "n/m relays" alone hides which relay is
// missing what.
export async function publishOutcomes(
  relays: string[],
  promises: Promise<string>[]
): Promise<{ relay: string; ok: boolean; reason: string }[]> {
  const settled = await Promise.allSettled(promises)
  return settled.map((r, i) => ({
    relay: relays[i],
    ok: r.status === "fulfilled",
    reason:
      r.status === "fulfilled" ? String(r.value ?? "") : (r.reason?.message ?? String(r.reason))
  }))
}
