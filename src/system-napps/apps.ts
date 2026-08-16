export const id = "apps"
export const title = "Apps"
export const slash = "/apps"

import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { naddrEncode, npubEncode } from "@nostr/tools/nip19"
import { loadNostrUser } from "@nostr/gadgets/metadata"
import "nostr-web-components"

import type { AppType, InstalledApp, SystemCtx } from "../types.js"
import { classifyEvent, classifyInstalled, getNappletConfig } from "../persistence.js"
import { unsupportedRequires } from "../napp-permissions.js"
import { openNappConfigSettings } from "../napp-config.js"
import { getDevHandle, nappOriginFor } from "../sandbox/host.js"
import { dispatchAction } from "../handlers.js"
import { currentSigner } from "../signers/index.js"
import { SubCloser } from "@nostr/tools/abstract-pool"
import { NSITE_NAMED_KIND } from "../nsite/fetch.js"
import { NAPPLET_NAMED_KIND } from "../nsite/napplet.js"
import { NostrEvent } from "@nostr/tools"
import { BlossomClient } from "@nostr/tools/nipb7"
import { publishOutcomes } from "../utils.js"
import { hasBytes } from "../nsite/heal.js"

// Addressable app kinds shown in Discover: nsites (35128) + named napplets (35129).
const DISCOVER_KINDS = [NSITE_NAMED_KIND, NAPPLET_NAMED_KIND]
import {
  addControl,
  button,
  check,
  chip,
  details,
  item,
  itemList,
  overline,
  type ButtonVariant
} from "./ui.js"

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

  // Type filter shared across both tabs (all · nsites · napps · napplets).
  let typeFilter: "all" | AppType = "all"
  // A segmented control bound to typeFilter; re-applies both tabs' filters on
  // change. Each pane renders its own instance (kept in sync via typeFilter).
  function buildTypeSegments(): HTMLElement {
    const seg = document.createElement("div")
    seg.className = "apps-typeseg"
    const opts: Array<["all" | AppType, string]> = [
      ["all", "all"],
      ["nsite", "nsites"],
      ["napp", "napps"],
      ["napplet", "napplets"]
    ]
    const btns = opts.map(([val, label]) =>
      chip({
        label,
        active: typeFilter === val,
        onClick: () => {
          typeFilter = val
          btns.forEach((b, i) => {
            b.classList.toggle("btn-primary", opts[i][0] === val)
            b.classList.toggle("btn-ghost", opts[i][0] !== val)
          })
          applyInstalledFilter()
          applyFilter()
        }
      })
    )
    for (const b of btns) seg.appendChild(b)
    return seg
  }

  // ─── Discover tab state ───
  let filter = ""
  // Newest manifest per napp address (computeNappId). Relays replace
  // addressable events on write, but a stale version still arrives from any
  // relay the newer publish didn't reach — the collapse happens here.
  const manifests = new Map<string, any>()
  let pending: any[] = [] // events arrived since the last incremental flush
  // Restore a previously-saved custom relay list. emitDiscoverState persists it
  // under the session's `params`, which restore feeds back in via opts.params.
  // Empty / absent → fall back to the defaults. `disabled` is the subset the
  // user has toggled off — still listed in the editor, but not subscribed, and
  // napps seen only on disabled relays are hidden from the list.
  let relays = sanitizeRelays(opts.params?.relays)
  if (!relays.length) relays = [...DEFAULT_RELAYS]
  const disabled = new Set<string>(
    sanitizeRelays(opts.params?.disabled).filter(r => relays.includes(r))
  )
  // One subscription per relay so a single relay can be toggled or removed
  // without restarting the others. `relayEose` tracks which finished their
  // initial load; `nappRelays` maps napp address → relay → the newest
  // created_at that relay served for it. Drives the per-relay counts,
  // disabled-relay hiding, and staleness (relay timestamp < newest known =
  // that relay is missing the latest version).
  const subs = new Map<string, SubCloser>()
  const relayEose = new Set<string>()
  const nappRelays = new Map<string, Map<string, number>>()

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
      <div class="apps-detail-overlay" hidden></div>
    </div>
  `

  const appsPanel = container.querySelector(".apps-panel") as HTMLElement
  const installedPane = container.querySelector(".apps-pane-installed") as HTMLElement
  const discoverPane = container.querySelector(".apps-pane-discover") as HTMLElement
  const detailOverlay = container.querySelector(".apps-detail-overlay") as HTMLElement
  const installedTab = container.querySelector(".installed-tab") as HTMLElement
  const discoverTab = container.querySelector(".discover-tab") as HTMLElement

  // Clicking a card lays the app-info detail over the whole panel (absolute,
  // inset:0) instead of replacing the list — closing it just hides the overlay,
  // so the list underneath keeps its scroll position and built state. Structure:
  // images (if any) → the list-item card (rebuilt, non-clickable, actions live)
  // → remaining info → files <details>.
  function closeDetail() {
    detailOverlay.hidden = true
    detailOverlay.replaceChildren()
    appsPanel.classList.remove("has-overlay")
  }
  function showDetail(req: DetailReq) {
    const back = button({
      label: "← back",
      variant: "ghost",
      class: "apps-detail-back",
      onClick: closeDetail
    })
    detailOverlay.replaceChildren(back)
    const imgs = detailImages(req.event)
    if (imgs) detailOverlay.appendChild(imgs)
    const card = req.buildCard()
    // The list card names unsupported requires in its badge; in detail the
    // requires chips below carry that (red), so the line would be redundant.
    card.querySelector(".apps-unsupported")?.remove()
    // Requires — lumped in with the action chips, detail view only (too noisy
    // in the list).
    const reqs = req.event ? requiresOf(req.event) : []
    if (reqs.length) {
      const unsupported = new Set(unsupportedRequires(reqs))
      let chips = card.querySelector<HTMLElement>(".apps-handlers")
      if (!chips) {
        chips = document.createElement("div")
        chips.className = "apps-handlers"
        card.appendChild(chips)
      }
      for (const r of reqs) {
        const c = document.createElement("span")
        // Unsupported requirements are flagged red — the launcher can't provide
        // them, so those features won't work.
        c.className = unsupported.has(r) ? "apps-handler is-unsupported" : "apps-handler"
        c.textContent = r
        chips.appendChild(c)
      }
    }
    detailOverlay.appendChild(card)
    detailOverlay.appendChild(detailInfo(req, nappRelays.get(req.nappId), ctx, updateRelayCounts))
    const files = detailFiles(req.event, ctx)
    if (files) detailOverlay.appendChild(files)
    // The card lives in the overlay (not the list), so load its icon here too.
    loadCardIcons(detailOverlay, [{ nappId: req.nappId, evt: req.event }])
    detailOverlay.hidden = false
    detailOverlay.scrollTop = 0
    appsPanel.classList.add("has-overlay")
  }

  // Both panes are built once and kept in the DOM; switching tabs just toggles
  // visibility (no rebuild) so each list, its scroll, and inputs persist. The
  // discover pane — and the relay subscription that feeds it — start lazily on
  // the first view of the discover tab, and stay connected thereafter.
  let installedBuilt = false
  let discoverBuilt = false
  let discoveryStarted = false

  function switchTab(tab: string) {
    currentTab = tab
    closeDetail() // leaving a tab dismisses any open detail overlay
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
      // First view of discover opens the relay connection if the early path
      // didn't already. It stays connected as tabs switch — only unmount closes
      // it.
      ensureDiscovery()
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
    const perms = button({ label: "permissions", variant: "outline" })
    perms.addEventListener("click", () => {
      ctx.editPermissions?.(app.nappId)
    })
    // Present only once the app has registered a NAP-CONFIG schema.
    const cfg = getNappletConfig(app.nappId).schema
      ? button({
          label: "settings",
          variant: "outline",
          onClick: () =>
            void openNappConfigSettings(app.nappId, {
              title: app.petname || app.title || app.nappId
            })
        })
      : null
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
    // Local napplet (loaded via /folder): its index.html is stored in the
    // record. The flavor was the user's choice at load time, so tell the
    // uploader explicitly instead of having it re-guess from the html.
    if (app.html) {
      const pub = button({
        label: "publish",
        variant: "outline",
        onClick: () =>
          ctx.launchSystemNapp("uploader", {
            params: {
              napplet: true,
              id: app.nappId.replace(/^napplet~local~/, ""),
              files: [
                {
                  path: "index.html",
                  file: new File([app.html], "index.html", { type: "text/html" })
                }
              ]
            },
            persistent: false
          })
      })
      return cfg ? [pub, cfg, perms, del] : [pub, perms, del]
    }
    return cfg ? [cfg, perms, del] : [perms, del]
  }

  // The newest discovered manifest strictly newer than the one we installed, or
  // null. Fed by the shared discovery subscription (started on first discover
  // view), so once discovery has run the installed tab gets update detection
  // for free — no per-app query.
  function latestUpdateFor(app: any): any | null {
    const base = app.event?.created_at
    if (!base) return null // local/dev/temp apps have no manifest → no updates
    const best = manifests.get(app.nappId)
    return best && best.created_at > base ? best : null
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
          kind: evt.kind,
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
  // Card options for one installed app — reused for both the list and the
  // (rebuilt, non-clickable) card shown at the top of the detail overlay.
  function installedOpts(app: InstalledApp): AppCardOpts {
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
    const search = buildHaystack({
      title: app.title,
      petname: app.petname,
      description: app.event?.tags.find((t: any) => t[0] === "description")?.[1],
      summary: app.event?.tags.find((t: any) => t[0] === "summary")?.[1],
      id: app.nappId,
      pubkey: author,
      categories: app.event?.tags.filter((t: any) => t[0] === "l" && t[1]).map((t: any) => t[1]),
      hashtags: app.event?.tags.filter((t: any) => t[0] === "t" && t[1]).map((t: any) => t[1]),
      actions: app.actions
    })
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
    const resolvedIcon = app.event ? resolveCardIcon(app.event) : null
    const iconSha = resolvedIcon?.sha ?? null
    return {
      nappId: app.nappId,
      title,
      type: classifyInstalled(app),
      description,
      iconSha,
      // Direct data:/URL icon (self-contained napplets), else the napp's own
      // origin path.
      iconUrl: iconSha ? null : resolvedIcon?.url || installedIconUrl(app),
      authorPubkey: author,
      authorLabel,
      createdAt,
      actions: app.actions,
      unsupported: unsupportedRequires(app.event ? requiresOf(app.event) : (app.requires ?? [])),
      search,
      buttons,
      onAuthorClick: author
        ? () => dispatchAction("apps", "profile", author).catch(() => {})
        : undefined
    }
  }

  function renderInstalledList() {
    const listEl = _installedListEl
    if (!listEl) return
    listEl.innerHTML = ""
    const apps = ctx.apps.list()
    _installedSig = apps.map(a => a.nappId).join(",")
    // Build every card once; filtering is a visibility toggle (applyInstalledFilter),
    // mirroring the Discover tab — so the two tabs behave identically.
    const frag = document.createDocumentFragment()
    for (const app of apps) {
      const opts = installedOpts(app)

      frag.appendChild(
        renderAppCard({
          ...opts,
          onOpen: () =>
            showDetail({
              // Fresh opts so the detail card gets its OWN buttons — reusing
              // `opts` would move the list card's button elements into the
              // overlay (and lose them when it closes).
              buildCard: () => renderAppCard(installedOpts(app)),
              event: app.event || null,
              nappId: app.nappId
            })
        })
      )
    }
    listEl.appendChild(frag)
    applyInstalledFilter()
    // Load icons from blossom for the published apps (those with a manifest).
    loadCardIcons(
      listEl,
      apps.filter(a => a.event).map(a => ({ nappId: a.nappId, evt: a.event }))
    )
    loadAuthorNames(listEl, applyInstalledFilter)
    _installedUpdatesSig = installedUpdateSig()
  }

  // Show/hide installed cards against the current query (no rebuild), plus the
  // empty-state message — the Installed-tab counterpart of applyFilter().
  function applyInstalledFilter() {
    const listEl = _installedListEl
    if (!listEl) return
    const needle = installedFilter.trim().toLowerCase()
    const cards = listEl.querySelectorAll(".apps-card") as NodeListOf<HTMLElement>
    let shown = 0
    for (const card of cards) {
      const typeOk = typeFilter === "all" || card.dataset.type === typeFilter
      const match = typeOk && (!needle || (card.dataset.search || "").includes(needle))
      card.hidden = !match
      if (match) shown++
    }
    const existing = listEl.querySelector(".apps-empty") as HTMLElement | null
    const msg = cards.length === 0 ? "No apps installed yet." : shown === 0 ? "No matches." : null
    if (!msg) {
      existing?.remove()
    } else if (existing) {
      existing.textContent = msg
    } else {
      const empty = document.createElement("div")
      empty.className = "apps-empty"
      empty.textContent = msg
      listEl.appendChild(empty)
    }
  }

  function renderInstalled() {
    installedPane.innerHTML = `
      <div class="apps-toolbar">
        <input class="ui-input apps-search" type="search" placeholder="${SEARCH_PLACEHOLDER}" />
      </div>
      <div class="apps-list"></div>
    `
    const searchEl = installedPane.querySelector(".apps-search") as HTMLInputElement
    _installedListEl = installedPane.querySelector(".apps-list") as HTMLElement
    installedPane.querySelector(".apps-toolbar")?.appendChild(buildTypeSegments())
    searchEl.value = installedFilter
    searchEl.addEventListener("input", () => {
      installedFilter = searchEl.value
      applyInstalledFilter() // toggle visibility; no rebuild
    })
    renderInstalledList()
  }

  // ─── Discover tab ──────────────────────────────────────────────

  let _listEl: HTMLElement | null = null
  let _relayListEl: HTMLElement | null = null
  // The relay panel's <summary> doubles as the status line: a title with the
  // enabled-relay count plus an overline badge with the event count / loading
  // state. Both are updated in place by updateStatus().
  let _relaysTitleEl: HTMLElement | null = null
  let _relaysStatusEl: HTMLElement | null = null

  // Refresh the count badge on every relay row in the editor.
  function updateRelayCounts() {
    if (!_relayListEl) return
    for (const row of _relayListEl.querySelectorAll(
      ".ui-item[data-relay]"
    ) as NodeListOf<HTMLElement>) {
      const count = row.querySelector(".apps-relay-count") as HTMLElement
      count.textContent = relayCountLabel(row.dataset.relay!)
    }
  }

  // "12" when the relay is current, "12 · 3 stale" when it's missing newer
  // versions of some napps.
  function relayCountLabel(url: string): string {
    const { total, stale } = relayCount(url)
    return stale ? `${total} · ${stale} stale` : String(total)
  }

  function emitDiscoverState() {
    // Persist under `params` so it round-trips: the host merges this into the
    // session entry, and restore passes session.params back into mount.
    opts.onStateChange?.({ params: { relays: [...relays], disabled: [...disabled] } })
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
    return evts.filter(e => DISCOVER_KINDS.includes(e.kind)).sort((a, b) => b.created_at - a.created_at)
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

  // Show/hide existing cards against the current filter AND the enabled-relay
  // set — no rebuild, no refetch. O(N) boolean toggles instead of recreating
  // the DOM per keystroke/toggle.
  function applyFilter() {
    if (!_listEl) return
    const needle = filter.trim().toLowerCase()
    const cards = _listEl.querySelectorAll(".apps-card") as NodeListOf<HTMLElement>
    for (const card of cards) {
      const typeOk = typeFilter === "all" || card.dataset.type === typeFilter
      const searchOk = !needle || (card.dataset.search || "").includes(needle)
      card.hidden = !typeOk || !searchOk || !seenOnEnabled(card.dataset.addr)
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

    const all = sortedManifests([...manifests.values()])
    const frag = document.createDocumentFragment()
    for (const evt of all) {
      frag.appendChild(renderCard(evt, ctx, enabledRelays(), renderList, showDetail))
    }
    _listEl.appendChild(frag)
    loadIcons(all)
    loadAuthorNames(_listEl, applyFilter)
    // applyFilter is the one place that decides visibility (type + search +
    // relay) — deciding it inline here too is how the type filter got skipped
    // on repaints. Same synchronous frame, so nothing flashes.
    applyFilter()
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
      applyFilter() // a new sighting on an enabled relay may unhide a card
      updateRelayCounts() // per-relay counts in the editor rows
      refreshInstalledUpdates() // installed tab's update badges
    })
  }

  function flushPending() {
    // _listEl may be detached when the discover tab isn't the active one — skip
    // the DOM work; renderList() repaints from `manifests` when it's reopened.
    if (!_listEl || !_listEl.isConnected || pending.length === 0) return
    const batch = pending
    pending = []
    const toRender = sortedManifests(batch)
    if (toRender.length === 0) return
    // Drop the placeholder before the merge so the ref walk only sees cards.
    _listEl.querySelector(".apps-empty")?.remove()

    // A version superseding one whose card is already in the DOM replaces it —
    // remove the stale same-address cards before the walk so `ref` never
    // points at a removed node.
    for (const evt of toRender) {
      _listEl
        .querySelector(`.apps-card[data-addr="${CSS.escape(computeNappId(evt))}"]`)
        ?.remove()
    }

    // Merge the sorted-desc batch into the sorted-desc list. Both are ordered
    // newest-first, so a single forward walk of the existing cards inserts each
    // new card in its created_at slot — O(batch + N) and order stays correct
    // even for late arrivals, instead of dumping the batch at the end. New
    // cards are inserted hidden: the applyFilter() that follows every flush
    // (scheduleFlush, same frame) is the one place visibility is decided.
    let ref = _listEl.firstElementChild
    for (const evt of toRender) {
      const card = renderCard(evt, ctx, enabledRelays(), renderList, showDetail)
      card.hidden = true
      while (ref && Number((ref as HTMLElement).dataset.createdAt || 0) >= evt.created_at) {
        ref = ref.nextElementSibling
      }
      _listEl.insertBefore(card, ref)
    }
    loadIcons(toRender)
    loadAuthorNames(_listEl, applyFilter)
    refreshEmptyState()
  }

  const enabledRelays = () => relays.filter(r => !disabled.has(r))

  // A napp stays visible only while at least one relay it was seen on is
  // enabled. Napps with no sighting record (shouldn't happen) stay visible.
  function seenOnEnabled(addr: string | undefined): boolean {
    if (!addr) return true
    const seen = nappRelays.get(addr)
    if (!seen) return true
    for (const r of seen.keys()) if (!disabled.has(r)) return true
    return false
  }

  // Napps seen on this relay — the count shown on its editor row — plus how
  // many of those the relay serves a stale version of. Derived from nappRelays
  // so re-subscribing after a toggle never double counts the re-sent events.
  function relayCount(url: string): { total: number; stale: number } {
    let total = 0
    let stale = 0
    for (const [addr, seen] of nappRelays) {
      const ts = seen.get(url)
      if (ts === undefined) continue
      total++
      if (ts < (manifests.get(addr)?.created_at || 0)) stale++
    }
    return { total, stale }
  }

  function updateStatus() {
    if (!_relaysTitleEl || !_relaysStatusEl) return
    const active = enabledRelays()
    // Title carries the enabled count ("relays (2/3)" when some are off).
    _relaysTitleEl.textContent =
      active.length < relays.length
        ? `relays (${active.length}/${relays.length})`
        : `relays (${relays.length})`
    if (!active.length) {
      _relaysStatusEl.textContent = relays.length ? "none enabled" : "none configured"
      return
    }
    const loading = active.some(r => subs.has(r) && !relayEose.has(r))
    // Count only napps visible under the enabled set — a disabled relay's
    // napps are hidden, so they shouldn't inflate the total.
    let total = 0
    for (const addr of manifests.keys()) if (seenOnEnabled(addr)) total++
    _relaysStatusEl.textContent = `${total} napp${total === 1 ? "" : "s"}${loading ? " — loading…" : ""}`
  }

  function openRelaySub(url: string) {
    if (subs.has(url)) return
    relayEose.delete(url)
    const s = pool.subscribeMany(
      [url],
      { kinds: DISCOVER_KINDS, limit: 400 },
      {
        label: "napps",
        onevent(event: any) {
          const addr = computeNappId(event)
          let seen = nappRelays.get(addr)
          if (!seen) nappRelays.set(addr, (seen = new Map()))
          seen.set(url, Math.max(seen.get(url) || 0, event.created_at))
          // Keep only the newest version per address (NIP-01 tie: lowest id).
          // A superseded version still buffered is dropped before its card is
          // ever built; one already rendered is replaced by flushPending.
          const cur = manifests.get(addr)
          if (
            !cur ||
            event.created_at > cur.created_at ||
            (event.created_at === cur.created_at && event.id < cur.id)
          ) {
            if (cur) pending = pending.filter(e => e !== cur)
            manifests.set(addr, event)
            pending.push(event)
          }
          // Even for an already-known event the flush matters: the new sighting
          // may unhide its card (applyFilter) and bumps this relay's count.
          scheduleFlush()
          updateStatus()
        },
        oneose() {
          relayEose.add(url)
          scheduleFlush()
          updateStatus()
        },
        onauth(event) {
          return currentSigner().signEvent(event) as any
        }
      }
    )
    subs.set(url, s)
  }

  function closeRelaySub(url: string) {
    try {
      subs.get(url)?.close?.()
    } catch {}
    subs.delete(url)
    relayEose.delete(url)
  }

  // Full restart — initial start and "reset to defaults". Drops the current set
  // and re-queries so the list reflects EXACTLY the enabled relays. Granular
  // changes (add/toggle/delete one relay) don't come through here; they only
  // touch that relay's own subscription.
  function startDiscoverSubscription() {
    for (const url of [...subs.keys()]) closeRelaySub(url)
    manifests.clear()
    nappRelays.clear()
    pending = []
    renderList()
    for (const url of enabledRelays()) openRelaySub(url)
    updateStatus()
  }

  // Open the relay subscription at most once. Both the early (installed apps
  // present) and lazy (first discover view) paths funnel through here.
  function ensureDiscovery() {
    if (discoveryStarted) return
    discoveryStarted = true
    startDiscoverSubscription()
  }

  // ── Relay editor (item list) ──
  // Each configured relay is a row: enable checkbox · url · event count ·
  // delete. Changes apply immediately, per relay — no save step, no restart of
  // the other relays' subscriptions.

  function toggleRelay(url: string, on: boolean) {
    if (on) {
      disabled.delete(url)
      if (discoveryStarted) openRelaySub(url)
    } else {
      disabled.add(url)
      closeRelaySub(url)
    }
    _relayListEl
      ?.querySelector(`.ui-item[data-relay="${CSS.escape(url)}"]`)
      ?.classList.toggle("disabled", !on)
    emitDiscoverState()
    // Events already collected keep their sighting record while the relay is
    // off — so hiding (and un-hiding on re-enable) is just a filter pass.
    applyFilter()
    updateStatus()
  }

  function removeRelay(url: string) {
    closeRelaySub(url)
    relays = relays.filter(r => r !== url)
    disabled.delete(url)
    // Drop its sightings; napps left with no source relay leave the list.
    for (const [addr, seen] of nappRelays) {
      seen.delete(url)
      if (seen.size === 0) {
        nappRelays.delete(addr)
        manifests.delete(addr)
      }
    }
    pending = pending.filter(e => manifests.get(computeNappId(e)) === e)
    renderRelayRows()
    emitDiscoverState()
    renderList()
    updateStatus()
  }

  // Returns an inline error message, or nothing on success (the addControl
  // contract: no error → the input clears and stays open).
  function addRelay(raw: string): string | void {
    let url = raw.trim()
    if (!url) return
    if (!/^wss?:\/\//.test(url)) url = `wss://${url}`
    if (relays.includes(url)) return "already in list"
    relays.push(url)
    renderRelayRows()
    emitDiscoverState()
    if (discoveryStarted) openRelaySub(url)
    updateStatus()
  }

  // Each relay is a .ui-item row composed from the design-system parts:
  // url label · event count (overline) · enable checkbox · remove.
  function renderRelayRows() {
    if (!_relayListEl) return
    _relayListEl.replaceChildren()
    for (const url of relays) {
      const count = overline(relayCountLabel(url), "apps-relay-count")
      count.title = "napps seen on this relay (stale = missing the newest version)"
      const row = item(
        { label: url.replace(/^wss?:\/\//, ""), title: url },
        count,
        check({
          checked: !disabled.has(url),
          title: "search this relay",
          onChange: on => toggleRelay(url, on)
        }),
        button({ label: "remove", variant: "danger", onClick: () => removeRelay(url) })
      )
      row.dataset.relay = url
      if (disabled.has(url)) row.classList.add("disabled")
      _relayListEl.appendChild(row)
    }
  }

  function renderDiscover() {
    discoverPane.innerHTML = `
      <div class="apps-toolbar">
        <input class="ui-input apps-search" type="search" placeholder="${SEARCH_PLACEHOLDER}" />
      </div>
      <div class="apps-list"></div>
    `

    _listEl = discoverPane.querySelector(".apps-list") as HTMLElement
    const searchEl = discoverPane.querySelector(".apps-search") as HTMLInputElement
    discoverPane.querySelector(".apps-toolbar")?.appendChild(buildTypeSegments())

    // System disclosure whose summary doubles as the status line (relays-napp
    // style): "relays (N)" + an overline badge with event count / loading.
    const relaysPanel = details({ summary: "", class: "apps-relays" })
    const sum = document.createElement("span")
    sum.className = "apps-relays-sum"
    _relaysTitleEl = document.createElement("span")
    _relaysTitleEl.textContent = "relays"
    _relaysStatusEl = overline("", "apps-relays-status")
    sum.append(_relaysTitleEl, _relaysStatusEl)
    relaysPanel.querySelector("summary")!.appendChild(sum)
    discoverPane.insertBefore(relaysPanel, _listEl)

    _relayListEl = itemList("apps-relays-list")
    renderRelayRows()

    const relaysActions = document.createElement("div")
    relaysActions.className = "apps-relays-actions"
    relaysActions.appendChild(
      button({
        label: "reset to defaults",
        variant: "ghost",
        onClick: () => {
          relays = [...DEFAULT_RELAYS]
          disabled.clear()
          renderRelayRows()
          emitDiscoverState()
          if (discoveryStarted) startDiscoverSubscription()
        }
      })
    )

    relaysPanel.append(
      _relayListEl,
      addControl({
        label: "add a relay",
        placeholder: "wss://relay.example.com",
        onAdd: addRelay
      }),
      relaysActions
    )

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

    // Paint whatever discovery has collected so far; streaming arrivals append
    // via flushPending. On the very first open the subscription starts right
    // after this (see switchTab), so there's nothing to paint yet.
    renderList()
    updateStatus()
    emitDiscoverState()
  }

  // ─── Render ────────────────────────────────────────────────────

  // Build the default (installed) pane now; the discover pane is built on first
  // view. Both are kept thereafter — switchTab only toggles their visibility.
  renderInstalled()
  installedBuilt = true
  // Connect to relays up front only when there's already a relay-installed app
  // worth update-checking — then early update detection justifies the
  // connection. A first-time user with nothing installed (or only local/dev
  // apps) gets no relay connection — and no surprise auth prompt — until they
  // open the discover tab, which starts discovery lazily (see switchTab).
  if (ctx.apps.list().some(a => a.event?.created_at)) ensureDiscovery()
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
      for (const url of [...subs.keys()]) closeRelaySub(url)
    }
  }
}

// ─── Unified app card (Installed + Discover render the same shape) ──


interface AppCardOpts {
  nappId: string
  title: string
  type: AppType
  description?: string | null
  iconSha?: string | null
  iconMime?: string | null
  iconUrl?: string | null
  authorPubkey?: string | null
  authorLabel?: string | null // plain text shown in place of author (e.g. "local")
  createdAt?: number | null
  actions: string[]
  // `requires` domains this launcher can't provide, named on the card badge.
  unsupported?: string[]
  search: string
  buttons: HTMLElement[]
  menuTrigger?: HTMLElement | null
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
  card.dataset.type = o.type
  // Fold the type into the haystack so typing "napplet" narrows the list too.
  card.dataset.search = `${o.search}\n${o.type}`

  // Flat structure: icon, title, author/label, date, meta extras, handlers and
  // actions are all direct children of .apps-card.

  // Icon — always present (even when empty) so the layout slot is stable.
  const icon = document.createElement("img")
  icon.className = "apps-card-icon"
  icon.alt = ""
  icon.loading = "lazy" // defer off-screen blob fetches; loadCardIcons sets src later
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

  // The type reads inline as part of the author line — "<type> from <author>"
  // (or "<type> · <label>" for dev/local), same style as the "from" text.
  if (o.authorPubkey) {
    const author = document.createElement("span")
    author.className = "apps-author"
    author.dataset.type = o.type // CSS ::before renders "<type> from "
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
  } else {
    const label = document.createElement("span")
    label.className = "apps-author apps-author-label"
    label.textContent = o.authorLabel ? `${o.type} · ${o.authorLabel}` : o.type
    card.appendChild(label)
  }

  if (o.unsupported?.length) {
    const warn = document.createElement("span")
    warn.className = "apps-unsupported"
    warn.textContent = `requires unsupported features: ${o.unsupported.join(", ")}`
    card.appendChild(warn)
  }

  if (o.createdAt) {
    const dateEl = document.createElement("span")
    dateEl.className = "apps-date"
    dateEl.textContent = new Date(o.createdAt * 1000).toLocaleDateString()
    card.appendChild(dateEl)
  }

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

  // Clicking the card (anywhere but a button or the author) opens the app-info
  // detail overlay. The card itself stays minimal — no inline details.
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

function renderCard(
  evt: NostrEvent,
  ctx: SystemCtx,
  relays: string[],
  onChange: any = null,
  onOpenDetail?: (req: DetailReq) => void
) {
  const tag = (k: string) => evt.tags.find((t: any) => t[0] === k)?.[1] || ""
  const dTag = tag("d")
  const nappId = computeNappId(evt)
  const installed = ctx.isInstalled?.(nappId) ?? false
  const installedEvents = ctx.apps.events?.() ?? []
  const installedEvent = installedEvents.find((e: any) => computeNappId(e) === nappId)
  const updateAvailable = installed && installedEvent && installedEvent.created_at < evt.created_at

  const title = tag("title")
  const { sha: iconSha, mime: iconMime, url: iconUrl } = resolveCardIcon(evt)

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
        const outcomes = await publishOutcomes(relays, pool.publish(relays, signed))
        const ok = outcomes.filter(o => o.ok).length
        const missing = outcomes.filter(o => !o.ok).map(o => o.relay.replace(/^wss?:\/\//, ""))
        ctx.setStatus?.(
          missing.length
            ? `Deletion event sent to ${ok}/${relays.length} relays — missing: ${missing.join(", ")}`
            : `Deletion event sent to all ${relays.length} relays`
        )
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
      // Relay hints: where the event was actually seen, falling back to the
      // enabled discover relays (subscribeMany doesn't always populate seenOn,
      // and the author's advertised relays may not hold the manifest).
      const seenRelays = Array.from(pool.seenOn.get(evt.id) || []).map(r => r.url)
      const relayHints = [...new Set([...seenRelays, ...relays])]
      if (action === "update") {
        await ctx.update({
          pubkey: evt.pubkey,
          dTag: dTag,
          kind: evt.kind,
          relayHints
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
          kind: evt.kind, // 35128 nsite → install(); 35129 napplet → installNapplet()
          identifier: dTag,
          relays: relayHints
        })
        const nappId = await ctx.install(raw)
        // Napplets self-launch during install (srcdoc); nsites don't, so launch
        // here — the boot just finished, the best moment to open the window.
        if (!nappId.startsWith("napplet~")) {
          await ctx.launchNapp?.(nappId, title || dTag || undefined)
        }
      }
      if (onChange) {
        onChange()
      } else {
        const replacement = renderCard(evt, ctx, relays, null, onOpenDetail)
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
    type: classifyEvent(evt),
    description: tag("description") || tag("summary"),
    iconSha,
    iconMime,
    iconUrl: iconSha ? null : iconUrl,
    authorPubkey: evt.pubkey,
    createdAt: evt.created_at,
    actions: actionsOf(evt),
    unsupported: unsupportedRequires(requiresOf(evt)),
    search: searchHaystack(evt),
    buttons,
    menuTrigger,
    onAuthorClick: () => {
      dispatchAction("apps", "profile", evt.pubkey).catch(() => {})
    },
    // Only clickable when a detail handler is supplied (the list). The card the
    // detail rebuilds for its own header passes none, so it isn't re-clickable.
    onOpen: onOpenDetail
      ? () =>
          onOpenDetail({
            buildCard: () => renderCard(evt, ctx, relays),
            event: evt,
            nappId
          })
      : undefined
  })

  // The menu popover lives in the card so it's removed with it; top-layer
  // rendering means its DOM position doesn't affect where it shows.
  if (menuEl) card.appendChild(menuEl)

  // Ties the card back to its napp address so applyFilter can hide it when
  // every relay it was seen on is disabled, and so a newer version's card
  // replaces this one instead of stacking next to it.
  card.dataset.addr = nappId

  return card
}

function computeNappId(evt: any) {
  const dTag = evt.tags.find((t: any) => t[0] === "d")?.[1]
  const base = `${evt.pubkey.slice(0, 16)}~${dTag || ""}`
  // Match persistence.computeNappId: napplets (5129/15129/35129) get their own
  // namespace so a napplet and an nsite under the same d tag don't collide.
  if (evt.kind === 5129 || evt.kind === 15129 || evt.kind === 35129) return `napplet~${base}`
  return base
}

// Conventional icon filenames to fall back to when no icon is declared.
// Conventional icon filenames to look for when a manifest declares no usable
// `icon` tag. Matched by BASENAME (so an icon in a subfolder still counts);
// apple-touch-icon is handled separately (preferred, any size/path).
const ICON_FALLBACK_NAMES = [
  "icon.svg",
  "favicon.svg",
  "icon.png",
  "favicon.png",
  "icon-192.png",
  "favicon.ico"
]

// Resolve a discover card's icon to a blossom sha (loadIcons fetches it from the
// author's blossom servers). The `icon` tag may hold a blossom sha OR a path
// (e.g. "/icon.svg" from metadata.json) — for a path we map it to the file's sha
// via the manifest's `path` tags. With no usable icon tag we look through the
// manifest's files BY FILENAME (so icons in subfolders are found, not just at
// the root), preferring an apple-touch-icon, then a conventional favicon name.
function resolveCardIcon(evt: any): {
  sha: string | null
  mime: string | null
  url: string | null
} {
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  const basename = (p: any) => String(p).replace(/^.*\//, "").toLowerCase()
  // Match the full declared path (manifests vary on the leading slash).
  const byFullPath = (p: string) => {
    const want = String(p).replace(/^\//, "")
    return pathTags.find((t: any) => String(t[1]).replace(/^\//, "") === want)
  }
  const byName = (name: string) => pathTags.find((t: any) => basename(t[1]) === name)

  const iconTag = evt.tags.find((t: any) => t[0] === "icon" && t[1])
  if (iconTag) {
    const val = iconTag[1] as string
    if (/^[0-9a-f]{64}$/i.test(val)) return { sha: val, mime: iconTag[2] || null, url: null }
    // A self-contained napplet has no file paths to point at, so its icon is an
    // inline data: URI or an absolute URL — use it directly.
    if (/^(data:|https?:)/i.test(val)) return { sha: null, mime: null, url: val }
    // The declared path may not match exactly (root vs subfolder); fall back to
    // its filename anywhere in the manifest.
    const pt = byFullPath(val) || byName(basename(val))
    if (pt) return { sha: pt[2], mime: pt[3] || null, url: null }
  }

  // Prefer an apple-touch-icon (a real app icon), wherever it lives.
  const apple = pathTags.find((t: any) => basename(t[1]).startsWith("apple-touch-icon"))
  if (apple) return { sha: apple[2], mime: apple[3] || null, url: null }

  for (const name of ICON_FALLBACK_NAMES) {
    const pt = byName(name)
    if (pt) return { sha: pt[2], mime: pt[3] || null, url: null }
  }
  return { sha: null, mime: null, url: null }
}

// ─── helpers ─────────────────────────────────────────────────────

function sanitizeRelays(relays: string[]): string[] {
  if (!Array.isArray(relays)) return []
  return [...new Set(relays.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean))]
}

// The lowercased text a card is searched against. Stored on each card as
// data-search so filtering can be done by toggling visibility instead of
// rebuilding.
// One placeholder + one field set for both tabs so search behaves identically.
const SEARCH_PLACEHOLDER = "Search name, author, description, id…"

// Lowercased search text shared by both tabs. `pubkey` is folded in as hex AND
// npub; the author's display name is mixed in lazily (see loadAuthorNames) via
// authorNameCache so apps are findable by author, not just key.
const authorNameCache = new Map<string, string>()
const authorNamesInFlight = new Set<string>()

function buildHaystack(o: {
  id: string | null
  pubkey: string | null
  actions: string[]
  title?: string | null
  petname?: string | null
  description?: string | null
  summary?: string | null
  categories?: string[]
  hashtags?: string[]
}): string {
  let npub: string | null = null
  if (o.pubkey) {
    try {
      npub = npubEncode(o.pubkey)
    } catch {}
  }
  return [
    o.title,
    o.petname,
    o.description,
    o.summary,
    o.id,
    o.pubkey,
    npub,
    o.pubkey ? authorNameCache.get(o.pubkey) : null,
    ...(o.categories || []),
    ...(o.hashtags || []),
    ...(o.actions || [])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
}

function searchHaystack(evt: NostrEvent): string {
  const tag = (k: string) => evt.tags.find((t: any) => t[0] === k)?.[1] || null
  return buildHaystack({
    title: tag("title"),
    summary: tag("summary"),
    description: tag("description"),
    id: tag("d") || "",
    pubkey: evt.pubkey,
    categories: evt.tags.filter((t: any) => t[0] === "l" && t[1]).map((t: any) => t[1]),
    hashtags: evt.tags.filter((t: any) => t[0] === "t" && t[1]).map((t: any) => t[1]),
    actions: actionsOf(evt)
  })
}

// Action/handler names a manifest declares.
function actionsOf(evt: NostrEvent): string[] {
  return evt.tags.filter((t: any) => t[0] === "action" && t[1]).map((t: any) => t[1])
}

function requiresOf(evt: NostrEvent): string[] {
  return evt.tags.filter((t: any) => t[0] === "requires" && t[1]).map((t: any) => t[1])
}

function appendSearch(card: HTMLElement, text: string) {
  const cur = card.dataset.search || ""
  if (!text || cur.includes(text)) return
  card.dataset.search = `${cur}\n${text}`
}

// Resolve author display names for the cards in `listEl` and fold them into each
// card's data-search, then re-apply the active filter so a name typed before it
// loaded still matches. Cached across renders; fresh cards already carry the name
// via buildHaystack, so this only fills in cards built before the name arrived.
function loadAuthorNames(listEl: HTMLElement | null, refilter: () => void) {
  if (!listEl) return
  const pubkeys = new Set<string>()
  for (const card of listEl.querySelectorAll(
    ".apps-card[data-author]"
  ) as NodeListOf<HTMLElement>) {
    pubkeys.add(card.dataset.author!)
  }
  const cardsFor = (pk: string) =>
    listEl.querySelectorAll(
      `.apps-card[data-author="${CSS.escape(pk)}"]`
    ) as NodeListOf<HTMLElement>
  for (const pk of pubkeys) {
    const cached = authorNameCache.get(pk)
    if (cached) {
      for (const c of cardsFor(pk)) appendSearch(c, cached)
      continue
    }
    if (cached === "" || authorNamesInFlight.has(pk)) continue // known-empty or loading
    authorNamesInFlight.add(pk)
    loadNostrUser(pk)
      .then(u => {
        authorNamesInFlight.delete(pk)
        const name = [u.metadata?.name, u.metadata?.display_name, u.metadata?.nip05, u.shortName]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        authorNameCache.set(pk, name)
        if (!name) return
        for (const c of cardsFor(pk)) appendSearch(c, name)
        refilter()
      })
      .catch(() => authorNamesInFlight.delete(pk))
  }
}


// ─── app-info detail (shown in the overlay over the list) ──────────
// Built from the clicked app: a rebuilt list-item card (with live actions),
// preceded by any images and followed by the remaining info + a files <details>.

interface DetailReq {
  buildCard: () => HTMLElement
  event: any | null
  nappId: string
}

// Images section (manifest `image` tags); null when there are none.
function detailImages(event: any | null): HTMLElement | null {
  const images = (event?.tags || [])
    .filter((t: any) => t[0] === "image" && t[1])
    .map((t: any) => t[1])
  if (!images.length) return null
  const gallery = document.createElement("div")
  gallery.className = "apps-detail-images"
  for (const src of images) {
    const img = document.createElement("img")
    img.className = "apps-detail-image"
    img.alt = ""
    img.loading = "lazy"
    img.src = src
    img.addEventListener("error", () => img.remove()) // drop dead links silently
    gallery.appendChild(img)
  }
  return gallery
}

// Remaining info section: id, naddr, relays-seen-on, categories/hashtags, source.
// Everything here is derived from the manifest event (the same event whether the
// app was opened from Discover or Installed), so both tabs show identical info.
// `id` is the only field without an event; the rest only render when present.
// `sightings` (relay → newest created_at discovery saw there) marks relays
// serving a stale version; without it the pool's record of this event is used.
// Own napps with stale relays get a re-publish button; `onRepublished` lets
// the relay editor refresh its stale badges afterwards.
function detailInfo(
  req: DetailReq,
  sightings?: Map<string, number>,
  ctx?: SystemCtx,
  onRepublished?: () => void
): HTMLElement {
  const section = document.createElement("div")
  section.className = "apps-detail-info"

  // released date + id as one block (no gap between them), value-only.
  const idBlock = document.createElement("div")
  idBlock.className = "apps-detail-idblock"
  if (req.event?.created_at) {
    idBlock.appendChild(
      detailField("released", code(new Date(req.event.created_at * 1000).toLocaleDateString()))
    )
  }
  idBlock.appendChild(detailField("id", code(req.nappId)))
  section.appendChild(idBlock)

  const event = req.event
  if (event) {
    // Relays the event was seen on (from the shared pool) — empty for a purely
    // local install that was never discovered. Also feeds the naddr relay hints.
    const seenOn = Array.from(pool.seenOn.get(event.id) || []).map((r: any) => r.url)

    // Action buttons (not raw values): copy the naddr, route the raw event to a
    // viewer through the action handler, and open the source.
    const btns = document.createElement("div")
    btns.className = "apps-detail-btns"

    const dTag = event.tags.find((t: any) => t[0] === "d")?.[1]
    if (dTag) {
      const naddr = naddrEncode({
        pubkey: event.pubkey,
        kind: event.kind,
        identifier: dTag,
        relays: seenOn
      })
      const copyBtn = button({
        label: "copy naddr",
        variant: "outline",
        class: "apps-detail-naddr"
      })
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(naddr)
          copyBtn.textContent = "copied!"
          setTimeout(() => (copyBtn.textContent = "copy naddr"), 1500)
        } catch {}
      })
      btns.appendChild(copyBtn)
      btns.appendChild(
        button({
          label: "view event",
          variant: "outline",
          class: "apps-detail-view-event",
          onClick: () => dispatchAction("apps", `view:${event.kind}`, event).catch(() => {})
        })
      )
    }

    const source = event.tags.find((t: any) => t[0] === "source")?.[1]
    if (source) {
      btns.appendChild(
        button({
          label: "view source",
          variant: "outline",
          class: "apps-detail-view-source",
          onClick: () => window.open(source, "_blank", "noopener,noreferrer")
        })
      )
    }

    if (btns.childElementCount) section.appendChild(btns)

    // seen-on relays — a labelled <ul>, not chips. Stale = the relay's newest
    // sighting predates this manifest, so it's missing the latest version.
    const relayRows: { url: string; stale: boolean }[] = sightings?.size
      ? [...sightings].map(([url, ts]) => ({ url, stale: ts < event.created_at }))
      : seenOn.map((url: string) => ({ url, stale: false }))
    if (relayRows.length) {
      const row = document.createElement("div")
      row.className = "apps-detail-relays"
      const label = document.createElement("span")
      label.className = "apps-detail-label"
      label.textContent = "seen on:"
      const list = document.createElement("ul")
      const setLi = (li: HTMLElement, url: string, stale: boolean) => {
        li.textContent = url.replace(/^wss?:\/\//, "") + (stale ? " — stale" : "")
        li.title = stale ? `${url} — serving an older version` : url
        li.classList.toggle("is-stale", stale)
      }
      const lis = new Map<string, HTMLElement>()
      for (const r of relayRows) {
        const li = document.createElement("li")
        setLi(li, r.url, r.stale)
        lis.set(r.url, li)
        list.appendChild(li)
      }
      row.append(label, list)
      section.appendChild(row)

      // Re-publish the manifest to the relays that fell behind — own napps
      // only. The event is already signed, so this is a plain re-broadcast;
      // successful relays lose their stale marker and the shared sightings
      // map is corrected so the relay editor agrees.
      let staleRelays = relayRows.filter(r => r.stale).map(r => r.url)
      if (staleRelays.length && ctx?.account?.getPubkey() === event.pubkey) {
        const btnLabel = (n: number) => `re-publish to ${n} stale relay${n === 1 ? "" : "s"}`
        const b = button({
          label: btnLabel(staleRelays.length),
          variant: "warning",
          class: "apps-detail-republish"
        })
        b.addEventListener("click", async () => {
          b.disabled = true
          b.textContent = "publishing…"
          const outcomes = await publishOutcomes(staleRelays, pool.publish(staleRelays, event))
          for (const o of outcomes) {
            if (!o.ok) continue
            sightings?.set(o.relay, event.created_at)
            const li = lis.get(o.relay)
            if (li) setLi(li, o.relay, false)
          }
          onRepublished?.()
          staleRelays = outcomes.filter(o => !o.ok).map(o => o.relay)
          if (staleRelays.length) {
            ctx?.setStatus?.(
              `Re-published, still missing: ${staleRelays.map(r => r.replace(/^wss?:\/\//, "")).join(", ")}`
            )
            b.disabled = false
            b.textContent = btnLabel(staleRelays.length)
          } else {
            ctx?.setStatus?.(`Re-published to ${outcomes.length} relay${outcomes.length === 1 ? "" : "s"}`)
            b.remove()
          }
        })
        section.appendChild(b)
      }
    }

    const cats: string[] = event.tags.filter((t: any) => t[0] === "l" && t[1]).map((t: any) => t[1])
    if (cats.length) {
      section.appendChild(
        chipGroup(
          "categories",
          cats.map(c => detailChip("apps-chip-category", formatCategory(c), c))
        )
      )
    }

    const hashtags: string[] = event.tags
      .filter((t: any) => t[0] === "t" && t[1])
      .map((t: any) => t[1])
    if (hashtags.length) {
      section.appendChild(
        chipGroup(
          "tags",
          hashtags.map(t => detailChip("apps-chip-tag", `#${t}`))
        )
      )
    }
  }
  return section
}

// Files <details> whose list is fetched (blossom round-trip) only on first
// expand; null when the manifest has no path tags.
function detailFiles(event: any | null, ctx?: SystemCtx): HTMLElement | null {
  const pathTags = (event?.tags || []).filter((t: any) => t[0] === "path" && t[1] && t[2])
  if (!pathTags.length) return null
  const block = details({ summary: `files (${pathTags.length})` })
  const list = document.createElement("ul")
  list.className = "apps-detail-files"
  block.appendChild(list)
  let loaded = false
  block.addEventListener("toggle", () => {
    if (!block.open || loaded) return
    loaded = true
    renderFiles(event, list, ctx)
  })
  return block
}

async function renderFiles(evt: any, list: HTMLElement, ctx?: SystemCtx) {
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  const serverTagUrls = evt.tags.filter((t: any) => t[0] === "server" && t[1]).map((t: any) => t[1])
  const blossomServers = (
    await loadBlossomServers(evt.pubkey).catch(() => ({ items: [] as string[] }))
  ).items
  const servers = [...new Set([...serverTagUrls, ...blossomServers])].map(normalizeServer)
  const host = (u: string) => {
    try {
      return new URL(u).host
    } catch {
      return u
    }
  }

  const lisBySha = new Map<string, HTMLElement[]>()
  for (const t of pathTags as string[][]) {
    const sha = t[2]
    const li = document.createElement("li")
    const pathCode = document.createElement("code")
    pathCode.textContent = t[1]
    li.appendChild(pathCode)

    // The per-file links are folded behind a "links" button: clicking it builds
    // the blossom links for this file and swaps itself out for them.
    const linksBtn = button({
      label: "links",
      variant: "link",
      class: "apps-detail-files-links-btn"
    })
    linksBtn.addEventListener("click", () => {
      const span = document.createElement("span")
      span.className = "apps-detail-files-links"
      for (const url of servers) {
        const a = document.createElement("a")
        a.href = `${url}/${sha}`
        a.target = "_blank"
        a.rel = "noopener noreferrer"
        a.textContent = host(url)
        span.appendChild(a)
      }
      linksBtn.replaceWith(span)
    })
    li.appendChild(linksBtn)
    list.appendChild(li)
    lisBySha.set(sha, [...(lisBySha.get(sha) || []), li])
  }

  if (!servers.length) return

  // Availability probe (heal's ranged GET) — a links list that doesn't say
  // who actually has the bytes is how blobs quietly rot.
  const shas = [...lisBySha.keys()]
  const have = new Map<string, Set<string>>(shas.map(s => [s, new Set<string>()]))
  await Promise.allSettled(
    servers.map(async server => {
      for (const sha of shas) if (await hasBytes(server, sha)) have.get(sha)!.add(server)
    })
  )

  // "missing on: …" (amber, recoverable) vs "missing everywhere" (red — no
  // known server holds the bytes). Re-rendered after a re-seed run.
  const marks: HTMLElement[] = []
  const refreshMarks = () => {
    for (const m of marks.splice(0)) m.remove()
    for (const [sha, lis] of lisBySha) {
      const got = have.get(sha)!
      const missingOn = servers.filter(s => !got.has(s))
      if (!missingOn.length) continue
      for (const li of lis) {
        const mark = document.createElement("span")
        mark.className = got.size ? "apps-file-missing" : "apps-file-lost"
        mark.textContent = got.size
          ? ` — missing on: ${missingOn.map(host).join(", ")}`
          : " — missing everywhere"
        li.appendChild(mark)
        marks.push(mark)
      }
    }
  }
  refreshMarks()

  // Blobs missing somewhere but present elsewhere — re-seedable.
  const seedable = () => {
    let n = 0
    for (const got of have.values()) if (got.size) n += servers.length - got.size
    return n
  }

  // Re-seed: fetch each such blob from a server that has it (hash checked) and
  // upload it where it's gone. Own napps only. The user's signer auths the
  // uploads — this is an explicit click, unlike heal's background throwaway
  // key, and allowlisting servers should accept it.
  let toSeed = seedable()
  if (!toSeed || ctx?.account?.getPubkey() !== evt.pubkey) return
  const btnLabel = (n: number) => `re-seed ${n} missing blob${n === 1 ? "" : "s"}`
  const b = button({ label: btnLabel(toSeed), variant: "warning", class: "apps-detail-reseed" })
  b.addEventListener("click", async () => {
    const signer = currentSigner()
    if (!signer) {
      ctx?.setStatus?.("Re-seed needs a signer connected")
      return
    }
    b.disabled = true
    b.textContent = "re-seeding…"
    let failed = 0
    for (const [sha, got] of have) {
      if (!got.size) continue
      const missingOn = servers.filter(s => !got.has(s))
      if (!missingOn.length) continue
      let blob: Blob
      const src = [...got][0]
      try {
        const res = await fetch(`${src}/${sha}`, { signal: AbortSignal.timeout(30000) })
        if (!res.ok) throw new Error(String(res.status))
        const buf = await res.arrayBuffer()
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
          .map(x => x.toString(16).padStart(2, "0"))
          .join("")
        if (digest !== sha) throw new Error("bytes don't match hash")
        blob = new Blob([buf], { type: res.headers.get("content-type") || "" })
      } catch {
        failed += missingOn.length
        continue
      }
      await Promise.allSettled(
        missingOn.map(async server => {
          try {
            await new BlossomClient(server, signer as any).uploadBlob(blob, blob.type || undefined)
            got.add(server)
          } catch {
            failed++
          }
        })
      )
    }
    refreshMarks()
    toSeed = seedable()
    if (failed) {
      ctx?.setStatus?.(`Re-seed: ${failed} upload${failed === 1 ? "" : "s"} refused`)
      b.disabled = false
      b.textContent = btnLabel(toSeed)
    } else {
      ctx?.setStatus?.("Re-seeded all missing blobs")
      b.remove()
    }
  })
  list.after(b)
}

function normalizeServer(s: string): string {
  const u = s.endsWith("/") ? s.slice(0, -1) : s
  return u.startsWith("http") ? u : `https://${u}`
}

function code(text: string): HTMLElement {
  const c = document.createElement("code")
  c.textContent = text
  return c
}

// A field, addressable via .apps-detail-<key> (e.g. .apps-detail-id). The
// .apps-detail-label is added only when a label is given; the value always gets
// .apps-detail-value.
function detailField(key: string, value: HTMLElement, label?: string): HTMLElement {
  const row = document.createElement("div")
  row.className = `apps-detail-${key}`
  if (label) {
    const l = document.createElement("span")
    l.className = "apps-detail-label"
    l.textContent = label
    row.appendChild(l)
  }
  value.classList.add("apps-detail-value")
  row.appendChild(value)
  return row
}

// A row of chips, addressable via .apps-detail-<key> (keeps .apps-chips for the
// shared chip layout).
function chipGroup(key: string, chips: HTMLElement[]): HTMLElement {
  const group = document.createElement("div")
  group.className = `apps-detail-${key} apps-chips`
  for (const c of chips) group.appendChild(c)
  return group
}

function detailChip(variant: string, text: string, title?: string): HTMLElement {
  const el = document.createElement("span")
  el.className = `apps-chip ${variant}`
  el.textContent = text
  if (title) el.title = title
  return el
}

function formatCategory(label: string) {
  const m = /^napp\.([^:]+):(.+)$/.exec(label)
  if (!m) return label
  return `${m[2]} · ${m[1]}`
}
