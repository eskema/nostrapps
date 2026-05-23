import { pool } from "@nostr/gadgets/global"
import { guessMime } from "./mime.js"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { currentSigner } from "../signers/index.js"
import { Filter } from "@nostr/tools/filter"
import { NostrEvent } from "@nostr/tools/pure"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

const NSITE_NAMED_KIND = 35128
const NSITE_LISTING_KIND = 37348

const COLLECT_TIMEOUT_MS = 10000

export async function fetchNsite(
  target: { pubkey: string; dTag: string; relayHints: string[] },
  onProgress: (msg: string) => void = () => {}
) {
  console.debug("fetching nsite", target)

  const { pubkey, dTag, relayHints } = target
  if (!pubkey) throw new Error("fetchNsite: no pubkey")

  // 1. build filter from input
  const filter: Filter = { kinds: [NSITE_NAMED_KIND, NSITE_LISTING_KIND], "#d": [dTag] }

  onProgress("Querying relays…")

  // 2. resolve relays via loadRelayList + fallback
  const relayList = await loadRelayList(pubkey)
  const relayUrls = relayList.items.filter(r => r.write).map((r: { url: string }) => r.url)
  const relays = [...relayHints, ...relayUrls]
  const reqs = relays.map((url: string) => ({ url, filter }))

  // 3. collect events
  const events = await collect(reqs)

  // 4. find manifest
  const manifest = latest(events)
  if (!manifest) throw new Error(`nsite "${dTag}" not found`)

  // 5b. have manifest — extract listing and download files
  const manifestDTag = getTag(manifest, "d") || ""
  const listing = findListing(events, pubkey, manifestDTag)
  const nappId = `${pubkey.slice(0, 40)}-${dTag}`

  const pathTags = manifest.tags.filter(
    (t: string[]) => t[0] === "path" && t.length >= 3 && t[1] && t[2]
  )
  if (pathTags.length === 0) throw new Error("nsite manifest has no path tags")

  const manifestServers = manifest.tags
    .filter((t: string[]) => t[0] === "server" && t[1])
    .map((t: string[]) => t[1])
  const userServers = (await loadBlossomServers(pubkey)).items ?? []
  const servers = [...new Set([...manifestServers, ...userServers])].filter(Boolean)

  const files = []
  for (let i = 0; i < pathTags.length; i++) {
    const tag = pathTags[i]
    const path = tag[1].startsWith("/") ? tag[1] : `/${tag[1]}`
    const sha = tag[2]
    const mime = tag[3] || guessMime(path)
    onProgress(`Fetching ${i + 1}/${pathTags.length}: ${path}`)
    const blob = await fetchBlob(servers, sha)
    if (!blob) throw new Error(`Could not fetch ${path} (${sha})`)
    files.push({ path, body: blob, mime })
  }

  const title = localizedTag(listing, "name") || getTag(manifest, "title")

  return { nappId, files, title, manifest, listing }
}

// ─── helpers ──────────────────────────────────────────────────────

function collect(reqs: Array<{ url: string; filter: Filter }>): Promise<NostrEvent[]> {
  const events: NostrEvent[] = []
  return new Promise((resolve, reject) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(events)
    }
    const timer = setTimeout(finish, COLLECT_TIMEOUT_MS)
    pool.subscribeMap(reqs, {
      label: "napp",
      onevent(e: any) {
        events.push(e)
      },
      onauth(event) {
        return currentSigner().signEvent(event) as any
      },
      oneose: finish,
      onclose(reasons) {
        done = true
        clearTimeout(timer)
        reject(reasons)
      }
    })
  })
}

function latest(events: NostrEvent[]): NostrEvent | null {
  let best = null
  for (const e of events) {
    if (!best || e.created_at > best.created_at) best = e
  }
  return best
}

function findListing(events: any[], pubkey: string, dTag: string) {
  let best = null
  for (const e of events) {
    if (e.kind !== NSITE_LISTING_KIND) continue
    if (e.pubkey !== pubkey) continue
    if ((getTag(e, "d") || "") !== dTag) continue
    if (!best || e.created_at > best.created_at) best = e
  }
  return best
}

function getTag(evt: { tags: string[][] }, name: string): string | undefined {
  const t = evt.tags.find(x => x[0] === name)
  return t?.[1]
}

async function fetchBlob(servers: string[], sha: string): Promise<Blob | null> {
  let i = 0
  while (i < servers.length) {
    const server = servers[i]
    try {
      const base = server.endsWith("/") ? server.slice(0, -1) : server
      const res = await fetch(`${base}/${sha}`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) { i++; continue }
      const blob = await res.blob()
      const buf = await blob.arrayBuffer()
      if (bytesToHex(sha256(new Uint8Array(buf))) !== sha) { i++; continue }
      return blob
    } catch {
      servers.push(servers.splice(i, 1)[0])
    }
  }
  return null
}

export function localizedTag(listing: { tags: string[][] } | null, tagName: string): string | null {
  if (!listing) return null
  const matches = listing.tags.filter(
    t => t[0] === tagName && typeof t[1] === "string" && t[1].length > 0
  )
  if (matches.length === 0) return null
  const userLang =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language.slice(0, 2).toLowerCase()
      : "en"
  return (
    matches.find(t => (t[2] || "").toLowerCase() === userLang)?.[1] ||
    matches.find(t => !t[2] || t[2].toLowerCase() === "en")?.[1] ||
    matches[0][1]
  )
}
