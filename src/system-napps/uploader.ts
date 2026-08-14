import { pool } from "@nostr/gadgets/global"
import { currentSigner } from "../signers/index.js"
import { BlossomClient } from "@nostr/tools/nipb7"
import { loadBlossomServers } from "@nostr/gadgets/lists"

export const id = "uploader"
export const title = "Uploader"
export const slash = "/upload"
export const singleton = false

const DEFAULT_RELAYS = [
  "wss://relay.nostrapps.com",
  "wss://relay.nostrapps.com/personal",
  "wss://relay.nostrapps.com/internal"
]

import type { SystemCtx } from "../types.js"
import { NSITE_NAMED_KIND } from "../nsite/fetch.js"
import { NAPPLET_NAMED_KIND, computeAggregateHash, nappletMetaFromHtml } from "../nsite/napplet.js"
import { isIgnoredPath } from "../nsite/ignore.js"
import { slug } from "../nsite/local.js"

export function mount(
  container: HTMLElement,
  ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  let files: Array<{ path: string; file: File }> = []
  let metadata: any = null
  let eventTemplate: any = null
  let publishing = false
  let dirName: string | null = null // fallback napplet id when the html has no <meta name="id">
  // Set when the caller already knows the flavor/id (a local napplet's publish
  // button) — skips the html-marker guess entirely.
  let forceNapplet = false
  let forcedId: string | null = null

  container.innerHTML = `
    <div class="upload-panel">
      <div class="upload-relays">
        <label class="upload-relays-label">Relays (one per line)</label>
        <textarea class="upload-relays-input" rows="4" spellcheck="false">${DEFAULT_RELAYS.join("\n")}</textarea>
        <label class="upload-protected"><input type="checkbox" class="upload-protected-input"> protected</label>
      </div>
      <div class="upload-status" hidden></div>
      <div class="upload-preview" hidden>
        <h3>Event Preview</h3>
        <pre class="upload-json"></pre>
        <button type="button" class="btn btn-primary upload-publish" disabled>Publish</button>
      </div>
    </div>
  `

  const protectedCb = container.querySelector(".upload-protected-input") as HTMLInputElement
  const relaysInput = container.querySelector(".upload-relays-input") as HTMLInputElement
  const statusEl = container.querySelector(".upload-status") as HTMLElement
  const previewEl = container.querySelector(".upload-preview") as HTMLElement
  const jsonEl = container.querySelector(".upload-json") as HTMLElement
  const publishBtn = container.querySelector(".upload-publish") as HTMLElement

  function setStatus(msg: string | undefined) {
    statusEl.textContent = msg || ""
    statusEl.hidden = !msg
  }

  // Count of OS/editor junk left out, reported once the walk finishes — silently
  // dropping files would be confusing when something expected doesn't publish.
  let skipped = 0

  async function readDir(dirHandle: any, path: string) {
    for await (const entry of dirHandle.values()) {
      if (isIgnoredPath(path + entry.name)) {
        skipped++
        continue // a directory here takes its whole subtree with it
      }
      if (entry.kind === "file") {
        const file = await entry.getFile()
        files.push({ path: path + entry.name, file })
        if (path + entry.name === "metadata.json") {
          try {
            metadata = JSON.parse(await file.text())
          } catch {}
        }
      } else if (entry.kind === "directory") {
        await readDir(entry, path + entry.name + "/")
      }
    }
  }

  // Accept initial data from params
  ;(async () => {
    const initial = opts.params
    if (!initial) {
      setStatus("No data provided.")
      return
    }

    if (typeof initial.getDirectoryHandle === "function") {
      // FileSystemDirectoryHandle for dev~ apps
      dirName = typeof initial.name === "string" ? initial.name : null
      await readDir(initial, "")
      buildEvent()
    } else if (Array.isArray(initial) || Array.isArray(initial?.files)) {
      // Pre-read files array. Already filtered on the way in by
      // collectLocalFolder, but a caller assembling its own list shouldn't be
      // able to slip junk past the publish path. The object form carries an
      // explicit napplet flag + id (a local napplet's publish button).
      const list: Array<{ path: string; file: File }> = Array.isArray(initial)
        ? initial
        : initial.files
      forceNapplet = !Array.isArray(initial) && !!initial.napplet
      forcedId = (!Array.isArray(initial) && initial.id) || null
      files = list.filter(f => !isIgnoredPath(f.path))
      skipped = list.length - files.length
      const metaEntry = list.find(f => f.path === "metadata.json")
      if (metaEntry) {
        try {
          const blob = metaEntry.file instanceof Blob ? metaEntry.file : new Blob([metaEntry.file])
          metadata = JSON.parse(await blob.text())
        } catch {}
      }
      buildEvent()
    } else {
      setStatus("Invalid data provided.")
    }
  })()

  async function buildEvent() {
    if (files.length === 0) {
      setStatus("No files selected.")
      return
    }

    const signer = currentSigner()
    if (!signer) {
      setStatus("No signer connected.")
      return
    }

    const pubkey = ctx.account.getPubkey()
    if (!pubkey) {
      setStatus("No pubkey available.")
      return
    }

    // A lone index.html publishes as a napplet (kind 35129, metadata read from
    // the html) when the caller said so, or when the html carries a
    // napplet/napplet-* meta as a default.
    const single =
      !metadata && files.length === 1 && files[0].path.replace(/^\//, "") === "index.html"
    const nappletMeta = single ? nappletMetaFromHtml(await files[0].file.text()) : null
    const isNapplet = single && (forceNapplet || !!nappletMeta?.napplet)
    let dTag: string | null = metadata?.id || null
    if (isNapplet) {
      dTag = forcedId || nappletMeta!.id || slug(dirName || nappletMeta!.title || "") || null
      if (!dTag) {
        setStatus(`napplet needs <meta name="napplet-id" content="…"> in its index.html`)
        return
      }
    } else if (!dTag) {
      setStatus(`metadata.json is missing the "id"`)
      return
    }

    setStatus("Loading blossom servers…")
    const serverList = (await loadBlossomServers(pubkey)).items ?? []
    if (serverList.length === 0) {
      setStatus("No blossom servers configured.")
      return
    }

    setStatus(
      `Uploading files…${skipped ? ` (skipped ${skipped} system file${skipped === 1 ? "" : "s"})` : ""}`
    )
    const tags = []
    // A napplet event carries only /index.html; metadata.json is authoring
    // input. nsites ship metadata.json as a real file alongside its derived
    // tags: the serving worker reads /metadata.json from the installed files.
    const uploadList = isNapplet
      ? files.filter(f => f.path.replace(/^\//, "") === "index.html")
      : files
    const okServers = new Set<string>()
    for (const f of uploadList) {
      const results = await Promise.allSettled(
        serverList.map(s => new BlossomClient(s, signer as any).uploadFile(f.file))
      )
      results.forEach((r, i) => {
        if (r.status === "fulfilled") okServers.add(serverList[i])
      })
      const ok = results.find(r => r.status === "fulfilled") as
        | PromiseFulfilledResult<any>
        | undefined
      if (!ok) {
        const reasons = results
          .map(r => (r.status === "rejected" ? (r as PromiseRejectedResult).reason.message : ""))
          .join("; ")
        setStatus(`Upload failed for ${f.path}: ${reasons}`)
        return
      }
      const bd = ok.value
      ctx.setStatus(`Uploaded ${f.path} (${bd.sha256.slice(0, 8)}…)`)
      tags.push(["path", isNapplet ? "/index.html" : f.path, bd.sha256])
    }

    if (isNapplet) {
      tags.push(["x", computeAggregateHash(tags), "aggregate"])
      for (const s of okServers) tags.push(["server", s])
    }

    if (protectedCb.checked) tags.push(["-"])

    // Napplet metadata comes from the html; nsite metadata from metadata.json.
    const title = isNapplet ? nappletMeta!.title : metadata?.title || metadata?.name
    const description = isNapplet ? nappletMeta!.description : metadata?.description
    const icon = isNapplet ? nappletMeta!.icon : metadata?.icon
    if (title) tags.push(["title", title])
    if (description) tags.push(["description", description])
    if (icon) tags.push(["icon", icon])
    // Actions ride the napp bridge, which a napplet doesn't have.
    if (!isNapplet && Array.isArray(metadata?.actions)) {
      for (const a of metadata.actions) tags.push(["action", a])
    }
    // The authored requires list becomes the manifest's ["requires", "<domain>"]
    // tags. `ui`, `network` and the NAP domains all ride the same list.
    const requires = new Set<string>(isNapplet ? nappletMeta!.requires : [])
    if (!isNapplet && Array.isArray(metadata?.requires)) {
      for (const r of metadata.requires) if (typeof r === "string" && r) requires.add(r)
    }
    // Back-compat: the retired `ui: "wrapper"` field becomes requires: ["ui"].
    if (metadata?.ui === "wrapper") requires.add("ui")
    for (const r of requires) tags.push(["requires", r])

    tags.push(["d", dTag])

    eventTemplate = {
      kind: isNapplet ? NAPPLET_NAMED_KIND : NSITE_NAMED_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
      pubkey
    }

    jsonEl.textContent = JSON.stringify(eventTemplate, null, 2)
    previewEl.hidden = false
    publishBtn.disabled = !ctx.account.getPubkey()
    setStatus(`Ready — ${files.length} files`)
  }

  protectedCb.addEventListener("change", buildEvent)

  publishBtn.addEventListener("click", async () => {
    if (publishing || !eventTemplate || !ctx.account.getPubkey()) return
    publishing = true
    publishBtn.disabled = true
    publishBtn.textContent = "signing…"
    setStatus("Signing event…")

    try {
      const signer = currentSigner()
      if (!signer) throw new Error("No signer connected")
      const signed = await signer.signEvent(eventTemplate)
      publishBtn.textContent = "publishing…"
      const relayList = relaysInput.value
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)
      if (relayList.length === 0) relayList.push(...DEFAULT_RELAYS)
      ctx.setStatus("Publishing app event…")
      setStatus(`Publishing to ${relayList.length} relay(s)…`)

      const results = await Promise.allSettled(pool.publish(relayList, signed))
      const okCount = results.filter(r => r.status === "fulfilled").length
      ctx.setStatus(`Published app event to ${okCount}/${relayList.length} relays`)
      setStatus(`Published to ${okCount}/${relayList.length} relays`)
      publishBtn.textContent = "published"
      setTimeout(() => {
        publishBtn.textContent = "publish"
        publishBtn.disabled = false
      }, 3000)
    } catch (err) {
      setStatus(`Error: ${(err as any).message}`)
      publishBtn.textContent = "error"
      setTimeout(() => {
        publishBtn.textContent = "publish"
        publishBtn.disabled = false
      }, 3000)
    } finally {
      publishing = false
    }
  })
}
