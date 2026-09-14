import { pool } from "@nostr/gadgets/global"
import { guessMime } from "./mime.js"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { currentSigner } from "../signers/index.js"
import { Filter } from "@nostr/tools/filter"
import { NostrEvent } from "@nostr/tools/pure"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { NsiteResult } from "../types.js"
import { healNapp } from "./heal.js"

export const NSITE_NAMED_KIND = 35128

// Where manifests are looked for when a link or hostname carries no relay
// hints: the author's write relays plus these, the relays the Apps napp
// discovers on. An naddr without hints must still resolve.
export const NAPP_RELAYS = [
  "wss://relay.nostrapps.com/",
  "wss://relay.nostrapps.com/personal",
  "wss://relay.nostrapps.com/internal"
]

const COLLECT_TIMEOUT_MS = 10000

export async function fetchNsite(
  target: { pubkey: string; dTag: string; relayHints: string[] },
  onProgress: (msg: string) => void = () => {}
): Promise<NsiteResult> {
  console.debug("fetching nsite", target)

  const { pubkey, dTag, relayHints } = target
  if (!pubkey) throw new Error("fetchNsite: no pubkey")

  // 1. build filter from input
  // By author, not just by d tag: every author publishes to the napp relays,
  // and two "profile" napps by two authors are two different apps.
  const filter: Filter = { kinds: [NSITE_NAMED_KIND], authors: [pubkey], "#d": [dTag] }

  onProgress("Querying relays…")

  // 2. Resolve which relays to query for the manifest. Prefer the explicit
  // hints (e.g. the relays the Apps napp found this event on) — only without
  // them fan out to the author's write relays and the napp relays.
  const relays = relayHints.length ? [...relayHints] : await manifestRelays(pubkey)
  const reqs = relays.map((url: string) => ({ url, filter }))

  // 3. collect events
  const events = await collect(reqs)

  // 4. find manifest
  // Relays are trusted with the filter but not blindly: the one asked for is
  // the one launched.
  const manifest = latest(events.filter(e => e.pubkey === pubkey))
  if (!manifest) throw new Error(`napp "${dTag}" not found`)

  // 5. have manifest — download files
  const nappId = `${pubkey.slice(0, 16)}~${dTag}`

  const paths = manifestPaths(manifest)
  if (paths.length === 0) throw new Error("nsite manifest has no path tags")

  const servers = await blobServers(manifest, pubkey)

  const files = []
  const healFiles = []
  for (let i = 0; i < paths.length; i++) {
    const { path, sha, mime } = paths[i]
    onProgress(`Fetching ${i + 1}/${paths.length}: ${path}`)
    const blob = await fetchBlob(servers, sha)
    if (!blob)
      throw new Error(
        `Could not fetch ${path} (${sha}) from any of ${servers.length} server(s): ${
          servers.join(", ") || "none configured"
        }`
      )
    files.push({ path, body: blob, mime })
    healFiles.push({ sha, body: blob, mime })
  }

  healNapp({ manifest, relays, servers, files: healFiles })

  const title = getTag(manifest, "title") || null
  const singleton = manifest.tags.some((t: string[]) => t[0] === "singleton")

  return { nappId, files, title, manifest, singleton }
}

// ─── helpers ──────────────────────────────────────────────────────

// The relays to ask for an author's manifests when no hints are known: their
// write relays plus the napp relays. gadgets remembers a no-answer for two
// days and serves it back instantly as an empty list — reset it and ask once
// more before going without.
export async function manifestRelays(pubkey: string): Promise<string[]> {
  let relayList = await loadRelayList(pubkey)
  if (relayList.items.length === 0) {
    await loadRelayList(pubkey, [], null)
    relayList = await loadRelayList(pubkey)
  }
  const write = relayList.items.filter(r => r.write).map((r: { url: string }) => r.url)
  return [...new Set([...write, ...NAPP_RELAYS])]
}

// The blossom servers a manifest's blobs may be on: ours, the author's list,
// and the ones the manifest itself names.
export async function blobServers(manifest: NostrEvent, pubkey: string): Promise<string[]> {
  const manifestServers = manifest.tags
    .filter((t: string[]) => t[0] === "server" && t[1])
    .map((t: string[]) => t[1])
  const userServers = (await loadBlossomServers(pubkey)).items ?? []
  // One entry per server whichever way it was written (scheme, trailing slash).
  const seen = new Set<string>()
  return ["relay.nostrapps.com", ...userServers, ...manifestServers].filter(s => {
    const key = s.replace(/^https?:\/\//, "").replace(/\/$/, "")
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// The manifest's files: ["path", path, sha, mime?] tags, paths made absolute.
export function manifestPaths(
  manifest: NostrEvent
): Array<{ path: string; sha: string; mime: string }> {
  return manifest.tags
    .filter((t: string[]) => t[0] === "path" && t.length >= 3 && t[1] && t[2])
    .map((t: string[]) => {
      const path = t[1].startsWith("/") ? t[1] : `/${t[1]}`
      return { path, sha: t[2], mime: t[3] || guessMime(path) }
    })
}

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

function getTag(evt: { tags: string[][] }, name: string): string | undefined {
  const t = evt.tags.find(x => x[0] === name)
  return t?.[1]
}

export async function fetchBlob(servers: string[], sha: string): Promise<Blob | null> {
  // Try each server at most once. A throwing server (timeout / network / CORS)
  // is skipped like any other failure — never retried in place, so an
  // unreachable server can't spin this loop forever and stall the install.
  for (let server of servers) {
    try {
      server = server.endsWith("/") ? server.slice(0, -1) : server
      server = server.startsWith("http") ? server : `https://${server}`
      const res = await fetch(`${server}/${sha}`, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) {
        console.debug("[fetchBlob] miss", { server, sha, status: res.status })
        continue
      }
      const blob = await res.blob()
      const buf = await blob.arrayBuffer()
      if (bytesToHex(sha256(new Uint8Array(buf))) !== sha) {
        console.debug("[fetchBlob] hash mismatch", { server, sha })
        continue
      }
      return blob
    } catch (err) {
      // network error / timeout / abort — move on to the next server
      console.debug("[fetchBlob] error", { server, sha, err: String(err) })
      continue
    }
  }
  console.warn("[fetchBlob] all servers failed", { sha, servers })
  return null
}
