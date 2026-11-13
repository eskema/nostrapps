import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { readBoundedBlob } from "./download.js"

export const NAPPLET_MAX_BYTES = 8 * 1024 * 1024
const CACHE_NAME = "nostrapps-napplet-artifacts-v1"
const BUDGET = 32 * 1024 * 1024
const memory = new Map<string, Blob>()
let writing = Promise.resolve()
const key = (hash: string) => new URL(`/__napplet-artifacts/${hash}`, location.origin).href

function remember(hash: string, blob: Blob) {
  memory.delete(hash)
  memory.set(hash, blob)
  let size = [...memory.values()].reduce((sum, value) => sum + value.size, 0)
  for (const [oldest, value] of memory) {
    if (size <= BUDGET) break
    memory.delete(oldest)
    size -= value.size
  }
}

// Persistent entries are untrusted: check both size and hash before reuse.
// Memory holds only verified, immutable Blobs.
export async function cachedArtifact(hash: string): Promise<Blob | undefined> {
  const hit = memory.get(hash)
  if (hit) {
    remember(hash, hit)
    return hit
  }
  try {
    const cache = await caches.open(CACHE_NAME)
    const response = await cache.match(key(hash))
    if (!response) return
    const blob = await readBoundedBlob(response, NAPPLET_MAX_BYTES)
    const actual = bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer())))
    if (actual !== hash) {
      await cache.delete(key(hash))
      return
    }
    remember(hash, blob)
    return blob
  } catch {
    // Unavailable storage or a bad entry is a cache miss, not a load failure.
  }
}

// Call only with a verified artifact. Blob values are immutable.
export function cacheArtifact(hash: string, blob: Blob) {
  if (blob.size > NAPPLET_MAX_BYTES) return
  remember(hash, blob)
  writing = writing
    .then(async () => {
      const cache = await caches.open(CACHE_NAME)
      await cache.delete(key(hash))
      await cache.put(
        key(hash),
        new Response(blob, { headers: { "content-length": String(blob.size) } })
      )
      let total = 0
      for (const request of [...(await cache.keys())].reverse()) {
        const response = await cache.match(request)
        total += Number(response?.headers.get("content-length") ?? BUDGET + 1)
        if (total > BUDGET) await cache.delete(request)
      }
    })
    .catch(() => {}) // Quota/private mode failures leave memory caching usable.
}
