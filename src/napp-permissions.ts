// The per-napp permission screen. Shown before an app first runs and re-openable
// from an app card. It turns the app's `requires` declarations into the single
// granted `domains` list — nothing is serviced or reachable until it's ticked.
// The capability rows use the design-system item list (the relays-napp look).
import { openDialog } from "./dialog.js"
import { check, button, radio } from "./system-napps/ui.js"
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
  icon?: string
  // What this app is — "nsite" | "napp" | "napplet" — shown next to the name.
  type?: string
  // Ambiguous load (a lone index.html): show an nsite/napplet toggle instead
  // of the static type, with `type` pre-selected. The choice is returned on
  // the resolved policy as `type`.
  chooseType?: boolean
  // Capability domains the napp declared via `requires`.
  declaredDomains: string[]
  // Existing policy when editing; absent on a fresh grant.
  current?: NappPolicy
  mode?: "install" | "edit"
}

// Resolves to the granted policy (plus the chosen `type` when chooseType was
// set), or null if the user cancelled/dismissed.
export function promptNappPolicy(
  opts: PolicyPromptOpts
): Promise<(NappPolicy & { type?: string }) | null> {
  const cur = opts.current
  const edit = opts.mode === "edit"
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

  return openDialog<(NappPolicy & { type?: string }) | null>({
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
      if (opts.type && !opts.chooseType) {
        const t = document.createElement("span")
        t.className = "napp-perms-type"
        t.textContent = opts.type
        name.appendChild(t)
      }
      head.appendChild(name)
      wrap.appendChild(head)

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
          wrap.appendChild(permRow(r, t, desc))
        }
        pick("nsite", "a website at its own origin")
        pick("napplet", "a sealed single-file app")
      }

      // Explicit, compact summary of what the app declares it needs.
      const reqs = document.createElement("p")
      reqs.className = "napp-perms-reqs"
      const declared = [...new Set(opts.declaredDomains.filter(Boolean))]
      reqs.textContent = `Requires: ${declared.length ? declared.join(", ") : "nothing"}`
      wrap.appendChild(reqs)
      // Declared requirements this launcher can't provide — named up top, same
      // as the apps-list badge; they never appear as checklist rows.
      if (unsupported.length) {
        const warn = document.createElement("p")
        warn.className = "napp-perms-unsupported"
        warn.textContent = `requires unsupported features: ${unsupported.join(", ")}`
        wrap.appendChild(warn)
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
          body.appendChild(permRow(box, CAP_INFO[d].title, CAP_INFO[d].desc))
        }
      }
      renderBody()
      wrap.appendChild(body)

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
            resolve(opts.chooseType ? { domains, type } : { domains })
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
