// NIP-5D napplet resolution + verification. A napplet is a SINGLE self-contained
// /index.html, published as its own event kind (distinct from an nsite), fetched
// from Blossom and verified against the signed manifest before it ever runs.
import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { verifyEvent } from "@nostr/tools/pure"
import type { NostrEvent } from "@nostr/tools/core"
import { fetchBlob } from "./fetch.js"
import { FALLBACK_RELAYS } from "../outbox.js"

export const NAPPLET_SNAPSHOT_KIND = 5129
export const NAPPLET_ROOT_KIND = 15129
export const NAPPLET_NAMED_KIND = 35129
export const NAPPLET_KINDS = [NAPPLET_SNAPSHOT_KIND, NAPPLET_ROOT_KIND, NAPPLET_NAMED_KIND]
export function isNappletKind(kind: number): boolean {
  return NAPPLET_KINDS.includes(kind)
}

// NIP-5A aggregate hash: for each path tag a line "<sha256> <absolute-path>\n",
// sorted lexicographically, concatenated as UTF-8, then SHA-256 (lowercase hex).
export function computeAggregateHash(pathTags: string[][]): string {
  const lines = pathTags
    .filter(t => t[0] === "path" && t[1] && t[2])
    .map(t => `${t[2]} ${t[1].startsWith("/") ? t[1] : "/" + t[1]}\n`)
    .sort()
  return bytesToHex(sha256(new TextEncoder().encode(lines.join(""))))
}

export interface ResolvedNapplet {
  dTag: string
  pubkey: string
  html: string
  title: string | null
  requires: string[]
  manifest: NostrEvent
}

function latest(events: NostrEvent[]): NostrEvent | null {
  let best: NostrEvent | null = null
  for (const e of events) if (!best || e.created_at > best.created_at) best = e
  return best
}

// Resolve → verify → return the napplet's index.html bytes. The whole trust
// chain per NIP-5D: verify the manifest signature, fetch the index.html blob
// from Blossom by its sha256 (fetchBlob checks the hash), and recompute the
// NIP-5A aggregate against the manifest's `x` tag. Any failure throws.
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
  if (!verifyEvent(manifest)) throw new Error("napplet manifest signature is invalid")

  const pathTags = manifest.tags.filter(t => t[0] === "path" && t.length >= 3 && t[1] && t[2])
  if (pathTags.length === 0) throw new Error("napplet manifest has no path tags")

  // Content-address integrity: the manifest's path set must hash to its x tag.
  const xTag = manifest.tags.find(t => t[0] === "x" && t[2] === "aggregate")
  if (xTag && computeAggregateHash(pathTags) !== xTag[1]) {
    throw new Error("napplet aggregate hash mismatch — manifest tampered")
  }

  const indexTag = pathTags.find(
    t => (t[1].startsWith("/") ? t[1] : "/" + t[1]) === "/index.html"
  )
  if (!indexTag) throw new Error("napplet manifest has no /index.html path")

  const manifestServers = manifest.tags.filter(t => t[0] === "server" && t[1]).map(t => t[1])
  const userServers = pubkey ? ((await loadBlossomServers(pubkey)).items ?? []) : []
  const servers = [
    "relay.nostrapps.com",
    ...new Set(userServers),
    ...new Set(manifestServers)
  ].filter(Boolean) as string[]

  onProgress("Fetching napplet /index.html…")
  const blob = await fetchBlob(servers, indexTag[2]) // verifies sha256(blob) === hash
  if (!blob) throw new Error(`Could not fetch napplet index.html (${indexTag[2]})`)

  return {
    dTag: manifest.tags.find(t => t[0] === "d")?.[1] || dTag,
    pubkey: manifest.pubkey,
    html: await blob.text(),
    title: manifest.tags.find(t => t[0] === "title")?.[1] ?? null,
    requires: manifest.tags.filter(t => t[0] === "requires" && t[1]).map(t => t[1]),
    manifest
  }
}
