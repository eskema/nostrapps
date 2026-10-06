// http_fetch and http_fetch_image: the web, for a napp with no page.
//
// A web napp granted `network` reaches the web with its own fetch(). A wasm
// napp has no fetch and no sockets, so the launcher makes the request for it
// and hands back what came: the raw response for http_fetch, and for
// http_fetch_image the picture already decoded, so a napp can show an avatar
// without carrying a png, jpeg, gif and webp decoder in its module.
//
// The request is the launcher's own fetch, so the browser's rules apply to it
// the way they would to the napp's: a server that sends no CORS headers
// cannot be read from here either.

/** The biggest body either call reads, so a napp cannot fill memory. */
const MAX_BODY = 16 << 20

/** The longest side a decoded image is handed over at, absent a size. */
const MAX_SIDE = 1024

const TIMEOUT_MS = 20_000

export type HttpFetchParams = {
  url: string
  method?: string
  headers?: Record<string, string>
  /** utf-8 text; a napp sending bytes base64s them itself. */
  body?: string
}

export type HttpFetchResult = {
  status: number
  url: string
  headers: Record<string, string>
  /** The response body, base64: JSON has no bytes. */
  body: string
}

/** httpFetch is http_fetch: one request, the whole response back. */
export async function httpFetch(params: unknown): Promise<HttpFetchResult> {
  const p = (typeof params === "string" ? { url: params } : params) as HttpFetchParams
  const url = webUrl(p?.url)
  const headers: Record<string, string> = {}
  if (p.headers && typeof p.headers === "object") {
    for (const [k, v] of Object.entries(p.headers)) if (typeof v === "string") headers[k] = v
  }
  const res = await timedFetch(url, {
    method: typeof p.method === "string" && p.method ? p.method.toUpperCase() : "GET",
    headers,
    body: typeof p.body === "string" ? p.body : undefined
  })
  const bytes = await readCapped(res)
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => (out[k] = v))
  return { status: res.status, url: res.url || url, headers: out, body: base64(bytes) }
}

export type HttpImageParams = {
  url: string
  width?: number
  height?: number
  /** contain (the default) fits inside width×height; cover fills it exactly. */
  fit?: "contain" | "cover"
}

/**
 * httpFetchImage is http_fetch_image: the image at url, decoded and scaled,
 * as the bitmap message's bytes — width and height as little-endian u32s,
 * then RGBA rows top-down, alpha not premultiplied.
 */
export async function httpFetchImage(params: unknown): Promise<Uint8Array> {
  const p = (typeof params === "string" ? { url: params } : params) as HttpImageParams
  const url = webUrl(p?.url)
  const res = await timedFetch(url, {})
  if (!res.ok) throw new Error(`http_fetch_image: HTTP ${res.status}`)
  const blob = new Blob([await readCapped(res)], {
    type: res.headers.get("content-type") || ""
  })
  const source = await decode(blob)
  try {
    const sw = source.width
    const sh = source.height
    if (!sw || !sh) throw new Error("http_fetch_image: the image is empty")
    const { sx, sy, sWidth, sHeight, width, height } = placement(sw, sh, p)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("http_fetch_image: no 2d canvas to decode on")
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, width, height)
    // getImageData is unpremultiplied RGBA, which is what the message carries.
    const pixels = ctx.getImageData(0, 0, width, height).data

    const out = new Uint8Array(8 + pixels.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, width, true)
    view.setUint32(4, height, true)
    out.set(pixels, 8)
    return out
  } finally {
    if ("close" in source) source.close()
  }
}

/**
 * placement is which part of the source gets drawn and at what size. contain
 * scales the whole image into the box, never up; cover scales it to fill the
 * box and crops what overhangs, evenly on both sides — a square avatar out of
 * a portrait photo. A box with one side left out is a square.
 */
function placement(sw: number, sh: number, p: HttpImageParams) {
  const side = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 4096) : 0
  let bw = side(p.width)
  let bh = side(p.height)
  if (p.fit === "cover" && (bw || bh)) {
    bw ||= bh
    bh ||= bw
    const scale = Math.max(bw / sw, bh / sh)
    const sWidth = Math.min(sw, bw / scale)
    const sHeight = Math.min(sh, bh / scale)
    return {
      sx: (sw - sWidth) / 2,
      sy: (sh - sHeight) / 2,
      sWidth,
      sHeight,
      width: bw,
      height: bh
    }
  }
  bw ||= MAX_SIDE
  bh ||= MAX_SIDE
  const scale = Math.min(1, bw / sw, bh / sh)
  return {
    sx: 0,
    sy: 0,
    sWidth: sw,
    sHeight: sh,
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale))
  }
}

/** decode turns the bytes into something drawable: an ImageBitmap, or for
 * what createImageBitmap refuses (SVG, in most browsers) an <img>. */
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(blob)
  } catch {}
  const src = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = src
    await img.decode()
    return img
  } catch {
    throw new Error("http_fetch_image: not an image this launcher can decode")
  } finally {
    URL.revokeObjectURL(src)
  }
}

function webUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error("http_fetch: url must be a string")
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`http_fetch: not a url: ${raw}`)
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`http_fetch: only http and https urls, not ${u.protocol}`)
  }
  return u.href
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer"
    })
  } catch (err) {
    throw new Error(
      ctrl.signal.aborted
        ? `http_fetch: ${url} took too long`
        : `http_fetch: ${url} could not be reached (${err instanceof Error ? err.message : err})`
    )
  } finally {
    clearTimeout(timer)
  }
}

/** readCapped reads the body, refusing one over MAX_BODY. */
async function readCapped(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(res.headers.get("content-length"))
  if (declared > MAX_BODY) throw new Error(`http_fetch: the response is over ${MAX_BODY >> 20}MB`)
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BODY) {
      void reader.cancel()
      throw new Error(`http_fetch: the response is over ${MAX_BODY >> 20}MB`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function base64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}
