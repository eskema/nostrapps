// NIP-5D napplet resolution + verification. A napplet is a SINGLE self-contained
// /index.html, published as its own event kind (distinct from an nsite), fetched
// from Blossom by the manifest's x tag and verified before it ever runs.
import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { verifyEvent } from "../verify.js"
import type { NostrEvent } from "@nostr/tools/core"
import { fetchBlob } from "./fetch.js"
import { healNapp } from "./heal.js"
import { FALLBACK_RELAYS } from "../relay-health.js"

export const NAPPLET_SNAPSHOT_KIND = 5129
export const NAPPLET_ROOT_KIND = 15129
export const NAPPLET_NAMED_KIND = 35129
export const NAPPLET_KINDS = [NAPPLET_SNAPSHOT_KIND, NAPPLET_ROOT_KIND, NAPPLET_NAMED_KIND]
export function isNappletKind(kind: number): boolean {
  return NAPPLET_KINDS.includes(kind)
}

// A napplet manifest in the old shape (path tags and an aggregate x tag). It
// carries one x tag too, but that names no blob: such a napplet can't load,
// its author has to republish it.
export function isOldNappletFormat(event: { kind: number; tags: string[][] }): boolean {
  return (
    isNappletKind(event.kind) &&
    event.tags.some(t => t[0] === "path" || (t[0] === "x" && t[2] === "aggregate"))
  )
}

// A napplet splits its domains into R (needed for full functionality) and O
// (optional, never in the way of loading); a napp lists all of them as requires.
export function nappletDomains(event: { tags: string[][] }): {
  required: string[]
  optional: string[]
} {
  const pick = (k: string) => [
    ...new Set(
      event.tags.filter(t => t[0] === k && typeof t[1] === "string" && t[1]).map(t => t[1])
    )
  ]
  return { required: pick("R"), optional: pick("O") }
}

// Every domain a manifest declares, whichever way its kind spells them.
export function declaredDomains(event: { kind: number; tags: string[][] }): string[] {
  if (!isNappletKind(event.kind))
    return event.tags
      .filter(t => t[0] === "requires" && typeof t[1] === "string" && t[1])
      .map(t => t[1])
  const { required, optional } = nappletDomains(event)
  return [...new Set([...required, ...optional])]
}

// The declared domains whose absence is a problem: a napplet's R, a napp's all.
export function requiredDomains(event: { kind: number; tags: string[][] }): string[] {
  return isNappletKind(event.kind) ? nappletDomains(event).required : declaredDomains(event)
}

// A napplet's description is its event content; a napp's, its description tag.
export function manifestDescription(event: {
  kind: number
  tags: string[][]
  content?: string
}): string | null {
  if (isNappletKind(event.kind)) return event.content?.trim() || null
  return event.tags.find(t => t[0] === "description")?.[1] || null
}

export const NAPPLET_ICON_MIMES = ["image/png", "image/jpeg", "image/webp"]

// Whether the bytes open the way the named format does: the mime a manifest or
// a data: url names is a claim, not the format.
export function isImageOfType(bytes: Uint8Array, mime: string): boolean {
  const at = (i: number, ...b: number[]) => b.every((v, j) => bytes[i + j] === v)
  if (mime === "image/png") return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  if (mime === "image/jpeg") return at(0, 0xff, 0xd8, 0xff)
  if (mime === "image/webp") return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)
  return false
}

// Authoring metadata for a single-file napplet, read from the html head — a
// napplet has no metadata.json. `napplet` is the explicit opt-in: any
// napplet/napplet-* meta marks the file (a lone index.html could just as well
// be a single-file nsite). The NIP-5D publishing mapping: <title> → title,
// <meta name="description"> → content, napplet-id → d, napplet-requires and
// napplet-optional → R and O, napplet-archetype → z, napplet-intent → i,
// napplet-source → source, napplet-server → server, <link rel="icon"> → icon.
// Lists split on whitespace, and on commas as older tooling wrote them; the
// bare id/requires names are also accepted.
export function nappletMetaFromHtml(html: string): {
  napplet: boolean
  id: string | null
  title: string | null
  description: string | null
  requires: string[]
  optional: string[]
  archetypes: string[]
  intents: string[][]
  source: string | null
  servers: string[]
  // A local folder's icon as an <img> src (data:/https only); the raw href is
  // what a publish turns into the icon blob.
  icon: string | null
  iconHref: string | null
} {
  const metas = (name: string) => {
    const out: string[] = []
    const re = new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']?${name}(?=["'\\s/>])[^>]*>`, "gi")
    for (const [tag] of html.matchAll(re)) {
      const m = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
      const v = m ? (m[1] ?? m[2]).trim() : ""
      if (v) out.push(v)
    }
    return out
  }
  const meta = (name: string) => metas(name)[0] ?? null
  const list = (name: string) => [
    ...new Set(
      metas(name)
        .flatMap(v => v.split(/[,\s]+/))
        .filter(Boolean)
    )
  ]
  const iconTag = /<link\b[^>]*\brel\s*=\s*["']?[^"'>]*icon[^"'>]*["']?[^>]*>/i.exec(html)?.[0]
  const iconHref = iconTag
    ? (/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(iconTag)?.[1] ?? null)
    : null
  const requires = list("napplet-requires")
  return {
    napplet: /<meta\b[^>]*\bname\s*=\s*["']?napplet(-[a-z]+)?["'\s/>]/i.test(html),
    id: meta("napplet-id") || meta("id"),
    title: /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].trim() || null,
    description: meta("description"),
    requires: requires.length ? requires : list("requires"),
    optional: list("napplet-optional"),
    archetypes: [...new Set(metas("napplet-archetype"))],
    intents: metas("napplet-intent").map(v => v.split(/\s+/)),
    source: meta("napplet-source"),
    servers: metas("napplet-server"),
    icon: iconHref && /^(data:|https:)/.test(iconHref) ? iconHref : null,
    iconHref
  }
}

// The icon a napplet publishes, from its html's <link rel="icon">: the bytes of
// an inline png/jpeg/webp data: url, uploaded as they are so the html and the
// manifest name the same picture. Anything else is left out, with why.
export function nappletIconFromHref(
  href: string | null
): { bytes: Uint8Array<ArrayBuffer>; mime: string } | { note: string } | null {
  if (!href) return null
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/i.exec(href)
  if (!m)
    return { note: "left out: only an inline data: url (png, jpeg or webp) can be a napplet icon" }
  const mime = m[1].trim().toLowerCase()
  const short = mime.replace(/^image\//, "").replace(/\+xml$/, "") || "that format"
  if (!NAPPLET_ICON_MIMES.includes(mime))
    return { note: `left out: a napplet icon is png, jpeg or webp, not ${short}` }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    if (/;base64/i.test(m[2])) {
      bytes = Uint8Array.from(atob(m[3].replace(/\s+/g, "")), c => c.charCodeAt(0))
    } else {
      const s = m[3]
      const out: number[] = []
      for (let i = 0; i < s.length; i++) {
        const hex = s.slice(i + 1, i + 3)
        if (s[i] === "%" && /^[0-9a-f]{2}$/i.test(hex)) {
          out.push(parseInt(hex, 16))
          i += 2
        } else out.push(s.charCodeAt(i) & 0xff)
      }
      bytes = new Uint8Array(out)
    }
  } catch {
    return { note: "left out: its data: url doesn't decode" }
  }
  if (!isImageOfType(bytes, mime)) return { note: `left out: its bytes aren't a ${short}` }
  return { bytes, mime }
}

export interface ResolvedNapplet {
  dTag: string
  pubkey: string
  html: string
  // The verified bytes as fetched (html is their text): what a share re-uploads.
  body: Blob
  title: string | null
  domains: string[]
  manifest: NostrEvent
}

function latest(events: NostrEvent[]): NostrEvent | null {
  let best: NostrEvent | null = null
  for (const e of events) if (!best || e.created_at > best.created_at) best = e
  return best
}

// Resolve → verify → return the napplet's index.html bytes. The whole trust
// chain per NIP-5D: verify the manifest signature, then fetch the blob its one
// `x` tag names from Blossom (fetchBlob checks the hash). Any failure throws.
export async function resolveNapplet(
  target: { pubkey: string; kind: number; dTag: string; relayHints: string[]; id?: string },
  onProgress: (m: string) => void = () => {}
): Promise<ResolvedNapplet> {
  const { pubkey, kind, dTag, relayHints, id } = target
  onProgress("Querying relays for napplet…")

  let relays = relayHints.length ? relayHints : FALLBACK_RELAYS
  if (!relayHints.length && pubkey) {
    try {
      const w = (await loadRelayList(pubkey)).items.filter(r => r.write).map(r => r.url)
      if (w.length) relays = w
    } catch {}
  }

  const filter: any = id
    ? { ids: [id] }
    : { kinds: [kind], authors: [pubkey], ...(dTag ? { "#d": [dTag] } : {}) }
  const manifest = latest(await pool.querySync(relays, filter, { maxWait: 6000 }))
  if (!manifest) throw new Error("napplet manifest not found")
  return loadNappletFromManifest(manifest, onProgress, { healRelays: relays })
}

// The verify + fetch half, given the manifest event we already hold — used both
// by resolveNapplet (after the relay query) and on RESTORE, where the launcher
// already has the stored manifest and just needs to re-fetch + re-verify the
// bytes (content-addressed: never trust a cached document, re-verify each load).
export async function loadNappletFromManifest(
  manifest: NostrEvent,
  onProgress: (m: string) => void = () => {},
  // healRelays marks a fresh resolve (install/update): heal fires there, never
  // on the RESTORE re-verify, which runs on every launch.
  opts: { healRelays?: string[] } = {}
): Promise<ResolvedNapplet> {
  if (!verifyEvent(manifest)) throw new Error("napplet manifest signature is invalid")

  // Turned away here rather than asking every server for a blob that isn't one.
  if (isOldNappletFormat(manifest)) {
    throw new Error("napplet published in the old format, its author has to republish it")
  }
  const xTags = manifest.tags.filter(t => t[0] === "x")
  if (xTags.length !== 1 || !/^[0-9a-f]{64}$/.test(xTags[0][1] ?? "")) {
    throw new Error("napplet manifest needs exactly one x tag")
  }
  const artifactHash = xTags[0][1]

  const pubkey = manifest.pubkey
  const manifestServers = manifest.tags.filter(t => t[0] === "server" && t[1]).map(t => t[1])
  const userServers = pubkey ? ((await loadBlossomServers(pubkey)).items ?? []) : []
  const servers = [
    "relay.nostrapps.com",
    ...new Set(userServers),
    ...new Set(manifestServers)
  ].filter(Boolean) as string[]

  onProgress("Fetching napplet…")
  const blob = await fetchBlob(servers, artifactHash) // verifies sha256(blob) === hash
  if (!blob) throw new Error(`Could not fetch napplet (${artifactHash})`)

  if (opts.healRelays?.length) {
    healNapp({
      manifest,
      relays: opts.healRelays,
      servers,
      files: [{ sha: artifactHash, body: blob, mime: "text/html" }]
    })
  }

  return {
    dTag: manifest.tags.find(t => t[0] === "d")?.[1] || "",
    pubkey,
    html: await blob.text(),
    body: blob,
    title: manifest.tags.find(t => t[0] === "title")?.[1] ?? null,
    domains: declaredDomains(manifest),
    manifest
  }
}
