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
import { BlossomClient, createUploadAuth, uploadBlob } from "@nostr/tools/nipb7"
import type { NostrEvent } from "@nostr/tools/core"
import { generateSecretKey, finalizeEvent } from "@nostr/tools/pure"
import { getPubkey } from "../account.js"
import { currentSigner } from "../signers/index.js"
import { onRelayAuth } from "../relay-auth.js"

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
  // A relay AUTH, unlike the upload auth below, has to be the user's own key —
  // proving who you are is the whole point of it, and heal only re-publishes
  // their own manifests. The usual relay-auth policy decides, so a remembered
  // or automatic answer stays silent.
  const published = await Promise.allSettled(
    pool.publish(relays, manifest, { onauth: onRelayAuth })
  )
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

// Share-time replication check, for any author: the moment a link is about to
// promise that its napps can be fetched, so an explicit user action — unlike
// the install-time heal above, other authors' content is fair game. For every
// target at once: the manifest published to each candidate relay (idempotent;
// the ones holding it become the link's hints), every blob probed on the
// servers. Then one upload auth over everything missing anywhere — one signing
// prompt for the whole link — and the re-uploads, each proved by a ranged GET
// afterwards. A result's `missing` lists the shas no server has after that.
export type ReplicationTarget = {
  manifest: NostrEvent
  relays: string[]
  servers: string[]
  files: Array<{ sha: string; body: Blob; mime?: string }>
  onProgress?: (msg: string) => void
}
export type ReplicationResult = { relays: string[]; uploaded: number; missing: string[] }

export async function ensureReplicatedAll(
  targets: ReplicationTarget[]
): Promise<ReplicationResult[]> {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
  type Plan = {
    t: ReplicationTarget
    relays: string[]
    shas: string[]
    bySha: Map<string, { sha: string; body: Blob; mime?: string }>
    present: Map<string, number> // sha → servers that have it
    needs: Map<string, string[]> // server base → shas it lacks that we can give
    uploaded: number
  }

  // Phase one, every target together: manifests out, blobs probed.
  const plans = await Promise.all(
    targets.map(async (t): Promise<Plan> => {
      const onProgress = t.onProgress ?? (() => {})
      const shas = t.manifest.tags.filter(x => x[0] === "path" && x[2]).map(x => x[2])
      const plan: Plan = {
        t,
        relays: [],
        shas,
        bySha: new Map(t.files.map(f => [f.sha, f])),
        present: new Map(),
        needs: new Map(),
        uploaded: 0
      }
      try {
        onProgress("publishing manifest…")
        const results = await Promise.allSettled(
          pool.publish(t.relays, t.manifest, { onauth: onRelayAuth })
        )
        plan.relays = t.relays.filter((_, i) => results[i].status === "fulfilled")
        const bases = t.servers.map(s =>
          (s.startsWith("http") ? s : `https://${s}`).replace(/\/$/, "")
        )
        onProgress(`checking ${plural(shas.length, "file")} on ${plural(bases.length, "server")}…`)
        await Promise.allSettled(
          bases.map(async base => {
            for (const sha of shas) {
              if (await hasBytes(base, sha)) plan.present.set(sha, (plan.present.get(sha) ?? 0) + 1)
              else if (plan.bySha.has(sha))
                plan.needs.set(base, [...(plan.needs.get(base) ?? []), sha])
            }
          })
        )
      } catch (err) {
        console.debug("[heal] share check failed", { id: t.manifest.id, err: String(err) })
      }
      return plan
    })
  )

  // Phase two: one auth for everything missing anywhere, then the uploads.
  const want = [...new Set(plans.flatMap(p => [...p.needs.values()].flat()))]
  if (want.length) {
    const servers = [...new Set(plans.flatMap(p => [...p.needs.keys()]))]
    for (const p of plans) {
      const n = new Set([...p.needs.values()].flat()).size
      if (n) p.t.onProgress?.(`uploading ${plural(n, "missing file")}…`)
    }
    const auth = await uploadAuth(want, servers)
    await Promise.allSettled(
      plans.flatMap(p =>
        [...p.needs].map(async ([base, lacking]) => {
          for (const sha of lacking) {
            const f = p.bySha.get(sha)!
            const blob =
              f.body.type === f.mime ? f.body : new Blob([f.body], { type: f.mime || "" })
            try {
              const r = await uploadBlob(base, blob, { auth, signal: AbortSignal.timeout(30_000) })
              // Stored under another hash, or accepted against a stale index row
              // without the bytes (a server that lost a file still answers for
              // it — see hasBytes): only a ranged GET afterwards proves it took.
              if (r?.sha256 === sha && (await hasBytes(base, sha))) {
                p.uploaded++
                p.present.set(sha, (p.present.get(sha) ?? 0) + 1)
              } else {
                console.debug("[heal] upload didn't take", { base, sha, got: r?.sha256 })
              }
            } catch (err) {
              console.debug("[heal] upload refused", { base, sha, err: String(err) })
            }
          }
        })
      )
    )
  }

  return plans.map(p => {
    const missing = p.shas.filter(sha => !p.present.get(sha))
    console.debug("[heal] share check", {
      id: p.t.manifest.id,
      relays: p.relays,
      uploaded: p.uploaded,
      missing
    })
    return { relays: p.relays, uploaded: p.uploaded, missing }
  })
}

// One upload auth for the whole run (an x tag per blob, a server tag per
// target), signed by the user's own signer when an account is connected —
// share is explicit, so its prompt is expected, and allowlisting servers take
// it — else, or if that signing fails, by the throwaway key.
async function uploadAuth(shas: string[], servers: string[]) {
  if (getPubkey()) {
    try {
      return await createUploadAuth(d => currentSigner().signEvent(d), shas, { servers })
    } catch (err) {
      console.debug("[heal] user signer unavailable for the upload auth", String(err))
    }
  }
  return createUploadAuth(d => healSigner.signEvent(d), shas, { servers })
}
