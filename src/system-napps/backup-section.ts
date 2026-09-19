// Settings' backups section, in the share screen's parts, as one list: "new
// backup" first, a line that opens to the name with save beside it and what
// can go in (apps, spaces, settings, relays), each a ticked section with its
// items below. Then the backups made here, a line each (name and date) that
// opens to where it stands, what to do with it (view it as a view:<kind>
// action, publish it if it isn't, restore it) and what went in, laid out like
// the form without its ticks. Apps and spaces are picked one by one;
// settings and relays go whole, their rows only say what that means. Save
// keeps the version here, then publishes it.
import type { EventTemplate } from "@nostr/tools/pure"
import type { NostrEvent } from "@nostr/tools/core"
import type { SystemCtx } from "../types.js"
import * as persist from "../persistence.js"
import { dispatchAction } from "../handlers.js"
import {
  addrFor,
  BACKUP_KIND,
  backupEvent,
  fetchPublished,
  everything,
  importPublished,
  listBackups,
  nameOf,
  nappIdOf,
  parseBackup,
  publishBackup,
  restoreBackup,
  saveBackup,
  versionEvent,
  type BackupParts,
  type BackupVersion,
  type ParsedBackup
} from "../backup.js"
import { openDialog } from "../dialog.js"
import { nameEl, nappNameEl, nappNameText } from "../napp-name.js"
import { requireAccount } from "../login.js"
import { sectionHead } from "../napp-permissions.js"
import { button, check, details, input, row as openRow, rowList } from "./ui.js"

type Row = { row: HTMLElement; tick: HTMLInputElement; name: HTMLElement; note: HTMLElement }
type Part = { el: HTMLElement; tick: HTMLInputElement; list: HTMLElement; rows: Map<string, Row> }
// A line in the backups list: a version kept here, or one only on the relays
// (no publish button; opening it brings it here).
type Version = { el: HTMLDetailsElement; status: HTMLElement; publish?: HTMLButtonElement }

export function backupSection(ctx: SystemCtx): { el: HTMLDetailsElement; unmount(): void } {
  const el = details({ summary: "backups", class: "settings-backup" })
  const wrap = document.createElement("div")
  wrap.className = "napp-perms"
  el.appendChild(wrap)

  // One list: the new backup first, then the ones already made. Whichever is
  // open has the list to itself.
  const backups = rowList()
  const create = openRow(backups, "new backup")
  const createBody = document.createElement("div")
  createBody.className = "napp-perms backup-body"
  create.appendChild(createBody)
  const empty = document.createElement("div")
  empty.className = "perm-empty"
  empty.textContent = "no backups found"
  backups.append(create, empty)
  wrap.appendChild(backups)
  const rows = new Map<string, Version>()
  // Backups on the relays that aren't kept here: after erasing everything,
  // or published from another device. The newest per name.
  const remote = new Map<string, NostrEvent>()

  // The name, and save: the name is the slot a backup replaces.
  const title = document.createElement("div")
  title.className = "share-title-row backup-new"
  const name = input({ placeholder: "default", spellcheck: false, class: "backup-name" })
  name.setAttribute("aria-label", "backup name")
  const save = button({
    label: "save",
    variant: "primary",
    onClick: () => {
      const saved = saveBackup(composed())
      syncVersions()
      // The saved one opens, which closes this one, and says how its
      // publishing goes.
      const r = rows.get(versionKey(saved))
      if (r) r.el.open = true
      void publish(saved)
    }
  })
  title.append(name, save)
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
    const label = document.createElement("span")
    label.className = "ui-item-label backup-name"
    label.textContent = v.name
    const when = document.createElement("span")
    when.className = "backup-version-date"
    when.textContent = stamp(v.created_at)
    const el = openRow(backups, label, when)
    el.classList.add("backup-version")
    const body = document.createElement("div")
    body.className = "napp-perms backup-body"
    // Where it stands and what to do with it, on the line the new backup's
    // name and save take; then what went in.
    const head = document.createElement("div")
    head.className = "backup-version-head"
    const status = document.createElement("span")
    status.className = "backup-version-status"
    const controls = document.createElement("div")
    controls.className = "backup-version-actions"
    const pub = button({ label: "publish", variant: "outline", onClick: () => void publish(v) })
    controls.append(
      button({ label: "view", variant: "outline", onClick: () => view(versionEvent(v)) }),
      pub,
      button({ label: "restore", variant: "outline", onClick: () => void restore(v) })
    )
    head.append(status, controls)
    body.append(head, ...saved(v))
    el.appendChild(body)
    return { el, status, publish: pub }
  }

  // What a version holds, in the form's parts minus the ticks: nothing here
  // can change.
  function saved(v: BackupVersion): HTMLElement[] {
    const c = parseBackup(v.content)
    const out: HTMLElement[] = []
    if (c.apps.length) {
      out.push(
        savedPart(
          "apps",
          c.apps.map(a => {
            const [, pubkey, ...d] = a.addr.split(":")
            const el = nameEl(a.petname || d.join(":") || "site", pubkey)
            el.title = a.addr
            return { name: el }
          })
        )
      )
    }
    if (c.spaces.length) {
      out.push(
        savedPart(
          "spaces",
          c.spaces.map(s => ({ name: s.name, note: s.current ? "current" : "" }))
        )
      )
    }
    if (c.theme != null) out.push(savedPart("settings", [{ name: "theme", note: c.theme }]))
    if (c.relayAuth) {
      out.push(
        savedPart("relays", [
          { name: "always authenticate", note: c.relayAuth.auto ? "on" : "off" },
          { name: "per-relay decisions", note: String(c.relayAuth.decisions.length) }
        ])
      )
    }
    return out
  }

  function savedPart(label: string, items: Array<{ name: string | Node; note?: string }>) {
    const el = document.createElement("div")
    el.className = "napp-perms-app share-app backup-saved"
    const head = document.createElement("div")
    head.className = "share-head"
    head.append(sectionHead({ title: label }))
    const list = document.createElement("div")
    list.className = "share-actions"
    for (const item of items) {
      const row = document.createElement("div")
      row.className = "share-action"
      const line = document.createElement("div")
      line.className = "share-action-head"
      const name = document.createElement("span")
      name.className = "share-action-name"
      name.append(item.name)
      const note = document.createElement("span")
      note.className = "share-action-note"
      note.textContent = item.note ?? ""
      line.append(name, note)
      row.appendChild(line)
      list.appendChild(row)
    }
    el.append(head, list)
    return el
  }

  // Encrypted to self, signed, sent to the write relays; the row says how it
  // goes and the log has the relays that didn't take it.
  const publishing = new Set<string>()
  async function publish(v: BackupVersion) {
    const key = versionKey(v)
    if (publishing.has(key)) return
    const say = (text: string) => {
      const r = rows.get(key)
      if (r) r.status.textContent = text
    }
    const pubkey = await requireAccount({ nappId: "__settings__", what: "publish a backup" })
    if (!pubkey) {
      say("not published: no key to sign with")
      return
    }
    publishing.add(key)
    const btn = rows.get(key)?.publish
    if (btn) btn.disabled = true
    try {
      const outcomes = await publishBackup(v, pubkey, say)
      const missing = outcomes.filter(o => !o.ok)
      // Done: the row goes back to saying where the version stands, and an
      // older one of its name seen on the relays is replaced there now.
      publishing.delete(key)
      if (outcomes.some(o => o.ok)) {
        for (const [k, e] of remote) {
          if (nameOf(e) === v.name && e.created_at < v.created_at) remote.delete(k)
        }
      }
      syncVersions()
      if (missing.length === outcomes.length) {
        say(`not published: ${missing[0]?.reason || "no relay took it"}`)
      }
      ctx.setStatus(
        missing.length
          ? `Backup "${v.name}" published to ${outcomes.length - missing.length}/${outcomes.length} relays, missing: ${missing.map(o => `${o.relay} (${o.reason || "failed"})`).join(", ")}`
          : `Backup "${v.name}" published to all ${outcomes.length} relays`
      )
    } catch (err: any) {
      say(`not published: ${err?.message || err}`)
    } finally {
      publishing.delete(key)
      if (btn) btn.disabled = false
    }
  }

  // Where a version stands: on relays, replaced there by a newer one of its
  // name (a relay keeps only the latest), or only here.
  function standing(v: BackupVersion, newestOnRelays: number): string {
    if (!v.published) return "saved here only"
    if (newestOnRelays > v.created_at) return "replaced on relays by a newer one"
    const n = v.published.relays.length
    return `published to ${n} relay${n === 1 ? "" : "s"}`
  }

  // One only on the relays: opening it decrypts it and keeps it here, where
  // it then shows like any other.
  function relayRow(e: NostrEvent): Version {
    const label = document.createElement("span")
    label.className = "ui-item-label backup-name"
    label.textContent = nameOf(e)
    const when = document.createElement("span")
    when.className = "backup-version-date"
    when.textContent = stamp(e.created_at)
    const el = openRow(backups, label, when)
    el.classList.add("backup-version")
    const body = document.createElement("div")
    body.className = "napp-perms backup-body"
    const head = document.createElement("div")
    head.className = "backup-version-head"
    const status = document.createElement("span")
    status.className = "backup-version-status"
    status.textContent = "on relays, not kept here"
    head.appendChild(status)
    body.appendChild(head)
    el.appendChild(body)
    let busy = false
    el.addEventListener("toggle", async () => {
      const pubkey = ctx.account.getPubkey()
      if (!el.open || busy || !pubkey) return
      busy = true
      status.textContent = "decrypting…"
      try {
        const v = await importPublished(e, pubkey)
        remote.delete(relayKey(e))
        syncVersions()
        const r = rows.get(versionKey(v))
        if (r) r.el.open = true
      } catch (err: any) {
        status.textContent = `couldn't decrypt: ${err?.message || err}`
      } finally {
        busy = false
      }
    })
    return { el, status }
  }

  // What the relays have that isn't here. Asked on mount and on every login.
  let loads = 0
  async function loadPublished() {
    const pubkey = ctx.account.getPubkey()
    const load = ++loads
    remote.clear()
    syncVersions()
    if (!pubkey) return
    try {
      const events = await fetchPublished(pubkey)
      if (load !== loads) return
      const kept = listBackups()
      for (const e of events) {
        const here = kept.some(
          v => v.published?.id === e.id || (v.name === nameOf(e) && v.created_at === e.created_at)
        )
        if (!here) remote.set(relayKey(e), e)
      }
      syncVersions()
    } catch (err: any) {
      ctx.setStatus(`Couldn't look for published backups: ${err?.message || err}`)
    }
  }

  // Confirmed first; the current setup kept as "before restore"; then the
  // backup put in place and the launcher reloaded into it.
  let restoring = false
  async function restore(v: BackupVersion) {
    if (restoring) return
    const ok = await openDialog<boolean>({
      title: "Restore backup",
      body: restoreSummary(v, parseBackup(v.content)),
      actions: [
        { label: "cancel", value: false, variant: "outline" },
        { label: "restore", value: true, variant: "primary", autofocus: true }
      ],
      dismissValue: false
    })
    if (!ok) return
    restoring = true
    const key = versionKey(v)
    const say = (text: string) => {
      const r = rows.get(key)
      if (r) r.status.textContent = text
    }
    try {
      say("keeping the current setup…")
      saveBackup(backupEvent(ctx.theme.get(), BEFORE_RESTORE, everything()))
      const { failed, finish } = await restoreBackup(v.content, {
        install: naddr => ctx.install(naddr, { launch: false }),
        setTheme: choice => ctx.theme.set(choice),
        onStep: say
      })
      if (failed.length) {
        await openDialog<boolean>({
          title: "Restored, apart from",
          body: failures(failed),
          actions: [{ label: "reload", value: true, variant: "primary", autofocus: true }],
          dismissValue: true
        })
      }
      finish()
      location.reload()
    } catch (err: any) {
      say(`restore failed: ${err?.message || err}`)
      restoring = false
    }
  }

  function restoreSummary(v: BackupVersion, b: ParsedBackup): HTMLElement {
    const wrap = document.createElement("div")
    const line = (...parts: Array<string | Node>) => {
      const p = document.createElement("p")
      p.append(...parts)
      wrap.appendChild(p)
    }
    const name = document.createElement("span")
    name.className = "backup-name"
    name.textContent = v.name
    line("Restore ", name, ` from ${stamp(v.created_at)}?`)
    if (b.apps.length) {
      const missing = b.apps.filter(a => !ctx.isInstalled(nappIdOf(a.addr))).length
      line(
        `${count(b.apps.length, "app")}, ${missing ? `${missing} to install` : "all installed here"}, with their grants, permissions and settings.`
      )
    }
    if (b.spaces.length) line(`Your spaces are replaced by its ${count(b.spaces.length, "space")}.`)
    if (b.theme) line(`Theme: ${b.theme}.`)
    if (b.relayAuth) {
      line(
        `Relays: always authenticate ${b.relayAuth.auto ? "on" : "off"}, ${count(b.relayAuth.decisions.length, "per-relay decision")}.`
      )
    }
    line(
      `The current setup is kept first, as the backup "${BEFORE_RESTORE}". The launcher reloads when it's done.`
    )
    return wrap
  }

  function failures(failed: Array<{ name: string; reason: string }>): HTMLElement {
    const wrap = document.createElement("div")
    const p = document.createElement("p")
    p.textContent = "These apps couldn't be installed, so their windows are left out:"
    wrap.appendChild(p)
    for (const f of failed) {
      const line = document.createElement("p")
      line.textContent = `${f.name}: ${f.reason}`
      wrap.appendChild(line)
    }
    const again = document.createElement("p")
    again.textContent = "Restoring the same backup again retries just these."
    wrap.appendChild(again)
    return wrap
  }

  // Unsigned and not yet encrypted, so the content is the records themselves.
  function view(event: EventTemplate) {
    const pubkey = ctx.account.getPubkey()
    dispatchAction("settings", `view:${BACKUP_KIND}`, {
      ...event,
      ...(pubkey ? { pubkey } : {})
    }).catch(() => {})
  }

  // Kept versions and the relays' own, a name's together (names by their
  // newest), newest first.
  function syncVersions() {
    type Line = { key: string; name: string; at: number; v?: BackupVersion; e?: NostrEvent }
    const lines: Line[] = [
      ...listBackups().map(v => ({ key: versionKey(v), name: v.name, at: v.created_at, v })),
      ...[...remote.values()].map(e => ({
        key: relayKey(e),
        name: nameOf(e),
        at: e.created_at,
        e
      }))
    ].sort((a, b) => b.at - a.at)
    const byName = new Map<string, Line[]>()
    for (const line of lines) {
      const named = byName.get(line.name)
      if (named) named.push(line)
      else byName.set(line.name, [line])
    }
    const ordered = [...byName.values()].flat()
    const keep = new Set(ordered.map(line => line.key))
    for (const [key, r] of rows) {
      if (keep.has(key)) continue
      r.el.remove()
      rows.delete(key)
    }
    ordered.forEach((line, i) => {
      let r = rows.get(line.key)
      if (!r) {
        r = line.v ? version(line.v) : relayRow(line.e!)
        rows.set(line.key, r)
      }
      // After "new backup", before the empty line.
      const at = backups.children[i + 1]
      if (at !== r.el) backups.insertBefore(r.el, at ?? null)
      if (!line.v) return
      if (!publishing.has(line.key)) {
        const onRelays = byName.get(line.name)!.filter(x => x.e || x.v?.published)
        r.status.textContent = standing(line.v, Math.max(0, ...onRelays.map(x => x.at)))
      }
      if (r.publish) r.publish.hidden = !!line.v.published
    })
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
  void loadPublished()
  const unsubAccount = ctx.account.subscribe(() => void loadPublished())

  return {
    el,
    unmount() {
      unsubApps()
      unsubTheme()
      unsubRelays()
      unsubAccount()
    }
  }
}

// "2026-09-17 09:13", local time.
function stamp(seconds: number): string {
  const d = new Date(seconds * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

// The backup a restore keeps of what was there before it.
const BEFORE_RESTORE = "before restore"

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function versionKey(v: BackupVersion): string {
  return `${v.created_at}\n${v.name}`
}

function relayKey(e: NostrEvent): string {
  return `relay\n${e.created_at}\n${nameOf(e)}`
}
