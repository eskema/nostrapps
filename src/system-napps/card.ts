import "nostr-web-components" // registers <nostr-picture> / <nostr-name>
import { bareNostrUser } from "@nostr/gadgets/metadata"
import type { AppType } from "../types.js"

// ─── Unified app card ────────────────────────────────────────────
// The one card shape the app shows for a napp: the Apps window renders it in
// both tabs and again, larger, at the top of the app-info detail (see
// `.apps-detail-overlay .apps-card`), and the uploader previews an unpublished
// napp with it. Its own module so none of those imports the others.

export const PLACEHOLDER_SRC = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'

// Author display names by pubkey, filled as profiles land (apps.ts, in
// loadAuthorNames): a card built afterwards shows the name at once, instead
// of the short npub its <nostr-name> would flash first.
export const authorDisplayNames = new Map<string, string>()

export interface AppCardOpts {
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
export function renderAppCard(o: AppCardOpts): HTMLElement {
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
  // Fades in once a real icon has loaded (.loaded, see the CSS); the plate
  // behind it is the card's own, so it's there from the start. The attribute,
  // not .src: the getter re-encodes the placeholder's data URI.
  icon.addEventListener("load", () =>
    icon.classList.toggle("loaded", icon.getAttribute("src") !== PLACEHOLDER_SRC)
  )
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
    // Text at once — the name if it's known, else the short npub: the element
    // only fills its own in later, and an empty line would jump when it did.
    name.textContent =
      authorDisplayNames.get(o.authorPubkey) ?? bareNostrUser(o.authorPubkey).shortName
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

// ─── app metadata fields ─────────────────────────────────────────
// The Apps detail's field shape, shared so anything showing the same fact
// elsewhere (the uploader's napp id) renders it identically.

export function code(text: string): HTMLElement {
  const c = document.createElement("code")
  c.textContent = text
  return c
}

// A field, addressable via .apps-detail-<key> (e.g. .apps-detail-id). The
// .apps-detail-label is added only when a label is given; the value always gets
// .apps-detail-value.
export function detailField(key: string, value: HTMLElement, label?: string): HTMLElement {
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
