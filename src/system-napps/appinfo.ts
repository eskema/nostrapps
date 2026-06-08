export const id = "appinfo"
export const title = "App info"

import type { SystemCtx } from "../types.js"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { dispatchAction } from "../handlers.js"
import "nostr-web-components"

const PLACEHOLDER_SRC = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

// Normalized data the info window renders. Built by the Apps cards (from a
// manifest event for discover/store apps, or an InstalledApp for local ones).
export interface AppInfoParams {
  nappId: string
  title: string
  iconSha?: string | null
  iconMime?: string | null
  iconUrl?: string | null
  authorPubkey?: string | null
  authorLabel?: string | null
  createdAt?: number | null
  actions: string[]
  event?: any | null
  naddr?: string | null
  seenOnRelays?: string[]
}

// The window is a singleton; launchSystem reuses the open instance instead of
// re-mounting it. So selection is shared state: a card calls selectApp() (which
// notifies the open window) and then launchSystemNapp("appinfo") to open/focus.
let current: AppInfoParams | null = null
const subs = new Set<(p: AppInfoParams | null) => void>()

export function selectApp(p: AppInfoParams) {
  current = p
  for (const fn of subs) fn(p)
}

export const singleton = true

export function mount(container: HTMLElement, _ctx: SystemCtx) {
  const fn = (p: AppInfoParams | null) => renderInfo(container, p)
  fn(current)
  subs.add(fn)
  return {
    unmount() {
      subs.delete(fn)
    }
  }
}

function code(text: string): HTMLElement {
  const c = document.createElement("code")
  c.textContent = text
  return c
}

function infoRow(label: string, value: Node): HTMLElement {
  const row = document.createElement("div")
  row.className = "apps-detail-row"
  const l = document.createElement("span")
  l.textContent = `${label}:`
  row.append(l, document.createTextNode(" "), value)
  return row
}

function renderInfo(container: HTMLElement, p: AppInfoParams | null) {
  container.className = "appinfo"
  container.innerHTML = ""

  if (!p) {
    const empty = document.createElement("div")
    empty.className = "appinfo-empty"
    empty.textContent = "Select an app to see its details."
    container.appendChild(empty)
    return
  }

  // ── header: icon · title · author/label · date ──
  const head = document.createElement("div")
  head.className = "appinfo-head"

  if (p.iconUrl || p.iconSha) {
    const icon = document.createElement("img")
    icon.className = "appinfo-icon"
    icon.alt = ""
    icon.src = PLACEHOLDER_SRC
    if (p.iconUrl) {
      icon.src = p.iconUrl
      icon.addEventListener("error", () => {
        icon.src = PLACEHOLDER_SRC
      })
    } else if (p.iconSha && p.authorPubkey) {
      loadBlossomServers(p.authorPubkey)
        .then(res => {
          const servers = res?.items ?? []
          if (!servers.length) return
          icon.src = `${servers[0].replace(/\/$/, "")}/${p.iconSha}`
        })
        .catch(() => {})
    }
    head.appendChild(icon)
  }

  const titleWrap = document.createElement("div")
  titleWrap.className = "appinfo-titlewrap"
  const h = document.createElement("h2")
  h.className = "appinfo-title"
  h.textContent = p.title
  titleWrap.appendChild(h)

  const meta = document.createElement("div")
  meta.className = "appinfo-meta apps-meta"
  if (p.authorPubkey) {
    const author = document.createElement("span")
    author.className = "apps-author"
    author.style.cursor = "pointer"
    author.addEventListener("click", () =>
      dispatchAction("appinfo", "profile", p.authorPubkey!).catch(() => {})
    )
    const pic = document.createElement("nostr-picture")
    pic.className = "apps-author-pic"
    pic.setAttribute("pubkey", p.authorPubkey)
    const name = document.createElement("nostr-name")
    name.className = "apps-author-name"
    name.setAttribute("pubkey", p.authorPubkey)
    author.append(pic, name)
    meta.appendChild(author)
  } else if (p.authorLabel) {
    const label = document.createElement("span")
    label.className = "apps-author apps-author-label"
    label.textContent = p.authorLabel
    meta.appendChild(label)
  }
  if (p.createdAt) {
    const d = document.createElement("span")
    d.className = "apps-date"
    d.textContent = new Date(p.createdAt * 1000).toLocaleString()
    meta.appendChild(d)
  }
  if (meta.childElementCount) titleWrap.appendChild(meta)
  head.appendChild(titleWrap)
  container.appendChild(head)

  // ── action chips ──
  if (p.actions.length) {
    const chips = document.createElement("div")
    chips.className = "apps-handlers"
    for (const a of p.actions) {
      const chip = document.createElement("span")
      chip.className = "apps-handler"
      chip.textContent = a
      chips.appendChild(chip)
    }
    container.appendChild(chips)
  }

  // ── ids ──
  container.appendChild(infoRow("id", code(p.nappId)))
  if (p.naddr) container.appendChild(infoRow("naddr", code(p.naddr)))

  // ── relays the manifest was seen on ──
  if (p.seenOnRelays?.length) {
    const chips = document.createElement("div")
    chips.className = "apps-chips"
    for (const r of p.seenOnRelays) {
      const chip = document.createElement("span")
      chip.className = "apps-chip apps-chip-relay"
      chip.textContent = r.replace(/^wss?:\/\//, "")
      chip.title = r
      chips.appendChild(chip)
    }
    container.appendChild(chips)
  }

  // ── manifest-derived detail (description, files, source, categories) ──
  if (p.event) {
    const cats = p.event.tags.filter((t: any) => t[0] === "l" && t[1]).map((t: any) => t[1])
    const hashtags = p.event.tags.filter((t: any) => t[0] === "t" && t[1]).map((t: any) => t[1])
    if (cats.length || hashtags.length) {
      const chips = document.createElement("div")
      chips.className = "apps-chips"
      for (const cat of cats) {
        const chip = document.createElement("span")
        chip.className = "apps-chip apps-chip-category"
        chip.textContent = formatCategory(cat)
        chip.title = cat
        chips.appendChild(chip)
      }
      for (const t of hashtags) {
        const chip = document.createElement("span")
        chip.className = "apps-chip apps-chip-tag"
        chip.textContent = `#${t}`
        chips.appendChild(chip)
      }
      container.appendChild(chips)
    }

    const detail = document.createElement("div")
    detail.className = "apps-detail"
    container.appendChild(detail)
    renderDetail(p.event).then(html => {
      detail.innerHTML = html
    })
  }
}

// ─── manifest detail rendering (moved from apps.ts) ───────────────

async function renderDetail(evt: any): Promise<string> {
  const pubkey = evt.pubkey
  const description = evt.tags.find((t: any) => t[0] === "description")?.[1] || ""
  const source = evt.tags.find((t: any) => t[0] === "source")?.[1] || ""
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  const serverTagUrls = evt.tags.filter((t: any) => t[0] === "server" && t[1]).map((t: any) => t[1])
  const blossomServers =
    pathTags.length > 0
      ? (await loadBlossomServers(pubkey).catch(() => ({ items: [] as string[] }))).items
      : []
  const servers = [...new Set([...serverTagUrls, ...blossomServers])]

  return `
    ${source ? `<div class="apps-detail-row"><span>source:</span> <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a></div>` : ""}
    ${description ? `<div class="apps-detail-section"><p class="apps-detail-desc">${esc(description)}</p></div>` : ""}
    ${
      pathTags.length > 0
        ? `
      <div class="apps-detail-section">
        <div class="apps-detail-row"><span>files (${pathTags.length}):</span></div>
        <ul class="apps-detail-files">
          ${pathTags
            .map((t: string[]) => {
              const path = t[1]
              const sha = t[2]
              return `<li><code>${esc(path)}</code> ${servers
                .map((url: string) => {
                  let hostname = new URL(url).host
                  return `<a href="${url}/${sha}" target="_blank" rel="noopener noreferrer">${esc(hostname)}</a>`
                })
                .join(" ")}</li>`
            })
            .join("")}
        </ul>
      </div>
      `
        : ""
    }
  `
}

function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  )
}

function formatCategory(label: string) {
  const m = /^napp\.([^:]+):(.+)$/.exec(label)
  if (!m) return label
  return `${m[2]} · ${m[1]}`
}
