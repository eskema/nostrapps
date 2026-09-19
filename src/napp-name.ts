// What to call a napp when a person is reading. Ids are a pubkey prefix and a
// d-tag ("3bf0c63fcb934634~contacts"), which says nothing to anyone — so every
// prompt, toast and list that names an app says "<title> from <author>", the
// same line the Apps card shows. (host.ts has a nappLabel of its own — that
// one is the origin label, nothing to do with these.)
import "nostr-web-components" // registers <nostr-name>
import { bareNostrUser } from "@nostr/gadgets/metadata"
import { getInstalledApp } from "./persistence.js"
import { authorDisplayNames } from "./system-napps/card.js"

export interface NappName {
  title: string
  // The publisher's full pubkey — only apps carrying a manifest event have one.
  author: string | null
  // Stands in for the author when there is no manifest: dev / temp / local.
  authorLabel: string | null
  // Whether we found the app at all. False → title is the bare id, nothing
  // better to show.
  known: boolean
}

export function nappName(nappId: string): NappName {
  const system = /^__(.+)__$/.exec(nappId)
  if (system) return { title: system[1], author: null, authorLabel: null, known: true }
  const app = getInstalledApp(nappId)
  if (!app) return { title: nappId, author: null, authorLabel: null, known: false }
  return {
    // The petname first: what the user calls it beats what it calls itself.
    title: app.petname || app.title || nappId,
    author: app.event?.pubkey || null,
    authorLabel: app.event?.pubkey
      ? null
      : nappId.startsWith("dev~")
        ? "dev"
        : nappId.startsWith("temp~") || app.temporary
          ? "temp"
          : "local",
    known: true
  }
}

// "<title> from <author>" as a node, so the author's name fills itself in when
// the profile lands. The raw id rides along as the title attribute — the only
// place it is still worth having.
export function nappNameEl(nappId: string): HTMLElement {
  const { title, author, authorLabel } = nappName(nappId)
  const el = nameEl(title, author)
  el.title = nappId
  if (!author && authorLabel) el.append(` (${authorLabel})`)
  return el
}

// The same line for an app the launcher has no record of: an install screen
// knows the title and the publisher off the manifest, before there is anything
// to look up.
export function nameEl(title: string, author?: string | null): HTMLElement {
  const el = document.createElement("span")
  el.className = "napp-name"
  const name = document.createElement("strong")
  name.textContent = title
  el.appendChild(name)
  if (author) {
    const who = document.createElement("nostr-name")
    who.setAttribute("pubkey", author)
    // Text at once — the name if it's known, else the short npub: the element
    // only fills its own in later, and an empty gap would jump when it did.
    who.textContent = authorDisplayNames.get(author) ?? bareNostrUser(author).shortName
    el.append(" from ", who)
  }
  return el
}

// The same line as plain text, for the places that take a string (toasts, the
// log). No live update: whatever the author's name is right now.
export function nappNameText(nappId: string): string {
  const { title, author, authorLabel } = nappName(nappId)
  if (author) {
    const who = authorDisplayNames.get(author) ?? bareNostrUser(author).shortName
    return `${title} from ${who}`
  }
  return authorLabel ? `${title} (${authorLabel})` : title
}
