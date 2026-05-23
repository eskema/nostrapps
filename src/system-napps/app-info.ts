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
import { loadBlossomServers } from "@nostr/gadgets/lists"

export async function mount(
  container: HTMLElement,
  _ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  const data = opts.params
  if (!data) {
    container.innerHTML = `<div class="app-info-empty">No app data provided.</div>`
    return
  }

  console.log("data", data)

  const isEvent = typeof data.kind === "number"
  const nappId = data.nappId || (isEvent ? computeNappId(data) : "")
  const kind = isEvent ? data.kind : data.manifest?.kind || "unknown"
  const pubkey = isEvent ? data.pubkey : data.manifest?.pubkey || "unknown"
  const dTag = isEvent
    ? data.tags.find((t: any) => t[0] === "d")?.[1] || ""
    : data.manifest?.dTag || ""
  const title = isEvent ? data.tags.find((t: any) => t[0] === "title")?.[1] || "" : data.name || ""
  const description = isEvent ? data.tags.find((t: any) => t[0] === "description")?.[1] || "" : ""
  const source = isEvent ? data.tags.find((t: any) => t[0] === "source")?.[1] || "" : ""
  const pathTags = isEvent ? data.tags.filter((t: any) => t[0] === "path" && t[1] && t[2]) : []
  const serverTagUrls = isEvent ? data.tags.filter((t: any) => t[0] === "server" && t[1]).map((t: any) => t[1]) : []
  const blossomServers = pathTags.length > 0 ? (await loadBlossomServers(pubkey).catch(() => ({ items: [] as string[] }))).items : []
  const servers = [...new Set([...serverTagUrls, ...blossomServers])]
  const createdAt = isEvent ? data.created_at : data.manifest?.createdAt || 0
  const handlers =
    data.handlers ||
    (isEvent ? data.tags.filter((t: any) => t[0] === "action").map((t: any) => t[1]) : [])

  container.innerHTML = `
    <div class="app-info-panel">
      <h2 class="app-info-title">${title || "(untitled)"}</h2>
      <div class="app-info-id"><code>${nappId}</code></div>
      <div class="app-info-meta">
        <div class="app-info-row"><span>kind:</span> <code>${kind}</code></div>
        ${dTag ? `<div class="app-info-row"><span>d-tag:</span> <code>${dTag}</code></div>` : ""}
        ${createdAt ? `<div class="app-info-row"><span>created at:</span> <span>${new Date(createdAt * 1000).toLocaleString()}</span></div>` : ""}
        ${source ? `<div class="app-info-row"><span>source:</span> <a href="${source}" target="_blank" rel="noopener noreferrer">${source}</a></div>` : ""}
        <div class="app-info-row"><span>author:</span> <code class="app-info-mono">${pubkey}</code></div>
        <div class="app-info-author">
          <nostr-picture pubkey="${pubkey}" class="app-info-author-pic"></nostr-picture>
          <nostr-name pubkey="${pubkey}" class="app-info-author-name">${pubkey.slice(0, 8)}…</nostr-name>
        </div>
      </div>
      ${description ? `<div class="app-info-desc">${description}</div>` : ""}
      ${
        pathTags.length > 0
          ? `
        <div class="app-info-files">
          <div class="app-info-row"><span>files (${pathTags.length}):</span></div>
          <ul class="app-info-file-list">
            ${pathTags.map((t: string[]) => {
              const path = t[1]
              const sha = t[2]
              return `<li><code>${path}</code> ${servers.map((url: string) => {
                let hostname = url
                try { hostname = new URL(url).hostname } catch {}
                return `<a href="${url}/${sha}" target="_blank" rel="noopener noreferrer">${hostname}</a>`
              }).join(" ")}</li>`
            }).join("")}
          </ul>
        </div>
      `
          : ""
      }
      ${
        handlers.length > 0
          ? `
        <div class="app-info-handlers">
          ${handlers.map((h: any) => `<span class="app-info-handler">${h}</span>`).join("")}
        </div>
      `
          : ""
      }
    </div>
  `

  opts.onStateChange?.({ data })
}
