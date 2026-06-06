import { pool } from "@nostr/gadgets/global"
import { guessMime } from "./mime.js"
import { loadBlossomServers, loadRelayList } from "@nostr/gadgets/lists"
import { currentSigner } from "../signers/index.js"
import { Filter } from "@nostr/tools/filter"
import { NostrEvent } from "@nostr/tools/pure"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { NsiteResult } from "../types.js"

export const NSITE_NAMED_KIND = 35128

const COLLECT_TIMEOUT_MS = 10000

export async function fetchNsite(
  target: { pubkey: string; dTag: string; relayHints: string[] },
  onProgress: (msg: string) => void = () => {}
): Promise<NsiteResult> {
  console.debug("fetching nsite", target)

  const { pubkey, dTag, relayHints } = target
  if (!pubkey) throw new Error("fetchNsite: no pubkey")

  // 1. build filter from input
  const filter: Filter = { kinds: [NSITE_NAMED_KIND], "#d": [dTag] }

  onProgress("Querying relays…")

  // 2. Resolve which relays to query for the manifest. Prefer the explicit
  // hints (e.g. the relays the Apps store found this event on) and only fall
  // back to the author's kind-10002 relay list when none were given —
  // otherwise install fans out to every one of the author's relays.
  let relays = [...relayHints]
  if (relays.length === 0) {
    const relayList = await loadRelayList(pubkey)
    relays = relayList.items.filter(r => r.write).map((r: { url: string }) => r.url)
  }
  const reqs = relays.map((url: string) => ({ url, filter }))

  // 3. collect events
  const events = await collect(reqs)

  // 4. find manifest
  const manifest = latest(events)
  if (!manifest) throw new Error(`napp "${dTag}" not found`)

  // 5. have manifest — download files
  const nappId = `${pubkey.slice(0, 16)}~${dTag}`

  const pathTags = manifest.tags.filter(
    (t: string[]) => t[0] === "path" && t.length >= 3 && t[1] && t[2]
  )
  if (pathTags.length === 0) throw new Error("nsite manifest has no path tags")

  // Prefer the blossom servers the manifest itself declares. Only consult the
  // author's blossom list (another relay round-trip) when the manifest names
  // none, so we don't reach out to relays we weren't asked to use.
  const manifestServers = manifest.tags
    .filter((t: string[]) => t[0] === "server" && t[1])
    .map((t: string[]) => t[1])
  let servers = [...new Set(manifestServers)].filter(Boolean)
  if (servers.length === 0) {
    const userServers = (await loadBlossomServers(pubkey)).items ?? []
    servers = [...new Set(userServers)].filter(Boolean)
  }

  const files = []
  for (let i = 0; i < pathTags.length; i++) {
    const tag = pathTags[i]
    const path = tag[1].startsWith("/") ? tag[1] : `/${tag[1]}`
    const sha = tag[2]
    const mime = tag[3] || guessMime(path)
    onProgress(`Fetching ${i + 1}/${pathTags.length}: ${path}`)
    const blob = await fetchBlob(servers, sha)
    if (!blob)
      throw new Error(
        `Could not fetch ${path} (${sha}) from any of ${servers.length} server(s): ${
          servers.join(", ") || "none configured"
        }`
      )
    files.push({ path, body: blob, mime })
  }

  const title = getTag(manifest, "title") || null
  const singleton = manifest.tags.some((t: string[]) => t[0] === "singleton")

  return { nappId, files, title, manifest, singleton }
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

function getTag(evt: { tags: string[][] }, name: string): string | undefined {
  const t = evt.tags.find(x => x[0] === name)
  return t?.[1]
}

async function fetchBlob(servers: string[], sha: string): Promise<Blob | null> {
  // Try each server at most once. A throwing server (timeout / network / CORS)
  // is skipped like any other failure — never retried in place, so an
  // unreachable server can't spin this loop forever and stall the install.
  for (const server of servers) {
    try {
      const base = server.endsWith("/") ? server.slice(0, -1) : server
      const res = await fetch(`${base}/${sha}`, { signal: AbortSignal.timeout(10000) })
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
