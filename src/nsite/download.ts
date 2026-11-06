import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

// A download refused for its size, as opposed to one that failed or was
// missing: callers report it as too large, not as unreachable.
export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File exceeds ${maxBytes / 1024 / 1024} MiB`)
    this.name = "BlobTooLargeError"
  }
}

// Check both declared and streamed sizes: Content-Length is only a hint.
export async function readBoundedBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new BlobTooLargeError(maxBytes)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Download has no body")
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new BlobTooLargeError(maxBytes)
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream"
  })
}

// The first server to return bytes matching `sha`, or null when none did.
// Throws BlobTooLargeError when no server succeeded and one refused for size.
export async function fetchBlob(
  servers: string[],
  sha: string,
  options: { maxBytes?: number; concurrency?: number } = {}
): Promise<Blob | null> {
  if (!/^[a-f0-9]{64}$/i.test(sha)) return null
  const candidates = [...new Set(servers.map(server => server.replace(/\/$/, "")))]
  // Ends the other workers' downloads once one has the blob.
  const downloads = new AbortController()
  let tooLarge: BlobTooLargeError | null = null
  let next = 0
  const worker = async (): Promise<Blob> => {
    while (next < candidates.length && !downloads.signal.aborted) {
      let server = candidates[next++]!
      try {
        server = server.startsWith("http") ? server : `https://${server}`
        // BUD-01 lets servers redirect to another URL for the same hash; the
        // hash is verified below, so following redirects is safe.
        const res = await fetch(`${server}/${sha}`, {
          signal: AbortSignal.any([downloads.signal, AbortSignal.timeout(10000)]),
          credentials: "omit",
          referrerPolicy: "no-referrer"
        })
        if (!res.ok) {
          await res.body?.cancel().catch(() => {})
          console.debug("[fetchBlob] miss", { server, sha, status: res.status })
          continue
        }
        const blob = options.maxBytes
          ? await readBoundedBlob(res, options.maxBytes)
          : await res.blob()
        const buf = await blob.arrayBuffer()
        if (bytesToHex(sha256(new Uint8Array(buf))) !== sha.toLowerCase()) {
          console.debug("[fetchBlob] hash mismatch", { server, sha })
          continue
        }
        return blob
      } catch (err) {
        if (downloads.signal.aborted) break // another server already won
        if (err instanceof BlobTooLargeError) {
          tooLarge = err
          console.debug("[fetchBlob] too large", { server, sha, maxBytes: err.maxBytes })
        } else {
          // network error / timeout — move on to the next server
          console.debug("[fetchBlob] error", { server, sha, err: String(err) })
        }
      }
    }
    throw new Error("No server returned verified bytes")
  }
  try {
    return await Promise.any(
      Array.from(
        { length: Math.min(candidates.length, Math.max(1, options.concurrency ?? 1)) },
        worker
      )
    )
  } catch {
    console.warn("[fetchBlob] all servers failed", { sha, servers: candidates })
    if (tooLarge) throw tooLarge
    return null
  } finally {
    downloads.abort()
  }
}
