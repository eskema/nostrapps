// The per-napp permission screen. Shown before an app first runs and re-openable
// from an app card. It turns the app's `requires` declarations into the single
// granted `domains` list — nothing is serviced or reachable until it's ticked.
// The capability rows use the design-system item list (the relays-napp look).
import { openDialog } from "./dialog.js"
import { check, button } from "./system-napps/ui.js"
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
  // Not relay access — nostr reads/writes always go through the launcher. This
  // is the app opening its OWN connections to the wider web.
  network: { title: "network", desc: "connects directly to the web (nostr works without it)" }
}

// Grantable rows are the NAP domains (network is appended separately).
const CAP_ORDER = ["identity", "theme", "storage", "resource", "relay", "outbox"]

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
  icon?: string
  // What this app is — "nsite" | "napp" | "napplet" — shown next to the name.
  type?: string
  // Capability domains the napp declared via `requires`.
  declaredDomains: string[]
  // Existing policy when editing; absent on a fresh grant.
  current?: NappPolicy
  mode?: "install" | "edit"
}

// Resolves to the granted policy, or null if the user cancelled/dismissed.
export function promptNappPolicy(opts: PolicyPromptOpts): Promise<NappPolicy | null> {
  const cur = opts.current
  const edit = opts.mode === "edit"
  // Declared caps we implement (order-stable), minus network (its own row) and
  // ui (auto-granted). network is always offered so any app can be un-sealed.
  const declaredCaps = CAP_ORDER.filter(d => opts.declaredDomains.includes(d))
  const declaredUi = opts.declaredDomains.includes("ui")
  // napplet: exactly its declared NAP domains, no network (sealed). nsite/napp:
  // `identity` (the NIP-07 signer we intercept) is always offered even though
  // nsites don't declare it, plus any declared domains, plus network — all
  // default ON for a website, all deselectable.
  const rows =
    opts.type === "napplet"
      ? declaredCaps
      : [...new Set(["identity", ...declaredCaps, "network"])]
  // Requirements this launcher doesn't implement. We can't grant them, but the
  // app declared them — surface them (unchecked, non-grantable) so the user
  // knows some features won't work rather than us silently dropping them.
  const unsupported = unsupportedRequires(opts.declaredDomains)

  return openDialog<NappPolicy | null>({
    dismissValue: null,
    class: "napp-perms-dialog",
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "napp-perms"

      const head = document.createElement("div")
      head.className = "napp-perms-head"
      if (opts.icon) {
        const img = document.createElement("img")
        img.className = "napp-perms-icon"
        img.src = opts.icon
        img.alt = ""
        head.appendChild(img)
      }
      const name = document.createElement("div")
      name.className = "napp-perms-name"
      name.textContent = opts.title
      if (opts.type) {
        const t = document.createElement("span")
        t.className = "napp-perms-type"
        t.textContent = opts.type
        name.appendChild(t)
      }
      head.appendChild(name)
      wrap.appendChild(head)

      // Explicit, compact summary of what the app declares it needs.
      const reqs = document.createElement("p")
      reqs.className = "napp-perms-reqs"
      const declared = [...new Set(opts.declaredDomains.filter(Boolean))]
      reqs.textContent = `Requires: ${declared.length ? declared.join(", ") : "nothing"}`
      wrap.appendChild(reqs)

      // Capability rows: checkbox first, then the title with its short
      // description on the row below. Grows as capabilities are added.
      const boxes = new Map<string, HTMLInputElement>()
      const addRow = (domain: string, checked: boolean) => {
        const box = check({ checked })
        boxes.set(domain, box)
        wrap.appendChild(permRow(box, CAP_INFO[domain].title, CAP_INFO[domain].desc))
      }
      for (const d of rows) addRow(d, cur ? cur.domains.includes(d) : true)
      // Declared-but-unsupported requirements: shown, dimmed, never grantable.
      for (const d of unsupported) wrap.appendChild(unsupportedRow(d))

      const actions = document.createElement("div")
      actions.className = "napp-perms-actions"
      actions.append(
        button({ label: "Cancel", variant: "outline", onClick: () => resolve(null) }),
        button({
          label: edit ? "Save" : "Open",
          variant: "primary",
          onClick: () => {
            const domains = [...boxes].filter(([, b]) => b.checked).map(([d]) => d)
            if (declaredUi) domains.push("ui") // auto-granted, no toggle
            resolve({ domains })
          }
        })
      )
      wrap.appendChild(actions)
      return wrap
    }
  })
}

// A grantable row: checkbox at the left, then the title with its description
// stacked below it. The whole row is a <label>, so clicking anywhere toggles.
function permRow(box: HTMLInputElement, title: string, desc: string): HTMLLabelElement {
  const row = document.createElement("label")
  row.className = "napp-perms-row"
  const text = document.createElement("div")
  text.className = "napp-perms-text"
  const l = document.createElement("div")
  l.className = "napp-perms-label"
  l.textContent = title
  const d = document.createElement("div")
  d.className = "napp-perms-desc"
  d.textContent = desc
  text.append(l, d)
  row.append(box, text)
  return row
}

// A declared requirement this launcher can't provide: same layout as a grantable
// row but non-interactive (a plain div, no checkbox), with a muted "✕" marker
// and an "unsupported" tag. Never added to the granted set.
function unsupportedRow(domain: string): HTMLDivElement {
  const row = document.createElement("div")
  row.className = "napp-perms-row is-unsupported"
  const mark = document.createElement("span")
  mark.className = "napp-perms-mark"
  mark.textContent = "✕"
  const text = document.createElement("div")
  text.className = "napp-perms-text"
  const l = document.createElement("div")
  l.className = "napp-perms-label"
  l.textContent = domain
  const tag = document.createElement("span")
  tag.className = "napp-perms-tag"
  tag.textContent = "unsupported"
  l.appendChild(tag)
  const d = document.createElement("div")
  d.className = "napp-perms-desc"
  d.textContent = "this launcher can't provide this — the app may not work fully"
  text.append(l, d)
  row.append(mark, text)
  return row
}
