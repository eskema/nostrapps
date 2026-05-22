import "nostr-web-components"

export const id = "app-info"
export const title = "App Info"
export const singleton = false
export const slash = ""

function computeNappId(evt: any) {
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1]
  if (evt.kind === 35128 && dTag) return `${evt.pubkey.slice(0, 40)}-${dTag}`
  return evt.pubkey.slice(0, 40)
}

import type { SystemCtx } from "../types.js"

export function mount(container: HTMLElement, ctx: SystemCtx, opts: { initial?: { data?: any } } = {}) {
  const data = opts.initial?.data
  console.log("opts", opts)
  if (!data) {
    container.innerHTML = `<div class="app-info-empty">No app data provided.</div>`
    return
  }

  const isEvent = typeof data.kind === "number"
  const nappId = data.nappId || (isEvent ? computeNappId(data) : "")
  const kind = isEvent ? data.kind : data.manifest?.kind || "unknown"
  const pubkey = isEvent ? data.pubkey : data.manifest?.pubkey || "unknown"
  const dTag = isEvent ? data.tags.find((t: any) => t[0] === "d")?.[1] || "" : data.manifest?.dTag || ""
  const title = isEvent ? data.tags.find((t: any) => t[0] === "title")?.[1] || "" : data.name || ""
  const description = isEvent ? data.tags.find((t: any) => t[0] === "description")?.[1] || "" : ""
  const source = isEvent ? data.tags.find((t: any) => t[0] === "source")?.[1] || "" : ""
  const paths = isEvent ? data.tags.filter((t: any) => t[0] === "path").length : 0
  const createdAt = isEvent ? data.created_at : data.manifest?.createdAt || 0
  const handlers =
    data.handlers || (isEvent ? data.tags.filter((t: any) => t[0] === "action").map((t: any) => t[1]) : [])

  container.innerHTML = `
    <div class="app-info-panel">
      <h2 class="app-info-title">${title || "(untitled)"}</h2>
      <div class="app-info-id"><code>${nappId}</code></div>
      <div class="app-info-meta">
        <div class="app-info-row"><span>Kind:</span> <code>${kind}</code></div>
        <div class="app-info-row"><span>Pubkey:</span> <code class="app-info-mono">${pubkey}</code></div>
        ${dTag ? `<div class="app-info-row"><span>D-Tag:</span> <code>${dTag}</code></div>` : ""}
        ${createdAt ? `<div class="app-info-row"><span>Created:</span> <span>${new Date(createdAt * 1000).toLocaleString()}</span></div>` : ""}
        ${paths ? `<div class="app-info-row"><span>Files:</span> <span>${paths}</span></div>` : ""}
        ${source ? `<div class="app-info-row"><span>Source:</span> <a href="${source}" target="_blank" rel="noopener noreferrer">${source}</a></div>` : ""}
      </div>
      ${description ? `<div class="app-info-desc">${description}</div>` : ""}
      ${
        handlers.length > 0
          ? `
        <div class="app-info-handlers">
          ${handlers.map((h: any) => `<span class="app-info-handler">${h}</span>`).join("")}
        </div>
      `
          : ""
      }
      <div class="app-info-author">
        <nostr-picture pubkey="${pubkey}" class="app-info-author-pic"></nostr-picture>
        <nostr-name pubkey="${pubkey}" class="app-info-author-name">${pubkey.slice(0, 8)}…</nostr-name>
      </div>
    </div>
  `
}
