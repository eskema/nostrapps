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

export function mount(
  container: HTMLElement,
  ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  let files: Array<{ path: string; file: File }> = []
  let metadata: any = null
  let eventTemplate: any = null
  let publishing = false

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
        <button type="button" class="upload-publish" disabled>Publish</button>
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

  async function readDir(dirHandle: any, path: string) {
    for await (const entry of dirHandle.values()) {
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
      await readDir(initial, "")
      buildEvent()
    } else if (Array.isArray(initial)) {
      // Pre-read files array for local~ apps
      files = initial
      const metaEntry = initial.find(f => f.path === "metadata.json")
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

    if (!metadata?.id) {
      setStatus(`metadata.json is missing the "id"`)
      return
    }

    setStatus("Loading blossom servers…")
    const serverList = (await loadBlossomServers(pubkey)).items ?? []
    if (serverList.length === 0) {
      setStatus("No blossom servers configured.")
      return
    }

    setStatus("Uploading files…")
    const tags = []
    for (const f of files) {
      if (f.path === "metadata.json") continue
      const results = await Promise.allSettled(
        serverList.map(s => new BlossomClient(s, signer as any).uploadFile(f.file))
      )
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
      tags.push(["path", f.path, bd.sha256, bd.type || f.file.type || "application/octet-stream"])
    }

    if (protectedCb.checked) tags.push(["-"])

    if (metadata?.name) tags.push(["title", metadata.name])
    if (metadata?.description) tags.push(["description", metadata.description])
    if (metadata?.icon) tags.push(["icon", metadata.icon])
    if (Array.isArray(metadata?.actions)) {
      for (const a of metadata.actions) tags.push(["action", a])
    }

    tags.push(["d", metadata.id])

    eventTemplate = {
      kind: NSITE_NAMED_KIND,
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
