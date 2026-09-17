// Settings' backups section, in the share screen's parts. First the backups
// made here, a line each (name and date) that opens to what it holds: view it
// (a view:<kind> action, for whichever napp shows those) or restore it. Then
// "create new backup", a line that opens to the name with save beside it and
// what can go in (apps, spaces, settings, relays), each a ticked section with
// its items below. Apps and spaces are picked one by one; settings and relays
// go whole, their rows only say what that means. Nothing is signed or sent
// yet: save only keeps a version locally, for now.
import type { EventTemplate } from "@nostr/tools/pure"
import type { SystemCtx } from "../types.js"
import * as persist from "../persistence.js"
import { dispatchAction } from "../handlers.js"
import {
  addrFor,
  BACKUP_KIND,
  backupEvent,
  listBackups,
  saveBackup,
  summarize,
  versionEvent,
  type BackupParts,
  type BackupVersion
} from "../backup.js"
import { nappNameEl, nappNameText } from "../napp-name.js"
import { sectionHead } from "../napp-permissions.js"
import { button, check, details, input } from "./ui.js"

type Row = { row: HTMLElement; tick: HTMLInputElement; name: HTMLElement; note: HTMLElement }
type Part = { el: HTMLElement; tick: HTMLInputElement; list: HTMLElement; rows: Map<string, Row> }
type Version = { el: HTMLDetailsElement }

// Ties the name's label to its field.
let nameSerial = 0

export function backupSection(ctx: SystemCtx): { el: HTMLDetailsElement; unmount(): void } {
  const el = details({ summary: "backups", class: "settings-backup" })
  const wrap = document.createElement("div")
  wrap.className = "napp-perms"
  el.appendChild(wrap)

  const versions = document.createElement("div")
  versions.className = "ui-items backup-versions"
  const empty = document.createElement("div")
  empty.className = "perm-empty"
  empty.textContent = "no backups found"
  wrap.append(versions, empty)
  const rows = new Map<string, Version>()

  const create = document.createElement("details")
  create.className = "backup-row backup-create"
  const createLine = document.createElement("summary")
  const createTitle = document.createElement("span")
  createTitle.className = "backup-row-title"
  createTitle.textContent = "create new backup"
  createLine.appendChild(createTitle)
  const createBody = document.createElement("div")
  createBody.className = "napp-perms backup-create-body"
  create.append(createLine, createBody)
  wrap.appendChild(create)

  // "name <name> [save]": the name is the slot a backup replaces.
  const title = document.createElement("div")
  title.className = "share-title-row backup-new"
  const name = input({ placeholder: "default", spellcheck: false, class: "backup-name" })
  name.id = `backup-name-${nameSerial++}`
  const lead = document.createElement("label")
  lead.className = "share-title-lead"
  lead.htmlFor = name.id
  lead.textContent = "name"
  const save = button({
    label: "save",
    variant: "primary",
    onClick: () => {
      saveBackup(composed())
      syncVersions()
    }
  })
  title.append(lead, name, save)
  createBody.appendChild(title)

  const apps = part("apps", true)
  const spaces = part("spaces", true)
  const settings = part("settings", true)
  const relays = part("relays", false)

  const theme = fixedRow(settings, "theme")
  const auto = fixedRow(relays, "always authenticate")
  const decisions = fixedRow(relays, "per-relay decisions")

  function composed() {
    syncSpaces()
    const parts: BackupParts = {
      settings: settings.tick.checked,
      relays: relays.tick.checked,
      apps: picked(apps),
      spaces: picked(spaces)
    }
    return backupEvent(ctx.theme.get(), name.value.trim() || "default", parts)
  }

  // A line (name, date) that opens to what the backup holds and what to do with it.
  function version(v: BackupVersion): Version {
    const el = document.createElement("details")
    el.className = "backup-row backup-version"
    const line = document.createElement("summary")
    const label = document.createElement("span")
    label.className = "ui-item-label backup-name"
    label.textContent = v.name
    const when = document.createElement("span")
    when.className = "backup-version-date"
    when.textContent = stamp(v.created_at)
    line.append(label, when)
    const body = document.createElement("div")
    body.className = "backup-version-body"
    const what = document.createElement("span")
    what.className = "backup-version-what"
    what.textContent = summarize(v.content)
    const controls = document.createElement("div")
    controls.className = "backup-version-actions"
    controls.append(
      button({ label: "view", variant: "outline", onClick: () => view(versionEvent(v)) }),
      button({ label: "restore", variant: "outline", disabled: true, title: "Not built yet" })
    )
    body.append(what, controls)
    el.append(line, body)
    return { el }
  }

  // Unsigned and not yet encrypted, so the content is the records themselves.
  function view(event: EventTemplate) {
    const pubkey = ctx.account.getPubkey()
    dispatchAction("settings", `view:${BACKUP_KIND}`, {
      ...event,
      ...(pubkey ? { pubkey } : {})
    }).catch(() => {})
  }

  // A name's versions together (names by their newest), newest first.
  function syncVersions() {
    const byName = new Map<string, BackupVersion[]>()
    for (const v of listBackups()) {
      const list = byName.get(v.name)
      if (list) list.push(v)
      else byName.set(v.name, [v])
    }
    const ordered = [...byName.values()].flat()
    const keys = ordered.map(v => `${v.created_at}\n${v.name}`)
    const keep = new Set(keys)
    for (const [key, r] of rows) {
      if (keep.has(key)) continue
      r.el.remove()
      rows.delete(key)
    }
    ordered.forEach((v, i) => {
      let r = rows.get(keys[i])
      if (!r) {
        r = version(v)
        rows.set(keys[i], r)
      }
      if (versions.children[i] !== r.el) versions.insertBefore(r.el, versions.children[i] ?? null)
    })
    versions.hidden = ordered.length === 0
    empty.hidden = ordered.length > 0
  }

  function part(label: string, on: boolean): Part {
    const el = document.createElement("div")
    el.className = "napp-perms-app share-app"
    const head = document.createElement("label")
    head.className = "share-head"
    const tick = check({ checked: on })
    const headEl = sectionHead({ title: label })
    head.append(tick, headEl)
    const list = document.createElement("div")
    list.className = "share-actions"
    list.classList.toggle("share-off", !on)
    tick.addEventListener("change", () => list.classList.toggle("share-off", !tick.checked))
    el.append(head, list)
    createBody.appendChild(el)
    return { el, tick, list, rows: new Map() }
  }

  function row(p: Part, key: string): Row {
    const row = document.createElement("div")
    row.className = "share-action"
    const head = document.createElement("label")
    head.className = "share-action-head"
    const tick = check({ checked: true })
    const name = document.createElement("span")
    name.className = "share-action-name"
    const note = document.createElement("span")
    note.className = "share-action-note"
    head.append(tick, name, note)
    row.appendChild(head)
    const r = { row, tick, name, note }
    p.rows.set(key, r)
    return r
  }

  // A row that goes with its section: ticked, not up to the user.
  function fixedRow(p: Part, label: string): Row {
    const r = row(p, label)
    r.tick.disabled = true
    r.name.textContent = label
    p.list.appendChild(r.row)
    return r
  }

  function picked(p: Part): Set<string> {
    const out = new Set<string>()
    if (!p.tick.checked) return out
    for (const [key, r] of p.rows) if (r.tick.checked && !r.tick.disabled) out.add(key)
    return out
  }

  // Keyed and in place: rows come and go, the rest stay as they are.
  function place(p: Part, keys: string[], fresh: (key: string) => Row) {
    const keep = new Set(keys)
    for (const [key, r] of p.rows) {
      if (keep.has(key)) continue
      r.row.remove()
      p.rows.delete(key)
    }
    keys.forEach((key, i) => {
      const r = p.rows.get(key) ?? fresh(key)
      if (p.list.children[i] !== r.row) p.list.insertBefore(r.row, p.list.children[i] ?? null)
    })
  }

  // Apps with no address (local, dev) are listed, unticked: nothing to reinstall from.
  const appNames = new Map<string, string>()
  function syncApps() {
    const list = ctx.apps.list()
    place(
      apps,
      list.map(a => a.nappId),
      key => row(apps, key)
    )
    for (const app of list) {
      const r = apps.rows.get(app.nappId)!
      const text = nappNameText(app.nappId)
      if (appNames.get(app.nappId) !== text) {
        appNames.set(app.nappId, text)
        r.name.replaceChildren(nappNameEl(app.nappId))
      }
      const addressable = !!addrFor(app)
      r.tick.disabled = !addressable
      if (!addressable) r.tick.checked = false
      r.note.textContent = addressable ? "" : "no address"
    }
  }

  function syncSpaces() {
    const current = persist.getCurrentSpaceId()
    const list = persist.listSpaces().filter(s => !s.ephemeral)
    place(
      spaces,
      list.map(s => s.id),
      key => row(spaces, key)
    )
    for (const s of list) {
      const r = spaces.rows.get(s.id)!
      if (r.name.textContent !== s.name) r.name.textContent = s.name
      r.note.textContent = s.id === current ? "current" : ""
    }
  }

  function syncSettings() {
    theme.note.textContent = ctx.theme.get()
  }

  function syncRelays() {
    auto.note.textContent = ctx.relayAuth.getAuto() ? "on" : "off"
    decisions.note.textContent = String(ctx.relayAuth.decisions().length)
  }

  syncVersions()
  syncApps()
  syncSpaces()
  syncSettings()
  syncRelays()
  el.addEventListener("toggle", () => {
    if (el.open) syncSpaces()
  })
  const unsubApps = ctx.apps.subscribe(syncApps)
  const unsubTheme = ctx.theme.subscribe(syncSettings)
  const unsubRelays = ctx.relayAuth.subscribe(syncRelays)

  return {
    el,
    unmount() {
      unsubApps()
      unsubTheme()
      unsubRelays()
    }
  }
}

// "2026-09-17 09:13", local time.
function stamp(seconds: number): string {
  const d = new Date(seconds * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
