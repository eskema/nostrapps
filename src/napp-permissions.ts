// The per-napp permission screen. Shown at install and re-openable from an app
// card. It turns the app's `requires` declarations into the single granted
// `domains` list — nothing is serviced or reachable until it's ticked here.
import { openDialog } from "./dialog.js"
import { check, button } from "./system-napps/ui.js"
import type { NappPolicy } from "./types.js"

// The declarable capabilities, with human copy. NAP domains + the two
// launcher-local values (ui = component kit, network = direct network). Network
// is presented in its own section, not here.
const DOMAIN_INFO: Record<string, { label: string; desc: string }> = {
  identity: {
    label: "Identity",
    desc: "Read-only: your public key, profile, follows, mutes and relay list. It never signs or prompts your signer."
  },
  theme: {
    label: "Theme colors",
    desc: "Match the launcher's colors and follow theme changes."
  },
  ui: {
    label: "Shared UI kit",
    desc: "Use the launcher's buttons, inputs, fonts and icons so this app matches the rest. Cosmetic — no access to your data."
  },
  storage: {
    label: "Storage",
    desc: "A private key-value store for this app's own data, kept by the launcher."
  },
  resource: {
    label: "Fetch resources",
    desc: "Load images and files from the web through the launcher — works even when direct network is off."
  },
  relay: {
    label: "Relays",
    desc: "Read from relays, and publish events — each publish still asks your signer to approve it."
  }
}

const NETWORK_INFO = {
  label: "Direct network access",
  desc: "Let this app connect to any server on its own (fetch, WebSocket, relays). Off keeps it sealed to its own files — its only way out is the capabilities above, through the launcher."
}

export interface PolicyPromptOpts {
  title: string
  icon?: string
  // Capability domains the napp declared via `requires`. Unknown/unimplemented
  // ones are dropped — you can't grant what the launcher can't service.
  declaredDomains: string[]
  // Existing policy when editing; absent on a fresh install (defaults: caps
  // pre-ticked as the app asked for them, network OFF — the lockdown default).
  current?: NappPolicy
  mode?: "install" | "edit"
}

// Resolves to the granted policy, or null if the user cancelled/dismissed.
export function promptNappPolicy(opts: PolicyPromptOpts): Promise<NappPolicy | null> {
  const cur = opts.current
  const edit = opts.mode === "edit"
  // Capability rows: declared capabilities we know (incl `ui`), minus `network`
  // which has its own section. `network` is always offered even if undeclared,
  // so already-installed apps that declared nothing can still be un-sealed.
  const known = opts.declaredDomains.filter(d => d !== "network" && d in DOMAIN_INFO)
  const declaredNetwork = opts.declaredDomains.includes("network")

  return openDialog<NappPolicy | null>({
    title: edit ? "App permissions" : "Install — permissions",
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
      head.appendChild(name)
      wrap.appendChild(head)

      const sub = document.createElement("p")
      sub.className = "napp-perms-sub"
      sub.textContent = "Grant only what you trust this app with. Anything left unchecked stays blocked."
      wrap.appendChild(sub)

      const boxes = new Map<string, HTMLInputElement>()
      if (known.length) {
        wrap.appendChild(section("Capabilities"))
        for (const d of known) {
          const box = check({ checked: cur ? cur.domains.includes(d) : true })
          boxes.set(d, box)
          wrap.appendChild(permRow(box, DOMAIN_INFO[d].label, DOMAIN_INFO[d].desc))
        }
      }

      wrap.appendChild(section("Network"))
      const netBox = check({
        checked: cur ? cur.domains.includes("network") : declaredNetwork
      })
      wrap.appendChild(permRow(netBox, NETWORK_INFO.label, NETWORK_INFO.desc))

      const actions = document.createElement("div")
      actions.className = "napp-perms-actions"
      actions.append(
        button({ label: "Cancel", variant: "outline", onClick: () => resolve(null) }),
        button({
          label: edit ? "Save" : "Install",
          variant: "primary",
          onClick: () => {
            const domains = [...boxes].filter(([, b]) => b.checked).map(([d]) => d)
            if (netBox.checked) domains.push("network")
            resolve({ domains })
          }
        })
      )
      wrap.appendChild(actions)
      return wrap
    }
  })
}

function section(label: string): HTMLElement {
  const el = document.createElement("div")
  el.className = "napp-perms-section"
  el.textContent = label
  return el
}

// A clickable row: the whole label toggles its checkbox.
function permRow(box: HTMLInputElement, label: string, desc: string): HTMLLabelElement {
  const row = document.createElement("label")
  row.className = "napp-perms-row"
  const text = document.createElement("div")
  text.className = "napp-perms-text"
  const l = document.createElement("div")
  l.className = "napp-perms-label"
  l.textContent = label
  const d = document.createElement("div")
  d.className = "napp-perms-desc"
  d.textContent = desc
  text.append(l, d)
  row.append(box, text)
  return row
}
