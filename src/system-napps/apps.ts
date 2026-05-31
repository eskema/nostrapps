export const id = "apps"
export const title = "Apps"
export const slash = "/apps"

import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { naddrEncode } from "@nostr/tools/nip19"
import "nostr-web-components"

import type { SystemCtx } from "../types.js"
import { getDevHandle } from "../sandbox/host.js"
import { readOpen } from "../persistence.js"
import { getHandlers, dispatchAction } from "../handlers.js"
import { currentSigner } from "../signers/index.js"
import { SubCloser } from "@nostr/tools/abstract-pool"
import { NSITE_NAMED_KIND } from "../nsite/fetch.js"
import { NostrEvent } from "@nostr/tools"

const PLACEHOLDER_SRC = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

const DEFAULT_RELAYS = ["wss://relay.nostrapps.com/personal", "wss://relay.nostrapps.com/internal"]

export function mount(
  container: HTMLElement,
  ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  let currentTab = "installed"
  let discoverFetched = false

  // ─── Discover tab state ───
  let filter = ""
  let events: any[] = []
  let relays = [...DEFAULT_RELAYS]
  let sub: null | SubCloser = null
  let sawEose = false

  container.innerHTML = `
    <div class="apps-panel">
      <div class="apps-tabs">
        <button type="button" class="apps-tab installed-tab active">installed</button>
        <button type="button" class="apps-tab discover-tab">discover</button>
      </div>
      <div class="apps-content"></div>
    </div>
  `

  const contentEl = container.querySelector(".apps-content") as HTMLElement
  const installedTab = container.querySelector(".installed-tab") as HTMLElement
  const discoverTab = container.querySelector(".discover-tab") as HTMLElement

  function switchTab(tab: string) {
    currentTab = tab
    installedTab.classList.toggle("active", tab === "installed")
    discoverTab.classList.toggle("active", tab === "discover")
    render()
  }

  installedTab.addEventListener("click", () => switchTab("installed"))
  discoverTab.addEventListener("click", () => switchTab("discover"))

  // ─── Installed tab ─────────────────────────────────────────────

  function renderInstalled() {
    contentEl.innerHTML = `<div class="apps-list"></div>`
    const listEl = contentEl.querySelector(".apps-list")!
    const apps = ctx.apps.list()

    if (apps.length === 0) {
      const empty = document.createElement("div")
      empty.className = "apps-empty"
      empty.textContent = "No apps installed yet."
      listEl.appendChild(empty)
      return
    }

    for (const app of apps) {
      const card = document.createElement("div")
      card.className = "apps-card"

      const head = document.createElement("div")
      head.className = "apps-card-head"

      const titles = document.createElement("div")
      titles.className = "apps-card-titles"

      const name = document.createElement("h3")
      name.className = "apps-title"
      name.textContent = app.petname || app.title || app.nappId
      titles.appendChild(name)

      const meta = document.createElement("div")
      meta.className = "apps-meta"

      const idEl = document.createElement("code")
      idEl.className = "apps-napp-id"
      idEl.textContent = app.nappId
      meta.appendChild(idEl)

      const openCount = readOpen().filter(s => s.nappId === app.nappId).length
      if (openCount > 0) {
        const openEl = document.createElement("span")
        openEl.textContent = `${openCount} open`
        meta.appendChild(openEl)
      }

      if (app.event?.created_at) {
        const dateEl = document.createElement("span")
        dateEl.textContent = new Date(app.event.created_at * 1000).toLocaleDateString()
        meta.appendChild(dateEl)
      }

      titles.appendChild(meta)

      const h = getHandlers(app.nappId)
      if (h.length > 0) {
        const handlers = document.createElement("div")
        handlers.className = "apps-handlers"
        for (const action of h) {
          const chip = document.createElement("span")
          chip.className = "apps-handler"
          chip.textContent = action
          handlers.appendChild(chip)
        }
        titles.appendChild(handlers)
      }

      const actions = document.createElement("div")
      actions.className = "apps-actions"

      if (app.nappId.startsWith("dev~")) {
        const pub = document.createElement("button")
        pub.type = "button"
        pub.textContent = "publish"
        pub.addEventListener("mouseup", () => {
          ctx.launchSystemNapp("uploader", { params: getDevHandle(app.nappId) })
        })
        actions.appendChild(pub)
      } else if (app.nappId.startsWith("temp~")) {
        const inst = document.createElement("button")
        inst.type = "button"
        inst.textContent = "install"
        inst.addEventListener("mouseup", async () => {
          inst.disabled = true
          inst.textContent = "installing…"
          try {
            const raw = app.nappId.slice(5)
            ctx.setStatus?.(`Apps: installing ${raw}…`)
            await ctx.install(raw)
            ctx.setStatus?.(`Apps: installed ${raw}`)
            renderInstalled()
          } catch (err: any) {
            ctx.setStatus?.(
              `Apps: install failed for ${app.nappId}: ${err?.message || String(err)}`
            )
            inst.disabled = false
            inst.textContent = "error"
            inst.title = err?.message || String(err)
            setTimeout(() => {
              inst.textContent = "install"
              inst.removeAttribute("title")
            }, 3000)
          }
        })
        actions.appendChild(inst)
      } else {
        const del = document.createElement("button")
        del.type = "button"
        del.textContent = "delete"
        del.addEventListener("mouseup", async () => {
          ctx.setStatus?.(`Apps: delete requested for ${app.nappId}`)
          const ok = window.confirm(
            `Delete ${app.petname || app.title || app.nappId}?\n\nThis removes local app files, windows, permissions, and stored state for this app.`
          )
          if (!ok) {
            ctx.setStatus?.(`Apps: delete cancelled for ${app.nappId}`)
            return
          }
          del.disabled = true
          del.textContent = "deleting…"
          try {
            ctx.setStatus?.(`Apps: deleting ${app.nappId}…`)
            await ctx.uninstall(app.nappId)
            ctx.setStatus?.(`Apps: delete finished for ${app.nappId}`)
          } catch (err: any) {
            ctx.setStatus?.(`Apps: delete failed for ${app.nappId}: ${err?.message || String(err)}`)
            del.disabled = false
            del.textContent = "error"
            del.title = err?.message || String(err)
            setTimeout(() => {
              del.textContent = "delete"
              del.removeAttribute("title")
            }, 3000)
          }
        })
        actions.appendChild(del)
      }

      head.append(titles, actions)
      card.appendChild(head)

      listEl!.appendChild(card)
    }
  }

  // ─── Discover tab ──────────────────────────────────────────────

  let _statusEl: HTMLElement | null = null
  let _listEl: HTMLElement | null = null

  function emitDiscoverState() {
    opts.onStateChange?.({ relays: [...relays] })
  }

  function setStatus(msg: string | undefined) {
    if (!_statusEl) return
    _statusEl.textContent = msg || ""
    _statusEl.hidden = !msg
  }

  function renderList() {
    if (!_listEl) return
    _listEl.innerHTML = ""

    const manifests = events.filter(e => e.kind === NSITE_NAMED_KIND)
    const filtered = manifests
      .filter(m => matchesFilter(m, filter))
      .sort((a, b) => b.created_at - a.created_at)

    const renderOne = (evt: any) => _listEl!.appendChild(renderCard(evt, ctx, relays, renderList))

    if (filtered.length === 0) {
      const empty = document.createElement("div")
      empty.className = "store-empty"
      empty.textContent = manifests.length === 0 ? "No napps found." : "No matches."
      _listEl.appendChild(empty)
      return
    }

    for (const evt of filtered) renderOne(evt)

    const seenIconPks = new Set()
    for (const evt of filtered) {
      if (seenIconPks.has(evt.pubkey)) continue
      const hasIcon = evt.tags.some((t: any) => t[0] === "icon" && t[1])
      if (!hasIcon) continue
      seenIconPks.add(evt.pubkey)
      loadBlossomServers(evt.pubkey)
        .then(res => {
          const servers = res?.items ?? []
          if (servers.length === 0) return
          const icons = _listEl!.querySelectorAll(
            `[data-author="${evt.pubkey}"] .store-card-icon[data-icon-sha]`
          ) as unknown as HTMLImageElement[]
          for (const img of icons) {
            const sha = img.dataset.iconSha!
            const base = servers[0].endsWith("/") ? servers[0].slice(0, -1) : servers[0]
            img.src = `${base}/${sha}`
            let next = 1
            img.onerror = () => {
              if (next >= servers.length) {
                img.src = PLACEHOLDER_SRC
                return
              }
              const b = servers[next].endsWith("/") ? servers[next].slice(0, -1) : servers[next]
              next++
              img.src = `${b}/${sha}`
            }
          }
        })
        .catch(() => {})
    }
  }

  function closeSubscription() {
    try {
      sub?.close?.()
    } catch {}
    sub = null
  }

  function startDiscoverSubscription() {
    closeSubscription()
    events = []
    sawEose = false
    renderList()

    if (!relays.length) {
      setStatus("No relays configured.")
      return
    }

    const relaysDisplay = relays.map(r => r.replace(/^wss?:\/\//, ""))
    setStatus(`Relays: ${relaysDisplay.join(", ")}`)
    sub = pool.subscribeMany(
      relays,
      { kinds: [NSITE_NAMED_KIND], limit: 400 },
      {
        label: "napps",
        onevent(event: any) {
          if (events.some((existing: any) => existing.id === event.id)) return
          events.push(event)
          renderList()
          if (sawEose) {
            setStatus(
              `Relays: ${relaysDisplay.join(", ")} — ${events.length} event${events.length === 1 ? "" : "s"}`
            )
          } else {
            setStatus(`Relays: ${relaysDisplay.join(", ")} — loading… ${events.length}`)
          }
        },
        oneose() {
          sawEose = true
          setStatus(
            `Relays: ${relaysDisplay.join(", ")} — ${events.length} event${events.length === 1 ? "" : "s"}`
          )
        },
        onclose(reasons: string[]) {
          setStatus(`Subscriptions closed: ${reasons}`)
        },
        onauth(event) {
          return currentSigner().signEvent(event) as any
        }
      }
    )
  }

  function renderDiscover() {
    contentEl.innerHTML = `
      <div class="store-panel">
        <div class="store-toolbar">
          <input class="store-search" type="search" placeholder="Search title, description, npub…" />
          <button type="button" class="store-relays-toggle" title="Configure relays">⚙</button>
        </div>
        <div class="store-relays" hidden>
          <label class="store-relays-label">Relays (one per line — leave empty to use your kind 10002, or fall back to defaults)</label>
          <textarea class="store-relays-input" rows="4" spellcheck="false"></textarea>
          <div class="store-relays-actions">
            <button type="button" class="store-relays-save">save &amp; refresh</button>
            <button type="button" class="store-relays-clear">clear</button>
          </div>
        </div>
        <div class="store-status" hidden></div>
        <div class="store-list"></div>
      </div>
    `

    _statusEl = contentEl.querySelector(".store-status") as HTMLElement
    _listEl = contentEl.querySelector(".store-list") as HTMLElement
    const searchEl = contentEl.querySelector(".store-search") as HTMLInputElement
    const relaysToggleBtn = contentEl.querySelector(".store-relays-toggle") as HTMLElement
    const relaysPanel = contentEl.querySelector(".store-relays") as HTMLElement
    const relaysInput = contentEl.querySelector(".store-relays-input") as HTMLInputElement
    const relaysSaveBtn = contentEl.querySelector(".store-relays-save") as HTMLElement
    const relaysClearBtn = contentEl.querySelector(".store-relays-clear") as HTMLElement

    relaysInput.value = relays.join("\n")

    searchEl.addEventListener("input", () => {
      filter = searchEl.value.trim().toLowerCase()
      renderList()
    })

    relaysToggleBtn.addEventListener("click", () => {
      relaysPanel.hidden = !relaysPanel.hidden
    })

    relaysSaveBtn.addEventListener("click", () => {
      relays = sanitizeRelays(relaysInput.value.split("\n"))
      if (relays.length === 0) relays = [...DEFAULT_RELAYS]
      relaysInput.value = relays.join("\n")
      emitDiscoverState()
      relaysPanel.hidden = true
      startDiscoverSubscription()
    })

    relaysClearBtn.addEventListener("click", () => {
      relays = [...DEFAULT_RELAYS]
      relaysInput.value = relays.join("\n")
      emitDiscoverState()
      relaysPanel.hidden = true
      startDiscoverSubscription()
    })

    renderList()
    emitDiscoverState()
    if (!discoverFetched) {
      discoverFetched = true
      startDiscoverSubscription()
    }
  }

  // ─── Render ────────────────────────────────────────────────────

  function render() {
    if (currentTab === "installed") {
      renderInstalled()
    } else {
      renderDiscover()
    }
  }

  render()
  const unsub = ctx.apps.subscribe(() => {
    if (currentTab === "installed") renderInstalled()
  })

  return {
    unmount() {
      unsub()
      try {
        sub?.close?.()
      } catch {}
    }
  }
}

// ─── Detail rendering for installed app cards ────────────────────

async function renderDetail(evt: any): Promise<string> {
  const pubkey = evt.pubkey
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1] || ""
  const description = evt.tags.find((t: any) => t[0] === "description")?.[1] || ""
  const source = evt.tags.find((t: any) => t[0] === "source")?.[1] || ""
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  const serverTagUrls = evt.tags.filter((t: any) => t[0] === "server" && t[1]).map((t: any) => t[1])
  const blossomServers =
    pathTags.length > 0
      ? (await loadBlossomServers(pubkey).catch(() => ({ items: [] as string[] }))).items
      : []
  const servers = [...new Set([...serverTagUrls, ...blossomServers])]
  const createdAt = evt.created_at
  const actionHandlers = evt.tags.filter((t: any) => t[0] === "action").map((t: any) => t[1])

  return `
    <div class="apps-detail-section">
      ${dTag ? `<div class="apps-detail-row"><span>d-tag:</span> <code>${esc(dTag)}</code></div>` : ""}
      ${createdAt ? `<div class="apps-detail-row"><span>created at:</span> <span>${new Date(createdAt * 1000).toLocaleString()}</span></div>` : ""}
      ${source ? `<div class="apps-detail-row"><span>source:</span> <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a></div>` : ""}

    </div>
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
    ${
      actionHandlers.length > 0
        ? `
      <div class="apps-detail-section apps-detail-handlers">
        ${actionHandlers.map((h: any) => `<span class="apps-handler">${esc(h)}</span>`).join("")}
      </div>
      `
        : ""
    }
  `
}

// ─── Discover card rendering ─────────────────────────────────────

function renderCard(evt: NostrEvent, ctx: SystemCtx, relays: string[], onChange: any = null) {
  const tag = (k: string) => evt.tags.find((t: any) => t[0] === k)?.[1] || ""
  const dTag = tag("d")
  const source = tag("source")
  const date = new Date(evt.created_at * 1000).toLocaleDateString()
  const pathCount = evt.tags.filter((t: any) => t[0] === "path").length
  const nappId = computeNappId(evt)
  const installed = ctx.isInstalled?.(nappId) ?? false
  const installedEvents = ctx.apps.events?.() ?? []
  const installedEvent = installedEvents.find((e: any) => computeNappId(e) === nappId)
  const updateAvailable = installed && installedEvent && installedEvent.created_at < evt.created_at

  const title = tag("title")
  const description = tag("description")
  const iconTag = evt.tags.find((t: any) => t[0] === "icon")
  const iconSha = iconTag?.[1]
  const iconMime = iconTag?.[2]
  const seenOnRelays = Array.from(pool.seenOn.get(evt.id) || []).map((r: any) => r.url)
  const naddr = naddrEncode({
    pubkey: evt.pubkey,
    kind: NSITE_NAMED_KIND,
    identifier: dTag,
    relays: seenOnRelays
  })
  const categoryTags = evt.tags.filter((t: any) => t[0] === "l" && t[1]).map((t: any) => t[1])
  const hashtags = evt.tags.filter((t: any) => t[0] === "t" && t[1]).map((t: any) => t[1])

  const card = document.createElement("div")
  card.className = "store-card"
  card.dataset.author = evt.pubkey

  const head = document.createElement("div")
  head.className = "store-card-head"

  if (iconSha) {
    const icon = document.createElement("img")
    icon.className = "store-card-icon"
    icon.alt = ""
    icon.dataset.iconSha = iconSha
    if (iconMime) icon.dataset.iconMime = iconMime
    icon.src = PLACEHOLDER_SRC
    head.appendChild(icon)
  }

  const titles = document.createElement("div")
  titles.className = "store-card-titles"

  const h = document.createElement("h3")
  h.className = "store-title"
  h.textContent = title || `(${dTag})`
  titles.appendChild(h)

  const meta = document.createElement("div")
  meta.className = "store-meta"

  const author = document.createElement("span")
  author.className = "store-author"
  author.style.cursor = "pointer"
  author.addEventListener("click", e => {
    e.stopPropagation()
    dispatchAction("apps", "profile", evt.pubkey).catch(() => {})
  })
  const pic = document.createElement("nostr-picture")
  pic.className = "store-author-pic"
  pic.setAttribute("pubkey", evt.pubkey)
  const name = document.createElement("nostr-name")
  name.className = "store-author-name"
  name.setAttribute("pubkey", evt.pubkey)
  author.append(pic, name)

  const dateEl = document.createElement("span")
  dateEl.className = "store-date"
  dateEl.textContent = date

  const pathsEl = document.createElement("span")
  pathsEl.className = "store-paths"
  pathsEl.textContent = `${pathCount} file${pathCount === 1 ? "" : "s"}`

  meta.append(author, dateEl, pathsEl)
  for (const relay of seenOnRelays) {
    const chip = document.createElement("span")
    chip.className = "store-chip store-chip-relay"
    chip.textContent = relay.replace(/^wss?:\/\//, "")
    chip.title = relay
    meta.appendChild(chip)
  }
  titles.appendChild(meta)

  const actions = document.createElement("div")
  actions.className = "store-actions"

  const currentUser = ctx.account?.getPubkey()
  const isOwn = currentUser && evt.pubkey === currentUser
  let menuOpen = false
  let menuEl: HTMLDivElement | null = null

  function closeMenu() {
    if (menuEl) {
      menuEl.remove()
      menuEl = null
    }
    menuOpen = false
  }

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation()
    if (menuOpen) {
      closeMenu()
      return
    }
    menuOpen = true
    menuEl = document.createElement("div")
    menuEl.className = "store-card-menu"
    const btn = document.createElement("button")
    btn.type = "button"
    btn.textContent = "request delete"
    btn.addEventListener("click", async () => {
      closeMenu()
      ctx.setStatus?.("Store: requesting deletion of app event…")
      try {
        const signer = currentSigner()
        if (!signer) throw new Error("No signer")
        const signed = await signer.signEvent({
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["k", String(evt.kind)],
            ["e", evt.id]
          ],
          content: ""
        })
        const results = await Promise.allSettled(pool.publish(relays, signed))
        const ok = results.filter(r => r.status === "fulfilled").length
        ctx.setStatus?.(`Store: deletion event sent to ${ok}/${relays.length} relays`)
      } catch (err: any) {
        ctx.setStatus?.(`Store: deletion failed — ${err.message}`)
      }
    })
    menuEl.appendChild(btn)
    const onDocClick = (ev: MouseEvent) => {
      if (menuEl && !menuEl.contains(ev.target as Node)) {
        closeMenu()
        document.removeEventListener("click", onDocClick)
      }
    }
    document.addEventListener("click", onDocClick)
    card.appendChild(menuEl)
  }

  const menuTrigger = document.createElement("button")
  menuTrigger.type = "button"
  menuTrigger.className = "store-card-menu-trigger"
  menuTrigger.textContent = "···"
  menuTrigger.addEventListener("click", toggleMenu)

  const performAction = async (btn: HTMLButtonElement, action: string) => {
    btn.disabled = true
    btn.textContent =
      action === "update" ? "updating…" : action === "uninstall" ? "uninstalling…" : "launching…"
    try {
      if (action === "update") {
        await ctx.update({
          pubkey: evt.pubkey,
          dTag: dTag,
          relayHints: Array.from(pool.seenOn.get(evt.id) || []).map(r => r.url)
        })
      } else if (action === "uninstall") {
        await ctx.uninstall(nappId)
      } else if (action === "install") {
        const raw = naddrEncode({
          pubkey: evt.pubkey,
          kind: NSITE_NAMED_KIND,
          identifier: dTag,
          relays: Array.from(pool.seenOn.get(evt.id) || []).map(r => r.url)
        })
        await ctx.install(raw)
      }
      if (onChange) {
        onChange()
      } else {
        const replacement = renderCard(evt, ctx, relays)
        card.replaceWith(replacement)
      }
    } catch (err) {
      console.error(err)
      btn.title = (err as any)?.message || String(err)
      btn.textContent = "error"
      btn.disabled = false
      setTimeout(() => {
        btn.textContent = action
        btn.removeAttribute("title")
      }, 3000)
    }
  }

  const makeActionBtn = (action: string, className: string) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = className
    b.textContent = action
    b.addEventListener("click", () => performAction(b, action))
    return b
  }

  const makeDisabledBtn = (label: string, className: string) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = className
    b.textContent = label
    b.disabled = true
    b.setAttribute("aria-disabled", "true")
    return b
  }

  if (updateAvailable) {
    actions.append(
      makeActionBtn("update", "store-install update-available"),
      makeDisabledBtn("installed", "store-install installed")
    )
  } else if (installed) {
    actions.append(makeDisabledBtn("installed", "store-install installed"))
  } else {
    actions.append(makeActionBtn("install", "store-install"))
  }

  if (isOwn) actions.append(menuTrigger)

  head.append(titles, actions)
  card.appendChild(head)

  if (description) {
    const desc = document.createElement("p")
    desc.className = "store-description"
    desc.textContent = description
    card.appendChild(desc)
  }

  if (naddr) {
    const naddrEl = document.createElement("div")
    naddrEl.className = "store-naddr"
    const codeEl = document.createElement("code")
    codeEl.textContent = naddr
    naddrEl.appendChild(codeEl)
    card.appendChild(naddrEl)
  }

  if (categoryTags.length || hashtags.length) {
    const chips = document.createElement("div")
    chips.className = "store-chips"
    for (const cat of categoryTags) {
      const chip = document.createElement("span")
      chip.className = "store-chip store-chip-category"
      chip.textContent = formatCategory(cat)
      chip.title = cat
      chips.appendChild(chip)
    }
    for (const t of hashtags) {
      const chip = document.createElement("span")
      chip.className = "store-chip store-chip-tag"
      chip.textContent = `#${t}`
      chips.appendChild(chip)
    }
    card.appendChild(chips)
  }

  if (source) {
    const src = document.createElement("a")
    src.className = "store-source"
    src.href = source
    src.target = "_blank"
    src.rel = "noopener noreferrer"
    src.textContent = "source ↗"
    card.appendChild(src)
  }

  const detailEl = document.createElement("div")
  detailEl.className = "apps-detail"
  renderDetail(evt).then(html => {
    detailEl.innerHTML = html
    const authorEl = detailEl.querySelector(".apps-detail-author") as HTMLElement
    if (authorEl) {
      authorEl.style.cursor = "pointer"
      authorEl.addEventListener("click", e => {
        e.stopPropagation()
        dispatchAction("apps", "profile", evt.pubkey).catch(() => {})
      })
    }
  })
  card.appendChild(detailEl)

  return card
}

function computeNappId(evt: any) {
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1]
  return `${evt.pubkey.slice(0, 16)}~${dTag || ""}`
}

// ─── helpers ─────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  )
}

function sanitizeRelays(relays: string[]): string[] {
  if (!Array.isArray(relays)) return []
  return [...new Set(relays.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean))]
}

function matchesFilter(evt: any, filter: string) {
  if (!filter) return true
  const fields = [
    evt.tags.find((t: any) => t[0] === "title")?.[1] || "",
    evt.tags.find((t: any) => t[0] === "description")?.[1] || "",
    evt.tags.find((t: any) => t[0] === "d")?.[1] || "",
    evt.pubkey
  ]
  for (const t of evt.tags) {
    if (
      (t[0] === "title" ||
        t[0] === "summary" ||
        t[0] === "description" ||
        t[0] === "l" ||
        t[0] === "t") &&
      typeof t[1] === "string"
    ) {
      fields.push(t[1])
    }
  }
  return fields.some(f => f.toLowerCase().includes(filter))
}

function formatCategory(label: string) {
  const m = /^napp\.([^:]+):(.+)$/.exec(label)
  if (!m) return label
  return `${m[2]} · ${m[1]}`
}
