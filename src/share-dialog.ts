// The share screen — the consent screen's twin (same shell, same app sections)
// for the other direction: what a link will carry. Every window of the space is
// a section with a tick to include it and its actions below, each with a tick
// and an editable payload. "Create link" runs the reachability check (one state
// line per app, updated in place), then the link appears with a copy button — a
// click, so the clipboard write is a user gesture wherever it runs.
import { openDialog } from "./dialog.js"
import { nameRow, sectionHead } from "./napp-permissions.js"
import { button, check } from "./system-napps/ui.js"
import type { LinkAction } from "./share-link.js"

export interface ShareWindow {
  // The app — one check covers every window of it.
  key: string
  title: string
  icon?: string
  type?: string
  // No address to share (dev, local): listed unticked and disabled.
  shareable: boolean
  // Payload null: can't be written into a link — listed, disabled.
  actions: Array<{ name: string; payload: string | null }>
}

export interface ShareCheck {
  input: string
  uploaded: number
  missing: string
  hints: number
}

export function openShareDialog(opts: {
  name: string
  windows: ShareWindow[]
  check(key: string, onProgress: (msg: string) => void): Promise<ShareCheck>
  buildLink(name: string, windows: Array<{ input: string; actions: LinkAction[] }>): string
  // An edited payload, made link-safe (null: it can't be).
  encode(name: string, payload: string): string | null
}): Promise<void> {
  return openDialog<void>({
    dismissValue: undefined,
    class: "napp-perms-dialog",
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "napp-perms"

      const title = document.createElement("div")
      title.className = "napp-perms-name"
      title.textContent = "Share this space"
      const intro = document.createElement("p")
      intro.className = "napp-perms-reqs"
      const n = opts.windows.length
      intro.textContent = `${n} window${n === 1 ? "" : "s"}. Untick what shouldn't go in the link; the name and payloads can be edited.`
      const name = nameRow(opts.name)
      wrap.append(title, intro, name.el)

      type Row = {
        w: ShareWindow
        include: HTMLInputElement
        actions: Array<{ name: string; tick: HTMLInputElement; field: HTMLTextAreaElement | null }>
        state: HTMLElement
      }
      const rows: Row[] = opts.windows.map(w => {
        const el = document.createElement("div")
        el.className = "napp-perms-app napp-perms-shared"
        const head = document.createElement("label")
        head.className = "share-head"
        const include = check({ checked: w.shareable })
        if (!w.shareable) include.disabled = true
        head.append(include, sectionHead(w))
        el.appendChild(head)

        const state = document.createElement("div")
        state.className = "share-state"
        if (!w.shareable) state.textContent = "no address to share"
        else state.hidden = true
        el.appendChild(state)

        const list = document.createElement("div")
        list.className = "share-actions"
        // An action: tick + name on one line, the payload below it in a
        // textarea that grows or resizes for the long ones (nevents, lists).
        const actions = w.actions.map(a => {
          const row = document.createElement("div")
          row.className = "share-action"
          const head = document.createElement("label")
          head.className = "share-action-head"
          const tick = check({ checked: a.payload != null && w.shareable })
          const name = document.createElement("span")
          name.className = "share-action-name"
          name.textContent = a.name
          head.append(tick, name)
          row.appendChild(head)
          let field: HTMLTextAreaElement | null = null
          if (a.payload == null) {
            tick.disabled = true
            const note = document.createElement("span")
            note.className = "share-action-note"
            note.textContent = "can't go in a link"
            head.appendChild(note)
          } else {
            field = document.createElement("textarea")
            field.className = "ui-input share-payload"
            field.value = a.payload
            field.rows = 2
            field.spellcheck = false
            row.appendChild(field)
          }
          list.appendChild(row)
          return { name: a.name, tick, field }
        })
        if (actions.length) el.appendChild(list)
        wrap.appendChild(el)
        return { w, include, actions, state }
      })

      const url = document.createElement("div")
      url.className = "share-url"
      url.hidden = true
      wrap.appendChild(url)

      const buttons = document.createElement("div")
      buttons.className = "napp-perms-actions"
      const cancel = button({ label: "Cancel", variant: "outline", onClick: () => resolve() })
      const create = button({ label: "Create link", variant: "primary", onClick: () => void run() })
      buttons.append(cancel, create)
      wrap.appendChild(buttons)

      async function run() {
        const included = rows.filter(r => r.include.checked && r.w.shareable)
        if (!included.length) return
        // Freeze the choices: the check is about exactly these.
        create.disabled = true
        name.input.disabled = true
        for (const r of rows) {
          r.include.disabled = true
          for (const a of r.actions) {
            a.tick.disabled = true
            if (a.field) a.field.disabled = true
          }
        }
        // One check per app; every window of it shows the same state.
        const checks = new Map<string, ShareCheck>()
        for (const r of included) {
          r.state.hidden = false
          r.state.classList.remove("danger")
          let c = checks.get(r.w.key)
          if (!c) {
            c = await opts.check(r.w.key, msg => (r.state.textContent = msg))
            checks.set(r.w.key, c)
          }
          if (c.missing) {
            r.state.textContent = `${c.missing} missing on every server — whoever opens the link won't get this app`
            r.state.classList.add("danger")
          } else {
            const parts = ["ok"]
            if (c.uploaded)
              parts.push(`${c.uploaded} blob${c.uploaded === 1 ? "" : "s"} re-uploaded`)
            parts.push(
              c.hints ? `${c.hints} relay hint${c.hints === 1 ? "" : "s"}` : "no relay hints"
            )
            r.state.textContent = parts.join(", ")
          }
        }
        const link = opts.buildLink(
          name.input.value.trim() || opts.name,
          included.map(r => {
            const actions: LinkAction[] = []
            for (const a of r.actions) {
              if (!a.tick.checked || !a.field) continue
              const payload = opts.encode(a.name, a.field.value.trim())
              // Not link-safe as edited: shown, and left out.
              a.field.classList.toggle("invalid", payload == null)
              if (payload != null) actions.push({ name: a.name, payload })
            }
            return { input: checks.get(r.w.key)!.input, actions }
          })
        )
        url.textContent = link
        url.hidden = false
        cancel.textContent = "Close"
        const copy = button({
          label: "copy link",
          variant: "primary",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(link)
              copy.textContent = "copied!"
              setTimeout(() => (copy.textContent = "copy link"), 1500)
            } catch {
              copy.textContent = "select the link and copy"
            }
          }
        })
        create.replaceWith(copy)
      }

      return wrap
    }
  })
}
