import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

// Check both declared and streamed sizes: Content-Length is only a hint.
export async function readBoundedBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`File exceeds ${maxBytes / 1024 / 1024} MiB`)
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
      if (size > maxBytes) throw new Error(`File exceeds ${maxBytes / 1024 / 1024} MiB`)
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type") || "application/octet-stream"
  })
}

export async function fetchBlob(
  servers: string[],
  sha: string,
  options: { signal?: AbortSignal; maxBytes?: number; concurrency?: number } = {}
): Promise<Blob | null> {
  if (!/^[a-f0-9]{64}$/i.test(sha)) return null
  options.signal?.throwIfAborted()
  const candidates = [...new Set(servers.map(server => server.replace(/\/$/, "")))]
  const downloads = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, downloads.signal])
    : downloads.signal
  let next = 0
  const worker = async (): Promise<Blob> => {
    while (next < candidates.length) {
      signal.throwIfAborted()
      let server = candidates[next++]!
      try {
        server = server.startsWith("http") ? server : `https://${server}`
        const res = await fetch(`${server}/${sha}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error"
        })
        if (!res.ok) {
          await res.body?.cancel()
          continue
        }
        const blob = options.maxBytes
          ? await readBoundedBlob(res, options.maxBytes)
          : await res.blob()
        const buf = await blob.arrayBuffer()
        signal.throwIfAborted()
        if (bytesToHex(sha256(new Uint8Array(buf))) !== sha.toLowerCase()) continue
        return blob
      } catch {
        signal.throwIfAborted()
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
    options.signal?.throwIfAborted()
    return null
  } finally {
    downloads.abort()
  }
}
