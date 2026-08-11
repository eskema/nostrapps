// The per-napp permission screen (NIP-5D + network lockdown). Shown at install
// and re-openable from an app card. It turns `requires` declarations and the
// network toggle into a NappPolicy the user actually grants — nothing is
// serviced or reachable until it's ticked here.
import { openDialog } from "./dialog.js"
import { check, button } from "./system-napps/ui.js"
import type { NappPolicy } from "./types.js"

// Capability domains the launcher actually implements, with human copy. Keep the
// keys in sync with NAPPLET_OFFERED in sandbox/host.ts.
const DOMAIN_INFO: Record<string, { label: string; desc: string }> = {
  identity: {
    label: "Identity",
    desc: "Read-only: your public key, profile, follows, mutes and relay list. It never signs or prompts your signer."
  },
  theme: {
    label: "Theme",
    desc: "Match the launcher's colors and follow theme changes."
  }
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
  const known = opts.declaredDomains.filter(d => d in DOMAIN_INFO)
  const cur = opts.current
  const edit = opts.mode === "edit"

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
      const netBox = check({ checked: cur ? cur.network : false })
      wrap.appendChild(
        permRow(
          netBox,
          "Allow direct network access",
          "Let this app connect to any server on its own (fetch, WebSocket, relays). Off keeps it sealed to its own files — its only way out is the capabilities above, through the launcher."
        )
      )

      const actions = document.createElement("div")
      actions.className = "napp-perms-actions"
      actions.append(
        button({ label: "Cancel", variant: "outline", onClick: () => resolve(null) }),
        button({
          label: edit ? "Save" : "Install",
          variant: "primary",
          onClick: () =>
            resolve({
              network: netBox.checked,
              domains: [...boxes].filter(([, b]) => b.checked).map(([d]) => d)
            })
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
