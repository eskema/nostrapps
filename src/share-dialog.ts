// The share screen — the consent screen's twin (same shell, same app sections)
// for the other direction: what a link will carry. "share space as <name>",
// then every window of the space as a section with a tick to include it and
// its actions below, each with a tick and an editable payload. Create link
// drops what's unticked, freezes the rest into plain text, runs one
// reachability check over every app — the type badge at the end of an app's
// line turns into its state: checking…, then all good or error, the details
// of anything wrong in one status below — then shows the link in a box with
// a copy button (a click, so the clipboard write is a user gesture wherever
// it runs).
import { openDialog } from "./dialog.js"
import { sectionHead } from "./napp-permissions.js"
import { button, check, input } from "./system-napps/ui.js"
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
  // The check itself failed (relays unreachable, …): the naddr has no hints.
  error?: string
}

export function openShareDialog(opts: {
  name: string
  windows: ShareWindow[]
  // One check for all the apps at once (one signing prompt for the uploads).
  check(keys: string[]): Promise<Map<string, ShareCheck>>
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

      const title = document.createElement("label")
      title.className = "share-title-row"
      const lead = document.createElement("span")
      lead.textContent = "share"
      // "space as" folds away once the name is settled, and the field turns
      // into the title's bold text where it stands.
      const extra = document.createElement("span")
      extra.className = "share-title-extra"
      extra.textContent = "space as"
      const name = input({ value: opts.name, spellcheck: false })
      title.append(lead, extra, name)
      wrap.appendChild(title)

      type ActionRow = {
        name: string
        row: HTMLElement
        tick: HTMLInputElement
        field: HTMLTextAreaElement | null
      }
      type Row = {
        w: ShareWindow
        el: HTMLElement
        include: HTMLInputElement
        state: HTMLElement
        actions: ActionRow[]
      }
      const rows: Row[] = opts.windows.map(w => {
        const el = document.createElement("div")
        el.className = "napp-perms-app napp-perms-shared"
        const head = document.createElement("label")
        head.className = "share-head"
        const include = check({ checked: w.shareable })
        if (!w.shareable) include.disabled = true
        // The type badge at the line's end is the state slot: the check
        // writes over it.
        const headEl = sectionHead({ title: w.title, icon: w.icon, type: w.type || "app" })
        const state = headEl.querySelector<HTMLElement>(".napp-perms-type")!
        state.classList.add("share-state")
        if (!w.shareable) state.textContent = "no address"
        head.append(include, headEl)
        el.appendChild(head)

        const list = document.createElement("div")
        list.className = "share-actions"
        // An action: tick + name on one line, the payload below it in a
        // textarea that grows or resizes for the long ones (nevents, lists).
        const actions = w.actions.map((a): ActionRow => {
          const row = document.createElement("div")
          row.className = "share-action"
          const actionHead = document.createElement("label")
          actionHead.className = "share-action-head"
          const tick = check({ checked: a.payload != null && w.shareable })
          const nameEl = document.createElement("span")
          nameEl.className = "share-action-name"
          nameEl.textContent = a.name
          actionHead.append(tick, nameEl)
          row.appendChild(actionHead)
          let field: HTMLTextAreaElement | null = null
          if (a.payload == null) {
            tick.disabled = true
            const note = document.createElement("span")
            note.className = "share-action-note"
            note.textContent = "can't go in a link"
            actionHead.appendChild(note)
          } else {
            field = document.createElement("textarea")
            field.className = "ui-input share-payload"
            field.value = a.payload
            field.rows = 2
            field.spellcheck = false
            row.appendChild(field)
          }
          list.appendChild(row)
          return { name: a.name, row, tick, field }
        })
        if (actions.length) el.appendChild(list)
        wrap.appendChild(el)
        return { w, el, include, state, actions }
      })

      // What went wrong, app by app — only shown when something did.
      const status = document.createElement("div")
      status.className = "share-status share-in"
      status.hidden = true
      const url = document.createElement("textarea")
      url.className = "ui-input share-url share-in"
      url.rows = 3
      url.readOnly = true
      url.hidden = true
      wrap.append(status, url)

      const buttons = document.createElement("div")
      buttons.className = "napp-perms-actions"
      const cancel = button({ label: "Cancel", variant: "outline", onClick: () => resolve() })
      const create = button({ label: "Create link", variant: "primary", onClick: () => void run() })
      buttons.append(cancel, create)
      wrap.appendChild(buttons)

      async function run() {
        const included = rows.filter(r => r.include.checked && r.w.shareable)
        if (!included.length) return
        create.disabled = true
        const chosen = name.value.trim() || opts.name
        // The name is settled: the field reads as the title now (.share-created).
        name.value = chosen
        name.readOnly = true
        name.tabIndex = -1
        const problems: string[] = []

        // The link carries exactly what's ticked: the rest goes, the rest
        // freezes into plain text where it stands (.share-created).
        for (const r of rows) {
          if (!included.includes(r)) {
            r.el.remove()
            continue
          }
          for (const a of r.actions) {
            const payload =
              a.tick.checked && a.field ? opts.encode(a.name, a.field.value.trim()) : null
            if (payload == null) {
              if (a.tick.checked && a.field) {
                problems.push(`${r.w.title}: the ${a.name} payload isn't link-safe, left out`)
              }
              a.row.remove()
              continue
            }
            a.field!.value = payload // what the link gets (an npub for a hex key, …)
            a.field!.readOnly = true
            a.field!.tabIndex = -1
          }
        }
        wrap.classList.add("share-created")

        // One check over every app; a window shows its app's state.
        const keys = [...new Set(included.map(r => r.w.key))]
        const byKey = (key: string) => included.filter(r => r.w.key === key)
        for (const r of included) {
          r.state.textContent = "checking…"
          r.state.classList.add("checking")
        }
        const checks = await opts.check(keys)
        for (const key of keys) {
          const c = checks.get(key)
          const fine = c && !c.error && !c.missing
          for (const r of byKey(key)) {
            r.state.textContent = fine ? "all good" : "error"
            r.state.classList.remove("checking")
            r.state.classList.toggle("good", !!fine)
            r.state.classList.toggle("bad", !fine)
          }
          const title = byKey(key)[0]?.w.title ?? key
          if (!c) problems.push(`${title}: not checked`)
          else if (c.error) problems.push(`${title}: ${c.error}`)
          else if (c.missing) {
            problems.push(
              `${title}: ${c.missing} missing on every server — whoever opens the link won't get it`
            )
          }
        }
        if (problems.length) {
          status.replaceChildren(
            ...problems.map(p => {
              const line = document.createElement("div")
              line.textContent = p
              return line
            })
          )
          status.hidden = false
        }

        const link = opts.buildLink(
          chosen,
          included.map(r => ({
            input: checks.get(r.w.key)?.input ?? "",
            actions: r.actions.flatMap(a =>
              a.row.isConnected && a.field ? [{ name: a.name, payload: a.field.value }] : []
            )
          }))
        )
        url.value = link
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
