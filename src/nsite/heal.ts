// Replication repair, fired after a successful fetch — the one moment the
// launcher holds everything a future install needs. Re-publish the manifest to
// the queried relays (relays drop duplicates, so this is idempotent) and
// re-upload blobs to declared servers that miss them. Strictly best-effort:
// nothing blocks, nothing retries, every failure is only debug-logged.
//
// The existence probe is a 1-byte ranged GET, not BUD-01 HEAD: khatru/blossom
// answers HEAD from its metadata index without touching the bytes, so a server
// that lost a blob's file but kept its index row (seen live on r.alphaama.com)
// HEAD-lies with a 200. A ranged GET has to open the file. A failed probe just
// means we attempt the upload — content-addressed servers dedupe, so a
// redundant PUT is harmless.
import { pool } from "@nostr/gadgets/global"
import { BlossomClient } from "@nostr/tools/nipb7"
import type { NostrEvent } from "@nostr/tools/core"
import { generateSecretKey, finalizeEvent } from "@nostr/tools/pure"
import { getPubkey } from "../account.js"

// Upload auths are signed with a throwaway session key, never the user's
// signer: heal runs in the background of an install, and a NIP-07 extension
// popping "sign this kind-24242" mid-install reads as a phishing attempt. The
// auth only vouches for the uploader, not the content — blobs are content-
// addressed — so open servers accept it and allowlisting servers refuse it
// quietly, which is the right best-effort split.
const healKey = generateSecretKey()
const healSigner = { signEvent: async (t: any) => finalizeEvent(t, healKey) }

// Once per manifest per session — fetchNsite also runs on update checks and
// re-launches, and healing again buys nothing new.
const healed = new Set<string>()

export function healNapp(opts: {
  manifest: NostrEvent
  relays: string[]
  servers: string[]
  files: Array<{ sha: string; body: Blob; mime?: string }>
}): void {
  // Own publications only, for now: healing other authors' content means
  // writing to their infrastructure from this user's browser — deferred until
  // that's an explicit choice.
  if (opts.manifest.pubkey !== getPubkey()) return
  if (healed.has(opts.manifest.id)) return
  healed.add(opts.manifest.id)
  heal(opts).catch(err => console.debug("[heal] failed", String(err)))
}

async function heal({ manifest, relays, servers, files }: Parameters<typeof healNapp>[0]) {
  const published = await Promise.allSettled(pool.publish(relays, manifest))
  const republished = published.filter(r => r.status === "fulfilled").length

  let uploaded = 0
  await Promise.allSettled(
    servers.map(async server => {
      const client = new BlossomClient(server, healSigner as any)
      const base = (server.startsWith("http") ? server : `https://${server}`).replace(/\/$/, "")
      for (const f of files) {
        if (await hasBytes(base, f.sha)) continue
        try {
          await client.uploadBlob(f.body, f.mime)
          uploaded++
        } catch (err) {
          console.debug("[heal] upload refused", { server, sha: f.sha, err: String(err) })
        }
      }
    })
  )
  console.debug("[heal]", { id: manifest.id, republished, uploaded })
}

export async function hasBytes(base: string, sha: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/${sha}`, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(8000)
    })
    // 206 (range honored) or 200 (range ignored, body streams) both prove the
    // bytes exist; cancel the body so a range-ignoring server doesn't send it all.
    res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}
