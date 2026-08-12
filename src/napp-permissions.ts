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
  identity: { title: "identity", desc: "can read your identity" },
  theme: { title: "theme", desc: "matches your colors" },
  storage: { title: "storage", desc: "keeps its own data" },
  resource: { title: "resource", desc: "loads files via the launcher" },
  relay: { title: "relay", desc: "reads and posts events" },
  network: { title: "network", desc: "can communicate" }
}

// Grantable rows are the NAP domains (network is appended separately).
const CAP_ORDER = ["identity", "theme", "storage", "resource", "relay"]

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
  const known = CAP_ORDER.filter(d => opts.declaredDomains.includes(d))
  const declaredNetwork = opts.declaredDomains.includes("network")
  const declaredUi = opts.declaredDomains.includes("ui")

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
      for (const d of known) addRow(d, cur ? cur.domains.includes(d) : true)
      // Napplets are sealed by design (srcdoc CSP blocks direct network no
      // matter what), so there's nothing to grant — don't offer network.
      if (opts.type !== "napplet") {
        addRow("network", cur ? cur.domains.includes("network") : declaredNetwork)
      }

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
