// The launcher's row for a thing to open: a slash command, an open window, an
// installed app, a recent link. Built here for the input's list and for the
// handler picker, which offers windows and apps the same way. What the row
// does when clicked is the context's; so is a link row's forget.
import type { SuggestionItem } from "./types.js"
import { appIcon, author as authorEl, badge, icon } from "./system-napps/ui.js"
import { isInstanceSerial } from "./utils.js"

export function suggestionRow(item: SuggestionItem): HTMLDivElement {
  const el = document.createElement("div")
  el.className = "suggestion"

  const main = document.createElement("span")
  main.className = "sugg-main"
  let title: HTMLElement | null = null // the icon slots in right after it
  // What trails the row: "<type> from <author>" for an installed app, the space
  // it lives in for an open window.
  let trail: HTMLElement | null = null

  if (item.systemId || item.actionId) {
    const cmd = document.createElement("span")
    cmd.className = "sugg-slash"
    cmd.textContent = item.slash || null
    main.appendChild(cmd)
  } else if (item.link) {
    // A recent row: the name, and how long ago.
    title = document.createElement("span")
    title.className = "sugg-pet"
    title.textContent = item.petname || null
    main.appendChild(title)
    trail = document.createElement("span")
    trail.className = "sugg-when"
    trail.textContent = item.when || null
  } else if (item.raw) {
    const raw = document.createElement("span")
    raw.className = "sugg-raw"
    raw.textContent = item.raw || null
    main.appendChild(raw)
  } else {
    // Like the Apps card: title (and icon). An installed app trails with
    // "<type> from <author>"; an open window shows its instance id here and
    // trails with its space instead. No installed record: the bare id stands in.
    if (item.petname) {
      title = document.createElement("span")
      title.className = "sugg-pet"
      title.textContent = item.petname
      main.appendChild(title)
    } else {
      const napp = document.createElement("span")
      napp.className = "sugg-napp"
      napp.textContent = item.nappId || null
      main.appendChild(napp)
    }
    if (item.source === "napp" && (item.author || item.authorLabel)) {
      trail = document.createElement("span")
      trail.className = "sugg-author"
      if (item.author) {
        // The kit's author, not a link: the row is what's clicked.
        trail.append(`${item.appType} from `, authorEl(item.author, { link: false }))
      } else {
        trail.textContent = `${item.appType} · ${item.authorLabel}`
      }
    }
    if (item.instanceId && isInstanceSerial(item.instanceId)) {
      const id = document.createElement("span")
      id.className = "sugg-id"
      id.textContent = item.instanceId
      main.appendChild(id)
    }
    // Global view: every open window is tagged with the space it lives in. The
    // current space's windows are de-emphasized (you're already in it).
    if (item.source === "open" && item.spaceName) {
      trail = document.createElement("span")
      trail.className = item.spaceCurrent ? "sugg-space sugg-space-current" : "sugg-space"
      trail.append(icon("window"), document.createTextNode(item.spaceName))
    }
  }

  el.appendChild(main)
  if (trail) el.appendChild(trail)
  // Slash rows carry their affordance label at the right edge, recent rows what
  // they were (a link, a space); app rows trail with their author line or space
  // instead.
  if (item.source === "system" || item.source === "action" || item.source === "recent") {
    el.appendChild(badge(item.kind || item.source, { class: "source" }))
  }
  // The app's icon, next to its title: the probed src, already settled when the
  // list was warmed ahead of time, so it lands before the paint. No src means
  // no icon — there's no placeholder.
  item.icon?.then(src => {
    if (!src || !el.isConnected) return
    const img = appIcon({ src, size: "s", class: "sugg-icon" })
    img.img.addEventListener("error", () => img.remove())
    if (title) title.after(img)
    else main.prepend(img)
  })

  return el
}
