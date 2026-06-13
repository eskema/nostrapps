export const id = "apps"
export const title = "Apps"
export const slash = "/apps"

import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { naddrEncode } from "@nostr/tools/nip19"
import "nostr-web-components"

import type { SystemCtx } from "../types.js"
import { getDevHandle, nappOriginFor } from "../sandbox/host.js"
import { readOpen } from "../persistence.js"
import { getHandlers, dispatchAction } from "../handlers.js"
import { currentSigner } from "../signers/index.js"
import { SubCloser } from "@nostr/tools/abstract-pool"
import { NSITE_NAMED_KIND } from "../nsite/fetch.js"
import { NostrEvent } from "@nostr/tools"
import { selectApp } from "./appinfo.js"
import { button, type ButtonVariant } from "./ui.js"

const PLACEHOLDER_SRC = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

const DEFAULT_RELAYS = [
  "wss://relay.nostrapps.com/",
  "wss://relay.nostrapps.com/personal",
  "wss://relay.nostrapps.com/internal"
]

export function mount(
  container: HTMLElement,
  ctx: SystemCtx,
  opts: { params?: any; onStateChange?: (state: any) => void } = {}
) {
  let currentTab = "installed"
  let discoverFetched = false

  // ─── Installed tab state ───
  let installedFilter = ""
  let _installedListEl: HTMLElement | null = null
  // Signature of the installed app set; used to skip needless rebuilds (which
  // would collapse any open <details>) when the apps-changed signal fires for
  // unrelated reasons (e.g. a window moved).
  let _installedSig = ""

  // ─── Discover tab state ───
  let filter = ""
  let events: any[] = []
  const eventIds = new Set<string>() // O(1) dedup of incoming events
  let pending: any[] = [] // events arrived since the last incremental flush
  // Restore a previously-saved custom relay list. emitDiscoverState persists it
  // under the session's `params`, which restore feeds back in via opts.params.
  // Empty / absent → fall back to the defaults.
  let relays = sanitizeRelays(opts.params?.relays)
  if (!relays.length) relays = [...DEFAULT_RELAYS]
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

  // Best-effort icon for an installed app: absolute URLs pass through; a path
  // (e.g. "/icon.svg") resolves against the napp's own origin (served by its
  // SW). Falls back to a placeholder on error.
  function installedIconUrl(app: any): string | null {
    const icon = app.icon
    if (!icon || typeof icon !== "string") return null
    if (/^https?:\/\//.test(icon)) return icon
    return `${nappOriginFor(app.nappId)}${icon.startsWith("/") ? "" : "/"}${icon}`
  }

  function installedButtons(app: any): HTMLElement[] {
    if (app.nappId.startsWith("dev~")) {
      return [
        button({
          label: "publish",
          variant: "outline",
          onClick: () =>
            ctx.launchSystemNapp("uploader", {
              params: getDevHandle(app.nappId),
              persistent: false
            })
        })
      ]
    }
    if (app.nappId.startsWith("temp~")) {
      const inst = button({ label: "install", variant: "primary" })
      inst.addEventListener("click", async () => {
        inst.disabled = true
        inst.textContent = "installing…"
        try {
          const raw = app.nappId.slice(5)
          ctx.setStatus?.(`Apps: installing ${raw}…`)
          await ctx.install(raw)
          ctx.setStatus?.(`Apps: installed ${raw}`)
          renderInstalledList()
        } catch (err: any) {
          ctx.setStatus?.(`Apps: install failed for ${app.nappId}: ${err?.message || String(err)}`)
          inst.disabled = false
          inst.textContent = "error"
          inst.title = err?.message || String(err)
          setTimeout(() => {
            inst.textContent = "install"
            inst.removeAttribute("title")
          }, 3000)
        }
      })
      return [inst]
    }
    const del = button({ label: "delete", variant: "danger" })
    del.addEventListener("click", async () => {
      ctx.setStatus?.(`Apps: delete requested for ${app.nappId}`)
      const ok = window.confirm(
        `Delete ${app.petname || app.title || app.nappId}?\n\nThis closes every open window of this app and erases all of its data — files, settings, permissions, and any storage it created. This cannot be undone.`
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
    return [del]
  }

  // Rebuilds only the card list, preserving the search input. Called on
  // keystroke and when the installed set changes.
  function renderInstalledList() {
    const listEl = _installedListEl
    if (!listEl) return
    listEl.innerHTML = ""
    const apps = ctx.apps.list()
    _installedSig = apps.map(a => a.nappId).join(",")
    const needle = installedFilter.trim().toLowerCase()
    const frag = document.createDocumentFragment()
    let shown = 0
    for (const app of apps) {
      const actions = getHandlers(app.nappId)
      const title = app.petname || app.title || app.nappId
      const author = app.event?.pubkey || null
      // Apps without a manifest (no publisher): show a type label + install date
      // in place of author + publish date.
      const authorLabel = author
        ? null
        : app.nappId.startsWith("dev~")
          ? "dev"
          : app.nappId.startsWith("temp~")
            ? "temp"
            : "local"
      const createdAt = app.event?.created_at || app.installedAt || null
      const search = haystackFrom([title, app.title, app.nappId, author, ...actions])
      if (needle && !search.includes(needle)) continue
      shown++
      const openCount = readOpen().filter(s => s.nappId === app.nappId).length
      const metaExtras: HTMLElement[] = []
      if (openCount > 0) {
        const openEl = document.createElement("span")
        openEl.textContent = `${openCount} open`
        metaExtras.push(openEl)
      }
      frag.appendChild(
        renderAppCard({
          nappId: app.nappId,
          title,
          iconUrl: installedIconUrl(app),
          authorPubkey: author,
          authorLabel,
          createdAt,
          actions,
          search,
          buttons: installedButtons(app),
          metaExtras,
          onAuthorClick: author
            ? () => dispatchAction("apps", "profile", author).catch(() => {})
            : undefined,
          onOpen: () => {
            selectApp({
              nappId: app.nappId,
              title,
              iconUrl: installedIconUrl(app),
              authorPubkey: author,
              authorLabel,
              createdAt,
              actions,
              event: app.event || null
            })
            ctx.launchSystemNapp("appinfo", { persistent: false })
          }
        })
      )
    }
    listEl.appendChild(frag)
    if (apps.length === 0 || shown === 0) {
      const empty = document.createElement("div")
      empty.className = "apps-empty"
      empty.textContent = apps.length === 0 ? "No apps installed yet." : "No matches."
      listEl.appendChild(empty)
    }
  }

  function renderInstalled() {
    contentEl.innerHTML = `
      <div class="apps-toolbar">
        <input class="apps-search" type="search" placeholder="Search name, action, id…" />
      </div>
      <div class="apps-list"></div>
    `
    const searchEl = contentEl.querySelector(".apps-search") as HTMLInputElement
    _installedListEl = contentEl.querySelector(".apps-list") as HTMLElement
    searchEl.value = installedFilter
    searchEl.addEventListener("input", () => {
      installedFilter = searchEl.value
      renderInstalledList()
    })
    renderInstalledList()
  }

  // ─── Discover tab ──────────────────────────────────────────────

  let _statusEl: HTMLElement | null = null
  let _listEl: HTMLElement | null = null

  function emitDiscoverState() {
    // Persist under `params` so it round-trips: the host merges this into the
    // session entry, and restore passes session.params back into mount.
    opts.onStateChange?.({ params: { relays: [...relays] } })
  }

  function setStatus(msg: string | undefined) {
    if (!_statusEl) return
    _statusEl.textContent = msg || ""
    _statusEl.hidden = !msg
  }

  // Resolve and assign icon URLs for a set of events. Queries each unique
  // author's blossom servers once, then points every matching card icon at it.
  function loadIcons(evts: any[]) {
    if (!_listEl) return
    const seenIconPks = new Set()
    for (const evt of evts) {
      if (seenIconPks.has(evt.pubkey)) continue
      const hasIcon = evt.tags.some((t: any) => t[0] === "icon" && t[1])
      if (!hasIcon) continue
      seenIconPks.add(evt.pubkey)
      loadBlossomServers(evt.pubkey)
        .then(res => {
          const servers = res?.items ?? []
          if (servers.length === 0) return
          const icons = _listEl!.querySelectorAll(
            `[data-author="${evt.pubkey}"] .apps-card-icon[data-icon-sha]`
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

  // All manifests, sorted newest-first. Filtering is applied as card visibility
  // (see applyFilter), not by excluding events here — so every manifest gets a
  // card and the filter can show/hide them without rebuilding.
  function sortedManifests(evts: any[]) {
    return evts.filter(e => e.kind === NSITE_NAMED_KIND).sort((a, b) => b.created_at - a.created_at)
  }

  // Add / update / remove the placeholder based on whether there are any cards
  // and whether any are visible under the current filter. Uses :not([hidden])
  // so it short-circuits instead of counting every card.
  function refreshEmptyState() {
    if (!_listEl) return
    const hasAnyCard = !!_listEl.querySelector(".apps-card")
    const hasVisible = !!_listEl.querySelector(".apps-card:not([hidden])")
    const existing = _listEl.querySelector(".apps-empty") as HTMLElement | null
    const msg = !hasAnyCard ? "No napps found." : !hasVisible ? "No matches." : null
    if (!msg) {
      existing?.remove()
      return
    }
    if (existing) {
      existing.textContent = msg
    } else {
      const empty = document.createElement("div")
      empty.className = "apps-empty"
      empty.textContent = msg
      _listEl.appendChild(empty)
    }
  }

  // Show/hide existing cards against the current filter — no rebuild, no
  // refetch. O(N) boolean toggles instead of recreating the DOM per keystroke.
  function applyFilter() {
    if (!_listEl) return
    const needle = filter.trim().toLowerCase()
    const cards = _listEl.querySelectorAll(".apps-card") as NodeListOf<HTMLElement>
    for (const card of cards) {
      card.hidden = needle ? !(card.dataset.search || "").includes(needle) : false
    }
    refreshEmptyState()
  }

  // Full rebuild. Used for initial paint and relay changes — anything that
  // replaces the whole event set. Streaming arrivals go through flushPending()
  // (append) and filter changes through applyFilter() (show/hide).
  function renderList() {
    if (!_listEl) return
    _listEl.innerHTML = ""
    pending = [] // a full rebuild already covers everything buffered

    const all = sortedManifests(events)
    const frag = document.createDocumentFragment()
    for (const evt of all) {
      const card = renderCard(evt, ctx, relays, renderList)
      card.hidden = !matchesFilter(evt, filter)
      frag.appendChild(card)
    }
    _listEl.appendChild(frag)
    loadIcons(all)
    refreshEmptyState()
  }

  // Incremental append. Builds cards only for the buffered batch and appends
  // them in one fragment, leaving existing cards untouched — O(batch) per frame
  // instead of rebuilding the whole list on every event.
  let flushScheduled = false
  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    requestAnimationFrame(() => {
      flushScheduled = false
      flushPending()
    })
  }

  function flushPending() {
    if (!_listEl || pending.length === 0) return
    const batch = pending
    pending = []
    const toRender = sortedManifests(batch)
    if (toRender.length === 0) return
    // Drop the placeholder before the merge so the ref walk only sees cards.
    _listEl.querySelector(".apps-empty")?.remove()

    // Merge the sorted-desc batch into the sorted-desc list. Both are ordered
    // newest-first, so a single forward walk of the existing cards inserts each
    // new card in its created_at slot — O(batch + N) and order stays correct
    // even for late arrivals, instead of dumping the batch at the end. Cards
    // that don't match the active filter are inserted hidden.
    let ref = _listEl.firstElementChild
    for (const evt of toRender) {
      const card = renderCard(evt, ctx, relays, renderList)
      card.hidden = !matchesFilter(evt, filter)
      while (ref && Number((ref as HTMLElement).dataset.createdAt || 0) >= evt.created_at) {
        ref = ref.nextElementSibling
      }
      _listEl.insertBefore(card, ref)
    }
    loadIcons(toRender)
    refreshEmptyState()
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
    eventIds.clear()
    pending = []
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
          if (eventIds.has(event.id)) return
          eventIds.add(event.id)
          events.push(event)
          pending.push(event)
          scheduleFlush()
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
          scheduleFlush()
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
      <div class="apps-toolbar">
        <input class="apps-search" type="search" placeholder="Search title, description, npub…" />
      </div>
      <details class="apps-relays">
        <summary>edit relays</summary>
        <label class="apps-relays-label">Relays (one per line — leave empty to use your kind 10002, or fall back to defaults)</label>
        <textarea class="apps-relays-input" rows="4" spellcheck="false"></textarea>
        <div class="apps-relays-actions">
          <button type="button" class="btn btn-primary apps-relays-save">save &amp; refresh</button>
          <button type="button" class="btn btn-outline apps-relays-clear">clear</button>
        </div>
      </details>
      <div class="apps-status" hidden></div>
      <div class="apps-list"></div>
    `

    _statusEl = contentEl.querySelector(".apps-status") as HTMLElement
    _listEl = contentEl.querySelector(".apps-list") as HTMLElement
    const searchEl = contentEl.querySelector(".apps-search") as HTMLInputElement
    const relaysPanel = contentEl.querySelector(".apps-relays") as HTMLDetailsElement
    const relaysInput = contentEl.querySelector(".apps-relays-input") as HTMLInputElement
    const relaysSaveBtn = contentEl.querySelector(".apps-relays-save") as HTMLElement
    const relaysClearBtn = contentEl.querySelector(".apps-relays-clear") as HTMLElement

    relaysInput.value = relays.join("\n")
    // Re-seed the search box from the persisted filter so switching away to the
    // Installed tab and back keeps the input in sync with the (still-filtered) list.
    searchEl.value = filter

    searchEl.addEventListener("input", () => {
      // Keep the raw text as typed (casing preserved for re-seeding the input);
      // applyFilter normalizes when comparing. Toggles card visibility instead
      // of rebuilding the list.
      filter = searchEl.value
      applyFilter()
    })

    relaysSaveBtn.addEventListener("click", () => {
      relays = sanitizeRelays(relaysInput.value.split("\n"))
      if (relays.length === 0) relays = [...DEFAULT_RELAYS]
      relaysInput.value = relays.join("\n")
      emitDiscoverState()
      relaysPanel.open = false
      startDiscoverSubscription()
    })

    relaysClearBtn.addEventListener("click", () => {
      relays = [...DEFAULT_RELAYS]
      relaysInput.value = relays.join("\n")
      emitDiscoverState()
      relaysPanel.open = false
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
    if (currentTab !== "installed") return
    // Only rebuild when the set of installed apps actually changed — otherwise
    // an unrelated apps-changed signal (fired on window moves) would collapse
    // any <details> the user just opened.
    if (
      ctx.apps
        .list()
        .map(a => a.nappId)
        .join(",") === _installedSig
    )
      return
    renderInstalledList()
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

// ─── Unified app card (Installed + Discover render the same shape) ──

interface AppCardOpts {
  nappId: string
  title: string
  iconSha?: string | null
  iconMime?: string | null
  iconUrl?: string | null
  authorPubkey?: string | null
  authorLabel?: string | null // plain text shown in place of author (e.g. "local")
  createdAt?: number | null
  actions: string[]
  search: string
  buttons: HTMLElement[]
  menuTrigger?: HTMLElement | null
  metaExtras?: HTMLElement[]
  onAuthorClick?: () => void
  onOpen?: () => void // clicking the card (away from buttons/author) opens full info
}

// One card shape for both tabs: head (icon · title · meta · action chips ·
// buttons) plus a collapsed <details> built lazily on first expand. data-*
// attributes drive filtering (search), sorted insertion (createdAt) and icon
// resolution (author).
function renderAppCard(o: AppCardOpts): HTMLElement {
  const card = document.createElement("div")
  card.className = "apps-card"
  card.dataset.nappId = o.nappId
  if (o.authorPubkey) card.dataset.author = o.authorPubkey
  if (o.createdAt) card.dataset.createdAt = String(o.createdAt)
  card.dataset.search = o.search

  const head = document.createElement("div")
  head.className = "apps-card-head"

  if (o.iconSha || o.iconUrl) {
    const icon = document.createElement("img")
    icon.className = "apps-card-icon"
    icon.alt = ""
    if (o.iconSha) {
      icon.dataset.iconSha = o.iconSha
      if (o.iconMime) icon.dataset.iconMime = o.iconMime
      icon.src = PLACEHOLDER_SRC
    } else {
      icon.src = o.iconUrl!
      icon.addEventListener("error", () => {
        icon.src = PLACEHOLDER_SRC
      })
    }
    head.appendChild(icon)
  }

  const titles = document.createElement("div")
  titles.className = "apps-card-titles"

  const h = document.createElement("h3")
  h.className = "apps-title"
  h.textContent = o.title
  titles.appendChild(h)

  const meta = document.createElement("div")
  meta.className = "apps-meta"
  if (o.authorPubkey) {
    const author = document.createElement("span")
    author.className = "apps-author"
    if (o.onAuthorClick) {
      author.style.cursor = "pointer"
      author.addEventListener("click", e => {
        e.stopPropagation()
        o.onAuthorClick!()
      })
    }
    const pic = document.createElement("nostr-picture")
    pic.className = "apps-author-pic"
    pic.setAttribute("pubkey", o.authorPubkey)
    const name = document.createElement("nostr-name")
    name.className = "apps-author-name"
    name.setAttribute("pubkey", o.authorPubkey)
    author.append(pic, name)
    meta.appendChild(author)
  } else if (o.authorLabel) {
    const label = document.createElement("span")
    label.className = "apps-author apps-author-label"
    label.textContent = o.authorLabel
    meta.appendChild(label)
  }
  if (o.createdAt) {
    const dateEl = document.createElement("span")
    dateEl.className = "apps-date"
    dateEl.textContent = new Date(o.createdAt * 1000).toLocaleDateString()
    meta.appendChild(dateEl)
  }
  for (const el of o.metaExtras || []) meta.appendChild(el)
  if (meta.childElementCount) titles.appendChild(meta)

  if (o.actions.length) {
    const chips = document.createElement("div")
    chips.className = "apps-handlers"
    for (const a of o.actions) {
      const chip = document.createElement("span")
      chip.className = "apps-handler"
      chip.textContent = a
      chips.appendChild(chip)
    }
    titles.appendChild(chips)
  }

  const actions = document.createElement("div")
  actions.className = "apps-actions"
  for (const b of o.buttons) actions.appendChild(b)
  if (o.menuTrigger) actions.appendChild(o.menuTrigger)

  head.append(titles, actions)
  card.appendChild(head)

  // Clicking the card (anywhere but a button or the author) opens the full-info
  // window. The card itself stays minimal — no inline details.
  if (o.onOpen) {
    card.classList.add("apps-card-clickable")
    card.addEventListener("click", e => {
      if ((e.target as Element).closest("button, a, .apps-author")) return
      o.onOpen!()
    })
  }

  return card
}

// ─── Discover card rendering ─────────────────────────────────────

function renderCard(evt: NostrEvent, ctx: SystemCtx, relays: string[], onChange: any = null) {
  const tag = (k: string) => evt.tags.find((t: any) => t[0] === k)?.[1] || ""
  const dTag = tag("d")
  const nappId = computeNappId(evt)
  const installed = ctx.isInstalled?.(nappId) ?? false
  const installedEvents = ctx.apps.events?.() ?? []
  const installedEvent = installedEvents.find((e: any) => computeNappId(e) === nappId)
  const updateAvailable = installed && installedEvent && installedEvent.created_at < evt.created_at

  const title = tag("title")
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

  // Assigned after renderAppCard() returns; menu/buttons close over it.
  let card: HTMLElement

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
    menuEl.className = "apps-card-menu"
    const btn = document.createElement("button")
    btn.type = "button"
    btn.textContent = "request delete"
    btn.addEventListener("click", async () => {
      closeMenu()
      ctx.setStatus?.("Requesting deletion of app event…")
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
        ctx.setStatus?.(`Deletion event sent to ${ok}/${relays.length} relays`)
      } catch (err: any) {
        ctx.setStatus?.(`Deletion failed — ${err.message}`)
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

  let menuTrigger: HTMLButtonElement | null = null
  if (isOwn) {
    menuTrigger = button({
      label: "···",
      variant: "ghost",
      class: "apps-card-menu-trigger",
      onClick: toggleMenu
    })
  }

  const performAction = async (btn: HTMLButtonElement, action: string) => {
    btn.disabled = true
    btn.textContent = action === "update" ? "updating…" : "launching…"
    try {
      if (action === "update") {
        await ctx.update({
          pubkey: evt.pubkey,
          dTag: dTag,
          relayHints: Array.from(pool.seenOn.get(evt.id) || []).map(r => r.url)
        })
        // NOTE: an "uninstall" action used to live here, calling ctx.uninstall(nappId)
        // with no confirm. It was never wired to any button (makeActionBtn is only
        // ever called with "update"/"install"), so it's commented out to avoid an
        // unconfirmed wipe path. The confirmed Installed-tab `delete` button is the
        // sole entry point for wiping an app.
        // } else if (action === "uninstall") {
        //   await ctx.uninstall(nappId)
      } else if (action === "install") {
        const raw = naddrEncode({
          pubkey: evt.pubkey,
          kind: NSITE_NAMED_KIND,
          identifier: dTag,
          relays: Array.from(pool.seenOn.get(evt.id) || []).map(r => r.url)
        })
        const nappId = await ctx.install(raw)
        // Launch right after install — the boot just completed so the napp's
        // service worker is freshly active, the best moment to open its window.
        await ctx.launchNapp?.(nappId, title || dTag || undefined)
      }
      if (onChange) {
        onChange()
      } else {
        const replacement = renderCard(evt, ctx, relays)
        card.replaceWith(replacement)
      }
    } catch (err) {
      const message = (err as any)?.message || String(err)
      console.error(err)
      // Surface the failure in /logs, not just the console — an install that
      // can't fetch its files should leave a timestamped trail.
      ctx.setStatus?.(`${action} failed for ${title || dTag || nappId} — ${message}`)
      btn.title = message
      btn.textContent = "error"
      btn.disabled = false
      setTimeout(() => {
        btn.textContent = action
        btn.removeAttribute("title")
      }, 3000)
    }
  }

  const makeActionBtn = (action: string, variant: ButtonVariant) => {
    const b = button({ label: action, variant })
    b.addEventListener("click", () => performAction(b, action))
    return b
  }

  const makeDisabledBtn = (label: string) => {
    const b = button({ label, variant: "outline", disabled: true })
    b.setAttribute("aria-disabled", "true")
    return b
  }

  const buttons: HTMLElement[] = []
  if (updateAvailable) {
    buttons.push(makeActionBtn("update", "warning"), makeDisabledBtn("installed"))
  } else if (installed) {
    buttons.push(makeDisabledBtn("installed"))
  } else {
    buttons.push(makeActionBtn("install", "primary"))
  }

  card = renderAppCard({
    nappId,
    title: title || `(${dTag})`,
    iconSha,
    iconMime,
    authorPubkey: evt.pubkey,
    createdAt: evt.created_at,
    actions: actionsOf(evt),
    search: searchHaystack(evt),
    buttons,
    menuTrigger,
    onAuthorClick: () => {
      dispatchAction("apps", "profile", evt.pubkey).catch(() => {})
    },
    onOpen: () => {
      selectApp({
        nappId,
        title: title || `(${dTag})`,
        iconSha,
        iconMime,
        authorPubkey: evt.pubkey,
        createdAt: evt.created_at,
        actions: actionsOf(evt),
        event: evt,
        naddr,
        seenOnRelays
      })
      ctx.launchSystemNapp("appinfo", { persistent: false })
    }
  })

  return card
}

function computeNappId(evt: any) {
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1]
  return `${evt.pubkey.slice(0, 16)}~${dTag || ""}`
}

// ─── helpers ─────────────────────────────────────────────────────

function sanitizeRelays(relays: string[]): string[] {
  if (!Array.isArray(relays)) return []
  return [...new Set(relays.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean))]
}

// The lowercased text a card is searched against. Stored on each card as
// data-search so filtering can be done by toggling visibility instead of
// rebuilding, and used by matchesFilter so both stay in sync.
function searchHaystack(evt: any): string {
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
        t[0] === "t" ||
        t[0] === "action") && // fold actions into search so they're filterable
      typeof t[1] === "string"
    ) {
      fields.push(t[1])
    }
  }
  return fields.join("\n").toLowerCase()
}

// Action/handler names a manifest declares.
function actionsOf(evt: any): string[] {
  return evt.tags.filter((t: any) => t[0] === "action" && t[1]).map((t: any) => t[1])
}

// Build a lowercased search string from arbitrary parts (used by the Installed
// tab, whose data is an InstalledApp rather than an event).
function haystackFrom(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join("\n").toLowerCase()
}

function matchesFilter(evt: any, filter: string) {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  return searchHaystack(evt).includes(needle)
}
