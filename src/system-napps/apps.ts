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

  // ─── Installed tab state ───
  let installedFilter = ""
  let _installedListEl: HTMLElement | null = null
  // Signature of the installed app set; used to skip needless rebuilds (which
  // would collapse any open <details>) when the apps-changed signal fires for
  // unrelated reasons (e.g. a window moved).
  let _installedSig = ""
  // Signature of which installed apps currently have an update available, so the
  // streaming discovery subscription only re-renders the list when it changes.
  let _installedUpdatesSig = ""

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
      <div class="apps-content">
        <div class="apps-pane apps-pane-installed"></div>
        <div class="apps-pane apps-pane-discover" hidden></div>
      </div>
    </div>
  `

  const installedPane = container.querySelector(".apps-pane-installed") as HTMLElement
  const discoverPane = container.querySelector(".apps-pane-discover") as HTMLElement
  const installedTab = container.querySelector(".installed-tab") as HTMLElement
  const discoverTab = container.querySelector(".discover-tab") as HTMLElement

  // Both panes are built once and kept in the DOM; switching tabs just toggles
  // visibility (no rebuild) so each list, its scroll, and inputs persist. The
  // discover pane is built lazily on first view; discovery itself runs up front.
  let installedBuilt = false
  let discoverBuilt = false

  function switchTab(tab: string) {
    currentTab = tab
    installedTab.classList.toggle("active", tab === "installed")
    discoverTab.classList.toggle("active", tab === "discover")
    if (tab === "installed") {
      if (!installedBuilt) {
        renderInstalled()
        installedBuilt = true
      }
      refreshInstalledUpdates() // catch up on updates discovery found while away
    } else if (!discoverBuilt) {
      renderDiscover()
      discoverBuilt = true
    }
    installedPane.hidden = tab !== "installed"
    discoverPane.hidden = tab !== "discover"
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

  // The newest discovered manifest strictly newer than the one we installed, or
  // null. Fed by the shared discovery subscription (started on mount), so the
  // installed tab gets update detection for free — no per-app query.
  function latestUpdateFor(app: any): any | null {
    const base = app.event?.created_at
    if (!base) return null // local/dev/temp apps have no manifest → no updates
    let best: any = null
    for (const e of events) {
      if (e.kind !== NSITE_NAMED_KIND || e.created_at <= base) continue
      if (computeNappId(e) !== app.nappId) continue
      if (!best || e.created_at > best.created_at) best = e
    }
    return best
  }

  // An "update" button for an installed app, pointed at the newer manifest `evt`.
  function makeInstalledUpdateBtn(app: any, evt: any): HTMLElement {
    const b = button({ label: "update", variant: "warning" })
    b.addEventListener("click", async () => {
      b.disabled = true
      b.textContent = "updating…"
      try {
        const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1] || ""
        await ctx.update({
          pubkey: evt.pubkey,
          dTag,
          relayHints: Array.from(pool.seenOn.get(evt.id) || []).map((r: any) => r.url)
        })
        ctx.setStatus?.(`Apps: updated ${app.petname || app.title || app.nappId}`)
        renderInstalledList()
      } catch (err: any) {
        const m = err?.message || String(err)
        ctx.setStatus?.(`Apps: update failed for ${app.nappId}: ${m}`)
        b.disabled = false
        b.textContent = "error"
        b.title = m
        setTimeout(() => {
          b.textContent = "update"
          b.removeAttribute("title")
        }, 3000)
      }
    })
    return b
  }

  // Signature of the apps-with-updates set (over ALL installed apps, regardless
  // of the search filter) — used to know when the streaming discovery changed it.
  function installedUpdateSig(): string {
    return ctx.apps
      .list()
      .filter(a => latestUpdateFor(a))
      .map(a => a.nappId)
      .sort()
      .join(",")
  }

  // Re-render the installed tab when discovery changes which apps have updates.
  function refreshInstalledUpdates() {
    if (currentTab !== "installed" || !_installedListEl) return
    if (installedUpdateSig() !== _installedUpdatesSig) renderInstalledList()
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
      const upd = latestUpdateFor(app)
      const buttons = upd
        ? [makeInstalledUpdateBtn(app, upd), ...installedButtons(app)]
        : installedButtons(app)
      const description =
        app.event?.tags.find((t: any) => t[0] === "description")?.[1] ||
        app.event?.tags.find((t: any) => t[0] === "summary")?.[1] ||
        null
      // Published apps carry a manifest → resolve the icon from blossom (same as
      // discover, doesn't depend on the napp's SW). Local/dev/temp apps have no
      // manifest → fall back to their own origin path, served by their SW.
      const iconSha = app.event ? resolveCardIcon(app.event).sha : null
      frag.appendChild(
        renderAppCard({
          nappId: app.nappId,
          title,
          description,
          iconSha,
          iconUrl: iconSha ? null : installedIconUrl(app),
          authorPubkey: author,
          authorLabel,
          createdAt,
          actions,
          search,
          buttons,
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
    // Load icons from blossom for the published apps (those with a manifest).
    loadCardIcons(
      listEl,
      apps.filter(a => a.event).map(a => ({ nappId: a.nappId, evt: a.event }))
    )
    _installedUpdatesSig = installedUpdateSig()
  }

  function renderInstalled() {
    installedPane.innerHTML = `
      <div class="apps-toolbar">
        <input class="apps-search" type="search" placeholder="Search name, action, id…" />
      </div>
      <div class="apps-list"></div>
    `
    const searchEl = installedPane.querySelector(".apps-search") as HTMLInputElement
    _installedListEl = installedPane.querySelector(".apps-list") as HTMLElement
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
  // Cache per-author blossom lists so each is fetched once per render.
  const blossomCache = new Map<string, Promise<string[]>>()
  function authorBlossom(pubkey: string): Promise<string[]> {
    let p = blossomCache.get(pubkey)
    if (!p) {
      p = loadBlossomServers(pubkey)
        .then((r: any) => (r?.items ?? []) as string[])
        .catch(() => [])
      blossomCache.set(pubkey, p)
    }
    return p
  }
  const normalizeServer = (s: string) => {
    const u = s.endsWith("/") ? s.slice(0, -1) : s
    return u.startsWith("http") ? u : `https://${u}`
  }

  // Load card icons from blossom for any list (discover or installed). Each item
  // pairs a card's nappId with its manifest event (for the icon sha + servers).
  function loadCardIcons(listEl: HTMLElement | null, items: Array<{ nappId: string; evt: any }>) {
    if (!listEl) return
    for (const { nappId, evt } of items) {
      if (!evt) continue
      const { sha } = resolveCardIcon(evt)
      if (!sha) continue
      const img = listEl.querySelector(
        `.apps-card[data-napp-id="${CSS.escape(nappId)}"] .apps-card-icon`
      ) as HTMLImageElement | null
      if (!img || img.dataset.iconLoaded === "1") continue
      img.dataset.iconLoaded = "1"
      // Candidate servers, mirroring fetchNsite: the manifest's own `server`
      // tags + the author's blossom list + the default — the blob can be on any.
      const manifestServers = evt.tags
        .filter((t: any) => t[0] === "server" && t[1])
        .map((t: any) => t[1])
      authorBlossom(evt.pubkey).then((userServers: string[]) => {
        const servers = [
          ...new Set(
            [...manifestServers, ...userServers, "relay.nostrapps.com"].map(normalizeServer)
          )
        ]
        let i = 0
        const tryNext = () => {
          if (i >= servers.length) {
            img.src = PLACEHOLDER_SRC
            return
          }
          img.src = `${servers[i++]}/${sha}`
        }
        img.onerror = tryNext
        tryNext()
      })
    }
  }

  function loadIcons(evts: any[]) {
    loadCardIcons(
      _listEl,
      evts.map((e: any) => ({ nappId: computeNappId(e), evt: e }))
    )
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
      flushPending() // discover list DOM (no-op until the tab is opened)
      refreshInstalledUpdates() // installed tab's update badges
    })
  }

  function flushPending() {
    // _listEl may be detached when the discover tab isn't the active one — skip
    // the DOM work; renderList() repaints from `events` when it's reopened.
    if (!_listEl || !_listEl.isConnected || pending.length === 0) return
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
    sawEose = false
    // Don't wipe events/eventIds here: re-subscribing on the shared pool won't
    // re-deliver already-seen events, so clearing would empty the list until a
    // page reload. We keep what we have and let the new relays' unseen events
    // append (eventIds dedupes the rest). Adding a relay therefore grows the list.

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
    discoverPane.innerHTML = `
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

    _statusEl = discoverPane.querySelector(".apps-status") as HTMLElement
    _listEl = discoverPane.querySelector(".apps-list") as HTMLElement
    const searchEl = discoverPane.querySelector(".apps-search") as HTMLInputElement
    const relaysPanel = discoverPane.querySelector(".apps-relays") as HTMLDetailsElement
    const relaysInput = discoverPane.querySelector(".apps-relays-input") as HTMLInputElement
    const relaysSaveBtn = discoverPane.querySelector(".apps-relays-save") as HTMLElement
    const relaysClearBtn = discoverPane.querySelector(".apps-relays-clear") as HTMLElement

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

    // The subscription is already running (started on mount); just paint what it
    // has collected so far. Streaming arrivals append via flushPending.
    renderList()
    emitDiscoverState()
  }

  // ─── Render ────────────────────────────────────────────────────

  // Build the default (installed) pane now; the discover pane is built on first
  // view. Both are kept thereafter — switchTab only toggles their visibility.
  renderInstalled()
  installedBuilt = true
  // Start discovery once, up front (above the tabs), so it feeds BOTH: the
  // discover list when that tab is opened, and the installed tab's update
  // detection — a single relay query instead of one per installed app.
  startDiscoverSubscription()
  const unsub = ctx.apps.subscribe(() => {
    if (!installedBuilt) return
    // Only rebuild when the set of installed apps actually changed — otherwise
    // an unrelated apps-changed signal (fired on window moves) would collapse
    // any <details> the user just opened. Keeps the (possibly hidden) installed
    // pane fresh regardless of which tab is active.
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
  description?: string | null
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

  // Flat structure: icon, title, author/label, date, meta extras, handlers and
  // actions are all direct children of .apps-card.

  // Icon — always present (even when empty) so the layout slot is stable.
  const icon = document.createElement("img")
  icon.className = "apps-card-icon"
  icon.alt = ""
  if (o.iconSha) {
    icon.dataset.iconSha = o.iconSha
    if (o.iconMime) icon.dataset.iconMime = o.iconMime
    icon.src = PLACEHOLDER_SRC
  } else if (o.iconUrl) {
    icon.src = o.iconUrl
    icon.addEventListener("error", () => {
      icon.src = PLACEHOLDER_SRC
    })
  } else {
    icon.src = PLACEHOLDER_SRC
  }
  card.appendChild(icon)

  const h = document.createElement("h3")
  h.className = "apps-title"
  h.textContent = o.title
  card.appendChild(h)

  if (o.description) {
    const desc = document.createElement("p")
    desc.className = "apps-description"
    desc.textContent = o.description
    card.appendChild(desc)
  }

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
    card.appendChild(author)
  } else if (o.authorLabel) {
    const label = document.createElement("span")
    label.className = "apps-author apps-author-label"
    label.textContent = o.authorLabel
    card.appendChild(label)
  }

  if (o.createdAt) {
    const dateEl = document.createElement("span")
    dateEl.className = "apps-date"
    dateEl.textContent = new Date(o.createdAt * 1000).toLocaleDateString()
    card.appendChild(dateEl)
  }

  for (const el of o.metaExtras || []) card.appendChild(el)

  if (o.actions.length) {
    const chips = document.createElement("div")
    chips.className = "apps-handlers"
    for (const a of o.actions) {
      const chip = document.createElement("span")
      chip.className = "apps-handler"
      chip.textContent = a
      chips.appendChild(chip)
    }
    card.appendChild(chips)
  }

  const actions = document.createElement("div")
  actions.className = "apps-actions"
  for (const b of o.buttons) actions.appendChild(b)
  if (o.menuTrigger) actions.appendChild(o.menuTrigger)
  card.appendChild(actions)

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
  const { sha: iconSha, mime: iconMime } = resolveCardIcon(evt)
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
  // Own-app menu (request delete). Built as a popover so it renders in the top
  // layer (never clipped or mis-stacked under the card), light-dismisses on
  // outside-click / Esc for free, and is anchored right under its trigger.
  let menuEl: HTMLDivElement | null = null
  let menuTrigger: HTMLButtonElement | null = null
  if (isOwn) {
    menuEl = document.createElement("div")
    menuEl.className = "apps-card-menu"
    menuEl.popover = "auto"
    menuEl.addEventListener("click", e => e.stopPropagation()) // don't open app-info
    const delBtn = button({ label: "request delete", variant: "danger" })
    delBtn.addEventListener("click", async () => {
      menuEl?.hidePopover()
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
    menuEl.appendChild(delBtn)

    menuTrigger = button({ label: "···", variant: "ghost", class: "apps-card-menu-trigger" })
    menuTrigger.popoverTargetElement = menuEl
    // Place it under the trigger (right-aligned) just before it opens.
    menuEl.addEventListener("beforetoggle", (ev: Event) => {
      if ((ev as ToggleEvent).newState !== "open" || !menuTrigger) return
      const r = menuTrigger.getBoundingClientRect()
      menuEl!.style.top = `${Math.round(r.bottom + 4)}px`
      menuEl!.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`
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
    description: tag("description") || tag("summary"),
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

  // The menu popover lives in the card so it's removed with it; top-layer
  // rendering means its DOM position doesn't affect where it shows.
  if (menuEl) card.appendChild(menuEl)

  return card
}

function computeNappId(evt: any) {
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1]
  return `${evt.pubkey.slice(0, 16)}~${dTag || ""}`
}

// Conventional icon filenames to fall back to when no icon is declared.
const ICON_FALLBACK_PATHS = [
  "/icon.svg",
  "/favicon.svg",
  "/icon.png",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/favicon.ico"
]

// Resolve a discover card's icon to a blossom sha (loadIcons fetches it from the
// author's blossom servers). The `icon` tag may hold a blossom sha OR a path
// (e.g. "/icon.svg" from metadata.json) — for a path we map it to the file's sha
// via the manifest's `path` tags. With no usable icon tag we fall back to a
// conventional icon file among the manifest's paths.
function resolveCardIcon(evt: any): { sha: string | null; mime: string | null } {
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  // Match regardless of a leading slash on either side (manifests vary).
  const findPath = (p: string) => {
    const want = String(p).replace(/^\//, "")
    return pathTags.find((t: any) => String(t[1]).replace(/^\//, "") === want)
  }
  const iconTag = evt.tags.find((t: any) => t[0] === "icon" && t[1])
  if (iconTag) {
    const val = iconTag[1] as string
    if (/^[0-9a-f]{64}$/i.test(val)) return { sha: val, mime: iconTag[2] || null }
    const pt = findPath(val)
    if (pt) return { sha: pt[2], mime: pt[3] || null }
  }
  for (const candidate of ICON_FALLBACK_PATHS) {
    const pt = findPath(candidate)
    if (pt) return { sha: pt[2], mime: pt[3] || null }
  }
  return { sha: null, mime: null }
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
