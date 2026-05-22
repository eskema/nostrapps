import { pool } from "@nostr/gadgets/global"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { npubEncode, naddrEncode } from "@nostr/tools/nip19"
import "nostr-web-components"

export const id = "store"
export const title = "Store"
export const slash = "/store"

const NSITE_ROOT = 15128
const NSITE_NAMED = 35128
const NSITE_LISTING = 37348 // NIP-5B app listing (paired to a manifest by d-tag)

// Transparent 1×1 SVG used as the initial src for icon/avatar slots so the
// browser doesn't render a broken-image glyph while async loads are pending.
// The CSS placeholder background shows through; a real src replaces it
// without changing the slot's dimensions, so loading icons doesn't cause CLS.
const PLACEHOLDER_SRC = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

const DEFAULT_RELAYS = [
  "wss://relay.nostrapps.com",
  "wss://relay.nostrapps.com/personal",
  "wss://relay.nostrapps.com/public",
  "wss://relay.nostrapps.com/internal",
  "wss://relay.nostrapps.com/favorites"
]

export function mount(container, ctx, opts = {}) {
  let filter = ""
  let events = []
  let relays = sanitizeRelays(opts.initial?.relays)
  let cancelled = false
  let sub = null
  let sawEose = false

  if (relays.length === 0) relays = [...DEFAULT_RELAYS]

  container.innerHTML = `
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

  const searchEl = container.querySelector(".store-search")
  const relaysToggleBtn = container.querySelector(".store-relays-toggle")
  const relaysPanel = container.querySelector(".store-relays")
  const relaysInput = container.querySelector(".store-relays-input")
  const relaysSaveBtn = container.querySelector(".store-relays-save")
  const relaysClearBtn = container.querySelector(".store-relays-clear")
  const statusEl = container.querySelector(".store-status")
  const listEl = container.querySelector(".store-list")

  relaysInput.value = relays.join("\n")

  function setStatus(msg) {
    statusEl.textContent = msg || ""
    statusEl.hidden = !msg
  }

  function emitState() {
    opts.onStateChange?.({ relays: [...relays] })
  }

  function renderList() {
    listEl.innerHTML = ""

    // Cached events include both manifests (15128/35128) and NIP-5B listings
    // (37348). Pair them by (pubkey, d-tag) so the rendered cards are driven
    // by manifests but enriched with their listing's metadata.
    const listingsByKey = new Map()
    for (const e of events) {
      if (e.kind !== NSITE_LISTING) continue
      const dTag = e.tags.find(t => t[0] === "d")?.[1] || ""
      listingsByKey.set(`${e.pubkey}:${dTag}`, e)
    }
    const listingFor = manifest => {
      const dTag = manifest.tags.find(t => t[0] === "d")?.[1] || ""
      return listingsByKey.get(`${manifest.pubkey}:${dTag}`) || null
    }

    const manifests = events.filter(e => e.kind === NSITE_ROOT || e.kind === NSITE_NAMED)
    const filtered = manifests
      .filter(m => !(ctx.isInstalled?.(computeNappId(m)) ?? false))
      .filter(m => matchesFilter(m, listingFor(m), filter))
      .sort((a, b) => b.created_at - a.created_at)

    let displayed = []
    // Cards call onChange after an action completes — we re-render the whole
    // list rather than just swapping the card in place, so an uninstalled
    // app in the "installed" tab moves down into "Previously installed"
    // (and an install in any tab gets re-categorized too).
    const renderOne = evt => listEl.appendChild(renderCard(evt, ctx, listingFor(evt), renderList))

    if (filtered.length === 0) {
      const empty = document.createElement("div")
      empty.className = "store-empty"
      empty.textContent = manifests.length === 0 ? "No napps found." : "No matches."
      listEl.appendChild(empty)
      return
    }

    for (const evt of filtered) renderOne(evt)
    displayed = filtered

    // Lazy-load Blossom icons for unique authors that published a listing.
    const seenIconPks = new Set()
    for (const evt of displayed) {
      if (seenIconPks.has(evt.pubkey)) continue
      const listing = listingFor(evt)
      if (!listing) continue
      const hasIcon = listing.tags.some(t => t[0] === "icon" && t[1])
      if (!hasIcon) continue
      seenIconPks.add(evt.pubkey)
      loadBlossomServers(evt.pubkey)
        .then(res => {
          if (cancelled) return
          const servers = res?.items ?? []
          if (servers.length === 0) return
          const icons = listEl.querySelectorAll(
            `[data-listing-pubkey="${evt.pubkey}"] .store-card-icon[data-icon-sha]`
          )
          for (const img of icons) {
            const sha = img.dataset.iconSha
            const base = servers[0].endsWith("/") ? servers[0].slice(0, -1) : servers[0]
            img.src = `${base}/${sha}`
            // If the first server fails, fall through to the next. If all
            // servers fail, restore the placeholder so the slot stays the
            // same height (vs hiding it and shifting layout).
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

  function startSubscription() {
    closeSubscription()
    events = []
    sawEose = false
    renderList()

    if (cancelled) return
    if (!relays.length) {
      setStatus("No relays configured.")
      return
    }

    setStatus(`Subscribing to ${relays.length} relay(s)…`)
    sub = pool.subscribeMany(relays, { kinds: [NSITE_ROOT, NSITE_NAMED, NSITE_LISTING], limit: 400 }, {
      label: "apps",
      onevent(event) {
        if (cancelled) return
        if (events.some(existing => existing.id === event.id)) return
        events.push(event)
        renderList()
        if (sawEose) {
          setStatus(`Watching ${relays.length} relay(s) — ${events.length} event${events.length === 1 ? "" : "s"}`)
        } else {
          setStatus(`Loading from ${relays.length} relay(s)… ${events.length}`)
        }
      },
      oneose() {
        if (cancelled) return
        sawEose = true
        setStatus(`Watching ${relays.length} relay(s) — ${events.length} event${events.length === 1 ? "" : "s"}`)
      },
      onclose(reason) {
        if (cancelled) return
        if (reason) setStatus(`Subscription closed: ${reason.message || String(reason)}`)
      },
      onerror(err) {
        if (cancelled) return
        setStatus(`Error: ${err.message}`)
      }
    })
  }

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
    emitState()
    relaysPanel.hidden = true
    startSubscription()
  })

  relaysClearBtn.addEventListener("click", () => {
    relays = [...DEFAULT_RELAYS]
    relaysInput.value = relays.join("\n")
    emitState()
    relaysPanel.hidden = true
    startSubscription()
  })

  renderList()
  emitState()
  startSubscription()

  return {
    unmount() {
      cancelled = true
      closeSubscription()
    }
  }
}

function renderCard(evt, ctx, listing = null, onChange = null) {
  const tag = k => evt.tags.find(t => t[0] === k)?.[1] || ""
  const dTag = tag("d")
  const source = tag("source")
  const date = new Date(evt.created_at * 1000).toLocaleDateString()
  const pathCount = evt.tags.filter(t => t[0] === "path").length
  const nappId = computeNappId(evt)
  const installed = ctx.isInstalled?.(nappId) ?? false
  const installedManifest = installed ? ctx.installedManifest?.(nappId) : null
  const updateAvailable =
    installed && installedManifest && installedManifest.createdAt < evt.created_at

  // NIP-5B: prefer listing fields over manifest fallbacks.
  const listingName = localizedListingTag(listing, "name")
  const listingSummary = localizedListingTag(listing, "summary")
  const listingDescription = localizedListingTag(listing, "description")
  const titleText = listingName || tag("title")
  const description = listingDescription || listingSummary || tag("description")
  const iconTag = listing?.tags.find(t => t[0] === "icon")
  const iconSha = iconTag?.[1]
  const iconMime = iconTag?.[2]
  const actionTags = listing ? listing.tags.filter(t => t[0] === "action" && t[1]).map(t => t[1]) : []
  const categoryTags = listing ? listing.tags.filter(t => t[0] === "l" && t[1]).map(t => t[1]) : []
  const hashtags = listing ? listing.tags.filter(t => t[0] === "t" && t[1]).map(t => t[1]) : []

  const card = document.createElement("div")
  card.className = "store-card"
  card.dataset.author = evt.pubkey
  if (listing) card.dataset.listingPubkey = listing.pubkey

  const head = document.createElement("div")
  head.className = "store-card-head"

  if (iconSha) {
    const icon = document.createElement("img")
    icon.className = "store-card-icon"
    icon.alt = ""
    icon.dataset.iconSha = iconSha
    if (iconMime) icon.dataset.iconMime = iconMime
    // Reserve the slot up front so the placeholder background fills it; the
    // real src is set once a Blossom URL resolves (no layout shift).
    icon.src = PLACEHOLDER_SRC
    head.appendChild(icon)
  }

  const titles = document.createElement("div")
  titles.className = "store-card-titles"

  const h = document.createElement("h3")
  h.className = "store-title"
  h.textContent = titleText || (dTag ? `(${dTag})` : "(untitled site)")
  titles.appendChild(h)

  const meta = document.createElement("div")
  meta.className = "store-meta"

  const author = document.createElement("span")
  author.className = "store-author"
  const pic = document.createElement("nostr-picture")
  pic.className = "store-author-pic"
  pic.setAttribute("pubkey", evt.pubkey)
  const name = document.createElement("nostr-name")
  name.className = "store-author-name"
  name.setAttribute("pubkey", evt.pubkey)
  name.textContent = evt.pubkey.slice(0, 8) + "…"
  author.append(pic, name)

  const dateEl = document.createElement("span")
  dateEl.className = "store-date"
  dateEl.textContent = date

  const pathsEl = document.createElement("span")
  pathsEl.className = "store-paths"
  pathsEl.textContent = `${pathCount} file${pathCount === 1 ? "" : "s"}`

  const kindEl = document.createElement("span")
  kindEl.className = "store-kind"
  kindEl.textContent = evt.kind === NSITE_NAMED ? "named" : "root"

  meta.append(author, dateEl, pathsEl, kindEl)
  titles.appendChild(meta)

  // Action buttons. When an update is available we show *both* update and
  // uninstall (so the user can drop an installed app without first updating
  // it). Otherwise it's a single install/uninstall toggle.
  const actions = document.createElement("div")
  actions.className = "store-actions"

  const performAction = async (btn, action) => {
    btn.disabled = true
    btn.textContent =
      action === "update" ? "updating…" : action === "uninstall" ? "uninstalling…" : "launching…"
    try {
      if (action === "update") {
        await ctx.update({
          pubkey: evt.pubkey,
          kind: evt.kind,
          dTag: dTag || undefined
        })
      } else if (action === "uninstall") {
        await ctx.uninstall(nappId)
      } else {
        const raw =
          evt.kind === NSITE_NAMED
            ? naddrEncode({
                pubkey: evt.pubkey,
                kind: NSITE_NAMED,
                identifier: dTag,
                relays: []
              })
            : npubEncode(evt.pubkey)
        await ctx.launchFromInput(raw)
      }
      // Re-render the whole list so the card lands in the right section
      // for the current filter (e.g. uninstalling in "installed" moves
      // the card down into "Previously installed"). If no callback was
      // wired through, fall back to swapping the card in place.
      if (onChange) {
        onChange()
      } else {
        const replacement = renderCard(evt, ctx, listing)
        card.replaceWith(replacement)
      }
    } catch (err) {
      btn.title = err?.message || String(err)
      btn.textContent = "error"
      btn.disabled = false
      setTimeout(() => {
        btn.textContent = action
        btn.removeAttribute("title")
      }, 3000)
    }
  }

  const makeActionBtn = (action, className) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = className
    b.textContent = action
    b.addEventListener("click", () => performAction(b, action))
    return b
  }

  if (updateAvailable) {
    actions.append(
      makeActionBtn("update", "store-install update-available"),
      makeActionBtn("uninstall", "store-install installed")
    )
  } else if (installed) {
    actions.append(makeActionBtn("uninstall", "store-install installed"))
  } else {
    actions.append(makeActionBtn("install", "store-install"))
  }

  head.append(titles, actions)
  card.appendChild(head)

  if (description) {
    const desc = document.createElement("p")
    desc.className = "store-description"
    desc.textContent = description
    card.appendChild(desc)
  }

  if (actionTags.length > 0) {
    const handlers = document.createElement("div")
    handlers.className = "store-handlers"
    for (const action of actionTags) {
      const chip = document.createElement("span")
      chip.className = "store-chip store-chip-handler"
      chip.textContent = action
      handlers.appendChild(chip)
    }
    card.appendChild(handlers)
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

  return card
}

function computeNappId(evt) {
  const dTag = evt.tags.find(t => t[0] === "d")?.[1]
  if (evt.kind === NSITE_NAMED && dTag) {
    return `${evt.pubkey.slice(0, 40)}-${dTag}`
  }
  return evt.pubkey.slice(0, 40)
}

// ─── helpers ─────────────────────────────────────────────────────

function sanitizeRelays(relays) {
  if (!Array.isArray(relays)) return []
  return [...new Set(relays.map(s => (typeof s === "string" ? s.trim() : "")).filter(Boolean))]
}

function matchesFilter(evt, listing, filter) {
  if (!filter) return true
  const fields = [
    evt.tags.find(t => t[0] === "title")?.[1] || "",
    evt.tags.find(t => t[0] === "description")?.[1] || "",
    evt.tags.find(t => t[0] === "d")?.[1] || "",
    evt.pubkey
  ]
  if (listing) {
    for (const t of listing.tags) {
      if (
        (t[0] === "name" ||
          t[0] === "summary" ||
          t[0] === "description" ||
          t[0] === "l" ||
          t[0] === "t") &&
        typeof t[1] === "string"
      ) {
        fields.push(t[1])
      }
    }
  }
  return fields.some(f => f.toLowerCase().includes(filter))
}

// Picks the best language variant of a listing's tag (name, summary,
// description). Tag shape: ["<name>", "<value>", "<lang?>"].
function localizedListingTag(listing, tagName) {
  if (!listing) return null
  const matches = listing.tags.filter(
    t => t[0] === tagName && typeof t[1] === "string" && t[1].length > 0
  )
  if (matches.length === 0) return null
  const userLang =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language.slice(0, 2).toLowerCase()
      : "en"
  return (
    matches.find(t => (t[2] || "").toLowerCase() === userLang)?.[1] ||
    matches.find(t => !t[2] || t[2].toLowerCase() === "en")?.[1] ||
    matches[0][1]
  )
}

// Renders a category label like "napp.utilities:office" into a friendlier
// "office · utilities" form for the chip text.
function formatCategory(label) {
  const m = /^napp\.([^:]+):(.+)$/.exec(label)
  if (!m) return label
  return `${m[2]} · ${m[1]}`
}
