// The per-napp permission screen. Shown before an app first runs and re-openable
// from an app card. It turns the app's `requires` declarations into the single
// granted `domains` list — nothing is serviced or reachable until it's ticked.
// The capability rows use the design-system item list (the relays-napp look).
// A share link opens several apps at once; promptSharedSpace lists them on one
// screen with a single set of grants for every app the link runs.
import { openDialog } from "./dialog.js"
import { check, button, input, radio, tab } from "./system-napps/ui.js"
import { nameEl } from "./napp-name.js"
import type { NappPolicy } from "./types.js"

// Title + short description per grantable capability. Keys are the requires
// domain names. `ui` isn't here — it's auto-granted and only named in the
// summary line, never a toggle.
const CAP_INFO: Record<string, { title: string; desc: string }> = {
  identity: { title: "identity", desc: "read your key and sign as you (NIP-07)" },
  theme: { title: "theme", desc: "matches your colors" },
  storage: { title: "storage", desc: "keeps its own data" },
  resource: { title: "resource", desc: "loads files via the launcher" },
  relay: { title: "relay", desc: "reads and posts events" },
  outbox: { title: "outbox", desc: "finds the right relays for you" },
  common: { title: "common", desc: "looks up profiles; follows/reacts/reports ask first" },
  inc: { title: "inc", desc: "talks to other open napplets" },
  link: { title: "link", desc: "opens links in new tabs (asks first)" },
  config: { title: "config", desc: "settings you edit in the launcher" },
  // Not relay access — nostr reads/writes always go through the launcher. This
  // is the app opening its OWN connections to the wider web.
  network: { title: "network", desc: "connects directly to the web (nostr works without it)" }
}

// Whether this browser holds a napp to the network lock the launcher sets on its
// window (the iframe `csp` attribute; Chromium only). Elsewhere the lock is
// best effort: a napp written to get around it can. Napplets are sealed in
// every browser, so this is about napps only.
const LOCK_ENFORCED = "csp" in HTMLIFrameElement.prototype

// Grantable rows are the NAP domains (network is appended separately).
const CAP_ORDER = [
  "identity",
  "theme",
  "storage",
  "resource",
  "relay",
  "outbox",
  "common",
  "inc",
  "link",
  "config"
]

// Everything the launcher can actually provide: the NAP domains we implement,
// plus the launcher-local extensions (ui auto-granted, network toggle).
const SUPPORTED_REQUIRES = new Set([...CAP_ORDER, "ui", "network"])

// The subset of a napp's declared `requires` this launcher doesn't implement —
// features that will silently not work. Shared with the Apps window so the card
// and detail view can flag them.
export function unsupportedRequires(domains: string[]): string[] {
  return [...new Set(domains.filter(d => d && !SUPPORTED_REQUIRES.has(d)))]
}

export interface PolicyPromptOpts {
  title: string
  // A ready-to-use src: a data:/http(s): icon, or a path on an origin that is
  // already serving (an installed app). NOT a raw manifest icon value — those
  // need resolving first, see nsite/icon.ts.
  icon?: string
  // The icon's bytes, for the install screens: they run before the napp's origin
  // serves anything, so its own files can only be shown from memory. Preferred
  // over `icon` when both are given.
  iconBlob?: Blob
  // What this app is — "nsite" | "napp" | "napplet" — shown next to the name.
  type?: string
  // Who published it, for the "<title> from <author>" line the queue shows a
  // waiting grant as. Only apps carrying a manifest have one.
  author?: string | null
  // Ambiguous load (a lone index.html): show an nsite/napplet toggle instead
  // of the static type, with `type` pre-selected. The choice is returned on
  // the resolved policy as `type`.
  chooseType?: boolean
  // Capability domains the napp declared via `requires`.
  declaredDomains: string[]
  // Existing policy when editing; absent on a fresh grant.
  current?: NappPolicy
  // "install" without placement: an install that opens nothing (a restore),
  // so its one button says install, not open.
  mode?: "install" | "edit"
  // An install: where the app opens once granted — the spaces to pick from,
  // the current one preselected, or a new one — or nowhere, installed only.
  // Absent, the screen grants and nothing more (a dev app, a temp one, an edit).
  placement?: { spaces: Array<{ id: string; name: string }>; current: string }
}

// Resolves to the granted policy (plus the chosen `type` when chooseType was
// set, and with placement the space to open in as `spaceId` — NEW_SPACE for a
// new one, null for install only), or null if the user cancelled/dismissed.
export type GrantedPolicy = NappPolicy & { type?: string; spaceId?: string | null }
export function promptNappPolicy(opts: PolicyPromptOpts): Promise<GrantedPolicy | null> {
  const edit = opts.mode === "edit"
  return openDialog<GrantedPolicy | null>({
    dismissValue: null,
    class: "napp-perms-dialog",
    queue: {
      kind: edit ? "permissions" : "install",
      name: nameEl(opts.title, opts.author),
      // Undecided while the screen is still asking which it is.
      type: opts.chooseType ? undefined : opts.type
    },
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "napp-perms"
      const section = policySection(opts)
      const place = opts.placement ? placementRow(opts.placement) : null
      const actions = actionRow(
        resolve,
        edit ? "Save" : opts.mode === "install" ? "Install" : "Open",
        () => (place ? { ...section.read(), spaceId: place.read() } : section.read())
      )
      if (place) {
        // "Open" is the wrong word for an install that opens nothing.
        const primary = actions.lastElementChild as HTMLButtonElement
        place.onChange = () => (primary.textContent = place.read() ? "Open" : "Install")
      }
      wrap.append(section.el, ...(place ? [place.el] : []), actions)
      return wrap
    }
  })
}

// The space id an install picks to open in a space made for it.
export const NEW_SPACE = "__new__"

// The install screen's "open after install" toggle, a grant row like the ones
// above it, with a tab per space under it (the current one selected) and one
// for a new space, hidden while unticked. read(): the space's id, NEW_SPACE,
// or null for install only.
function placementRow(p: { spaces: Array<{ id: string; name: string }>; current: string }) {
  const el = document.createElement("div")
  el.className = "napp-perms-place"
  const tabs = document.createElement("div")
  tabs.className = "napp-perms-place-tabs"
  let chosen = p.current
  const box = check({
    checked: true,
    onChange: on => {
      tabs.hidden = !on
      out.onChange()
    }
  })
  const out = { el, read: () => (box.checked ? chosen : null), onChange: () => {} }
  for (const s of [...p.spaces, { id: NEW_SPACE, name: "+ new space" }]) {
    const t: HTMLButtonElement = tab({
      label: s.name,
      active: s.id === chosen,
      onClick: () => {
        chosen = s.id
        for (const other of tabs.children) other.classList.toggle("active", other === t)
      }
    })
    tabs.appendChild(t)
  }
  el.append(permRow(box, "open after install"), tabs)
  return out
}

export interface SharedAppPrompt {
  // What the returned grant is keyed by (the temp id of a not-yet-installed app).
  key: string
  title: string
  icon?: string
  iconBlob?: Blob
  type?: string
  // Already installed: listed for the record, its own grants stay.
  installed: boolean
  declaredDomains: string[]
  // What the link will send this app, and whether the app handles that action.
  actions: Array<{ name: string; payload: string; supported: boolean }>
}

// The share-link screen, built from the share screen's parts so the two read
// alike: "open <name>" (editable — one the user already has is refused, since
// a kept space would sit beside its namesake), then every app the link opens
// with the actions it will receive and, for one not installed yet, its own
// capability rows — apps want very different things. Resolves to the name and
// the grants keyed by `key`, or null if cancelled.
export function promptSharedSpace(opts: {
  name: string
  // Names of the spaces the user has, which the new one can't take.
  taken: string[]
  apps: SharedAppPrompt[]
}): Promise<{ name: string; policies: Map<string, NappPolicy> } | null> {
  const taken = new Set(opts.taken.map(n => n.trim().toLowerCase()))
  return openDialog<{ name: string; policies: Map<string, NappPolicy> } | null>({
    dismissValue: null,
    class: "napp-perms-dialog",
    queue: { kind: "share link", name: opts.name },
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "napp-perms"

      const title = document.createElement("label")
      title.className = "share-title-row"
      const lead = document.createElement("span")
      lead.className = "share-title-lead"
      lead.textContent = "open"
      const name = input({ value: opts.name, spellcheck: false })
      title.append(lead, name)
      const note = document.createElement("p")
      note.className = "napp-perms-unsupported"
      note.hidden = true
      wrap.append(title, note)

      const sections = new Map<string, PolicySection>()
      for (const app of opts.apps) {
        const el = document.createElement("div")
        el.className = "napp-perms-app share-app"
        const type = app.installed ? [app.type, "installed"].filter(Boolean).join(" · ") : app.type
        const head = sectionHead({ ...app, type })
        head.querySelector(".napp-perms-name")?.classList.add("ui-title")
        el.appendChild(head)
        if (app.actions.length) el.appendChild(frozenActions(app.actions))
        if (!app.installed) {
          // Its own rows, under its actions. Nothing is installed until the
          // space is kept; the grant is the temp app's until then.
          const section = policySection(
            { title: "", declaredDomains: app.declaredDomains, type: app.type },
            null
          )
          sections.set(app.key, section)
          el.appendChild(section.el)
        }
        wrap.appendChild(el)
      }

      wrap.appendChild(
        actionRow(resolve, "Open", () => {
          const chosen = name.value.trim() || opts.name
          if (taken.has(chosen.toLowerCase())) {
            note.textContent = `You already have a space named "${chosen}" — pick another name.`
            note.hidden = false
            name.focus()
            return undefined
          }
          return { name: chosen, policies: new Map([...sections].map(([k, s]) => [k, s.read()])) }
        })
      )
      return wrap
    }
  })
}

interface PolicySection {
  el: HTMLElement
  read(): NappPolicy & { type?: string }
}

// One app's part of a permission screen: head, requires summary, and the
// grantable rows. `read()` collects the grant as ticked. `head` replaces the
// icon + name head; null for rows that sit under a head of their own.
function policySection(
  opts: PolicyPromptOpts,
  head: HTMLElement | null = sectionHead(opts)
): PolicySection {
  const cur = opts.current
  // Declared caps we implement (order-stable), minus network (its own row) and
  // ui (auto-granted). network is always offered so any app can be un-sealed.
  const declaredCaps = CAP_ORDER.filter(d => opts.declaredDomains.includes(d))
  const declaredUi = opts.declaredDomains.includes("ui")
  // Requirements this launcher doesn't implement. We can't grant them, but the
  // app declared them — surface them (unchecked, non-grantable) so the user
  // knows some features won't work rather than us silently dropping them.
  const unsupported = unsupportedRequires(opts.declaredDomains)
  // The effective type. With chooseType the user flips it live and the rows
  // re-render: napplet = exactly its declared NAP domains, no network (sealed);
  // nsite/napp = identity + declared + network, all default ON, deselectable.
  let type = opts.type || "nsite"
  const rowsFor = () =>
    type === "napplet" ? declaredCaps : [...new Set(["identity", ...declaredCaps, "network"])]

  const el = document.createElement("div")
  el.className = "napp-perms-app"
  if (head) el.appendChild(head)

  // Ambiguous load: a one-of-two pick in the same row language as the
  // capability rows below, radio at the left.
  if (opts.chooseType) {
    const pick = (t: "nsite" | "napplet", desc: string) => {
      const r = radio({
        name: "napp-type",
        checked: type === t,
        onChange: () => {
          type = t
          renderBody()
        }
      })
      el.appendChild(permRow(r, t, desc))
    }
    pick("nsite", "a website at its own origin")
    pick("napplet", "a sealed single-file app")
  }

  // Explicit, compact summary of what the app declares it needs.
  const reqs = document.createElement("p")
  reqs.className = "napp-perms-reqs"
  const declared = [...new Set(opts.declaredDomains.filter(Boolean))]
  reqs.textContent = `Requires: ${declared.length ? declared.join(", ") : "nothing"}`
  el.appendChild(reqs)
  // Declared requirements this launcher can't provide — named up top, same
  // as the apps-list badge; they never appear as checklist rows.
  if (unsupported.length) {
    const warn = document.createElement("p")
    warn.className = "napp-perms-unsupported"
    warn.textContent = `requires unsupported features: ${unsupported.join(", ")}`
    el.appendChild(warn)
  }

  // Capability rows, rebuilt when the type is flipped. Checkbox first,
  // then the title with its short description below.
  const body = document.createElement("div")
  const boxes = new Map<string, HTMLInputElement>()
  function renderBody() {
    boxes.clear()
    body.replaceChildren()
    for (const d of rowsFor()) {
      const box = check({ checked: cur ? cur.domains.includes(d) : true })
      boxes.set(d, box)
      const desc =
        d === "network" && !LOCK_ENFORCED && type !== "napplet"
          ? `${CAP_INFO.network.desc}; this browser can't enforce leaving it off`
          : CAP_INFO[d].desc
      body.appendChild(permRow(box, CAP_INFO[d].title, desc))
    }
  }
  renderBody()
  el.appendChild(body)

  return {
    el,
    read() {
      const domains = [...boxes].filter(([, b]) => b.checked).map(([d]) => d)
      if (declaredUi) domains.push("ui") // auto-granted, no toggle
      return opts.chooseType ? { domains, type } : { domains }
    }
  }
}

// Icon + name, with the type as the kit's overline at the line's end. The name
// is the same "<title> from <author>" line every other prompt names an app by.
// Shared with the share screen, the consent screen's twin, where the badge
// doubles as the app's check state.
export function sectionHead(opts: {
  title: string
  icon?: string
  iconBlob?: Blob
  type?: string
  author?: string | null
  chooseType?: boolean
}): HTMLElement {
  const head = document.createElement("div")
  head.className = "napp-perms-head"
  const iconSrc = opts.iconBlob ? URL.createObjectURL(opts.iconBlob) : opts.icon
  if (iconSrc) {
    const img = document.createElement("img")
    img.className = "napp-perms-icon"
    img.alt = ""
    // Revoke once the bitmap is decoded (it survives the revoke). There's no
    // placeholder to fall back to, so an icon that won't load drops out and
    // leaves the name on its own rather than showing a broken-image glyph.
    const release = () => {
      if (opts.iconBlob) URL.revokeObjectURL(iconSrc)
    }
    img.addEventListener("load", release)
    img.addEventListener("error", () => {
      release()
      img.remove()
    })
    img.src = iconSrc
    head.appendChild(img)
  }
  const name = document.createElement("div")
  name.className = "napp-perms-name"
  name.appendChild(nameEl(opts.title, opts.author))
  if (opts.type && !opts.chooseType) {
    const t = document.createElement("span")
    t.className = "napp-perms-type ui-overline"
    t.textContent = opts.type
    name.appendChild(t)
  }
  head.appendChild(name)
  return head
}

// The actions a link sends an app, the way the share screen shows them once
// frozen: name over payload. Ones the app doesn't handle are struck through
// and won't be sent.
function frozenActions(
  actions: Array<{ name: string; payload: string; supported: boolean }>
): HTMLElement {
  const list = document.createElement("div")
  list.className = "share-actions frozen"
  for (const a of actions) {
    const row = document.createElement("div")
    row.className = "share-action frozen" + (a.supported ? "" : " unsupported")
    const name = document.createElement("div")
    name.className = "share-action-name"
    name.textContent = a.name
    row.appendChild(name)
    if (a.payload) {
      const text = document.createElement("div")
      text.className = "ui-input share-payload frozen"
      text.textContent = a.payload
      row.appendChild(text)
    }
    if (!a.supported) row.title = "This app doesn't handle that action"
    list.appendChild(row)
  }
  return list
}

// Cancel / confirm pair; `value` computes what the confirm resolves with —
// or returns undefined to keep the screen open (something to fix first).
function actionRow<T>(resolve: (v: T | null) => void, label: string, value: () => T | undefined) {
  const actions = document.createElement("div")
  actions.className = "napp-perms-actions"
  actions.append(
    button({ label: "Cancel", variant: "outline", onClick: () => resolve(null) }),
    button({
      label,
      variant: "primary",
      onClick: () => {
        const v = value()
        if (v !== undefined) resolve(v)
      }
    })
  )
  return actions
}

// A grantable row: checkbox at the left, then the title with its description
// stacked below it. The whole row is a <label>, so clicking anywhere toggles.
// Exported because it is the shape for any labelled checkbox, not just a grant
// — the uploader's "protected" reads as one of these.
export function permRow(box: HTMLInputElement, title: string, desc?: string): HTMLLabelElement {
  const row = document.createElement("label")
  row.className = "napp-perms-row"
  const text = document.createElement("div")
  text.className = "napp-perms-text"
  const l = document.createElement("div")
  l.className = "napp-perms-label"
  l.textContent = title
  text.append(l)
  if (desc) {
    const d = document.createElement("div")
    d.className = "napp-perms-desc"
    d.textContent = desc
    text.append(d)
  }
  row.append(box, text)
  return row
}
