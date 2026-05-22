import { pool } from "@nostr/gadgets/global"
import { currentSigner } from "../signers/index.js"

export const id = "uploader"
export const title = "Uploader"
export const slash = "/upload"

const NSITE_ROOT = 15128
const NSITE_NAMED = 35128
const DEFAULT_RELAYS = [
  "wss://relay.nostrapps.com",
  "wss://relay.nostrapps.com/personal",
  "wss://relay.nostrapps.com/public",
  "wss://relay.nostrapps.com/internal",
  "wss://relay.nostrapps.com/favorites"
]

import type { SystemCtx } from "../types.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  let relays = [...DEFAULT_RELAYS]
  let files: Array<{ path: string; file: File }> = []
  let metadata: any = null
  let eventTemplate: any = null
  let publishing = false

  container.innerHTML = `
    <div class="upload-panel">
      <div class="upload-toolbar">
        <button type="button" class="upload-pick-folder">Pick folder</button>
        <button type="button" class="upload-relays-toggle" title="Configure relays">⚙</button>
      </div>
      <div class="upload-relays" hidden>
        <label class="upload-relays-label">Relays (one per line)</label>
        <textarea class="upload-relays-input" rows="4" spellcheck="false">${relays.join("\n")}</textarea>
        <div class="upload-relays-actions">
          <button type="button" class="upload-relays-save">save</button>
          <button type="button" class="upload-relays-clear">clear</button>
        </div>
      </div>
      <div class="upload-status" hidden></div>
      <div class="upload-preview" hidden>
        <h3>Event Preview</h3>
        <pre class="upload-json"></pre>
        <button type="button" class="upload-publish" disabled>Publish</button>
      </div>
    </div>
  `

  const pickBtn = container.querySelector(".upload-pick-folder") as HTMLElement
  const relaysToggleBtn = container.querySelector(".upload-relays-toggle") as HTMLElement
  const relaysPanel = container.querySelector(".upload-relays") as HTMLElement
  const relaysInput = container.querySelector(".upload-relays-input") as HTMLInputElement
  const relaysSaveBtn = container.querySelector(".upload-relays-save") as HTMLElement
  const relaysClearBtn = container.querySelector(".upload-relays-clear") as HTMLElement
  const statusEl = container.querySelector(".upload-status") as HTMLElement
  const previewEl = container.querySelector(".upload-preview") as HTMLElement
  const jsonEl = container.querySelector(".upload-json") as HTMLElement
  const publishBtn = container.querySelector(".upload-publish") as HTMLElement

  function setStatus(msg: string | undefined) {
    statusEl.textContent = msg || ""
    statusEl.hidden = !msg
  }

  async function pickFolder() {
    files = []
    metadata = null

    if ((window as any).showDirectoryPicker) {
      try {
        const dirHandle = await (window as any).showDirectoryPicker()
        await readDir(dirHandle, "")
      } catch (err: any) {
        if (err.name !== "AbortError") setStatus(`Error: ${err.message}`)
        return
      }
    } else {
      const input = document.createElement("input")
      input.type = "file"
      input.webkitdirectory = true
      input.multiple = true
      input.onchange = async () => {
        const list = Array.from(input.files!)
        for (const f of list) {
          const relative = f.webkitRelativePath.split("/").slice(1).join("/")
          files.push({ path: relative, file: f })
          if (relative === "metadata.json") {
            try {
              metadata = JSON.parse(await f.text())
            } catch {}
          }
        }
        buildEvent()
      }
      input.click()
      return
    }

    buildEvent()
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

  async function computeSha256(file: File) {
    const buf = await file.arrayBuffer()
    const hash = await crypto.subtle.digest("SHA-256", buf)
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
  }

  async function buildEvent() {
    if (files.length === 0) {
      setStatus("No files selected.")
      return
    }

    setStatus("Computing hashes…")
    const tags = []
    for (const f of files) {
      const sha = await computeSha256(f.file)
      tags.push(["path", f.path, sha, f.file.type || "application/octet-stream"])
    }

    if (metadata?.name) tags.push(["title", metadata.name])
    if (metadata?.description) tags.push(["description", metadata.description])
    if (metadata?.icon) tags.push(["icon", metadata.icon])
    if (Array.isArray(metadata?.actions)) {
      for (const a of metadata.actions) tags.push(["action", a])
    }

    const dTag = metadata?.id
    const kind = metadata?.name ? NSITE_NAMED : NSITE_ROOT
    if (kind === NSITE_NAMED) tags.push(["d", dTag])

    const pubkey = ctx.account.getPubkey() || "0".repeat(64)
    eventTemplate = {
      kind,
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

  relaysToggleBtn.addEventListener("click", () => (relaysPanel.hidden = !relaysPanel.hidden))
  relaysSaveBtn.addEventListener("click", () => {
    relays = relaysInput.value
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
    if (relays.length === 0) relays = [...DEFAULT_RELAYS]
    relaysInput.value = relays.join("\n")
    relaysPanel.hidden = true
  })
  relaysClearBtn.addEventListener("click", () => {
    relays = [...DEFAULT_RELAYS]
    relaysInput.value = relays.join("\n")
    relaysPanel.hidden = true
  })

  pickBtn.addEventListener("click", pickFolder)

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
      setStatus(`Publishing to ${relays.length} relay(s)…`)

      const results = await Promise.allSettled(pool.publish(relays, signed))
      const okCount = results.filter(r => r.status === "fulfilled").length
      setStatus(`Published to ${okCount}/${relays.length} relays`)
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
