// Backup: launcher state as a kind 30078 event, content NIP-44'd to self. One
// replaceable slot per name (d = nostrapps/backup/<name>): a new backup under a
// name replaces the last, and an empty one clears the slot, so nothing needs a
// delete. A relay only holds a name's latest, so every backup made here is also
// kept locally, where an older one can still be restored. The content is a list
// of records with imeta-style "key value" fields:
//
//   ["settings", "theme <choice>"]
//   ["relay-auth", "auto", "allow <url>", "deny <url>"]
//   ["app", "a <address>", "relay <url>", "petname <name>", "grant <domain>…",
//     "perm <method> <decision>", "size <w> [h]", "config <json>"]
//   ["space", "id <id>", "name <name>", "current", "pack", "saved-pack"]
//   ["window" | "saved", "space <id>", "a <address>" | "system <id>", "petname <name>",
//     "pos <l> <t> <w> [h]", "z <n>", "minimized", "pinned", "user-sized", "params <json>"]
//
// A bare key is a flag; with several values the last one takes the rest.
// Records stand alone: tag order only orders spaces, and windows within one.
// Apps and their environment, not content: a window's actions, napp storage and
// secret config stay out. So do local and dev apps, which have no address.
import { pool } from "@nostr/gadgets/global"
import type { EventTemplate } from "@nostr/tools/pure"
import * as persist from "./persistence.js"
import { listDecisions } from "./permissions.js"
import { automaticallyAuthOn, listRelayDecisions } from "./relay-auth.js"
import type { InstalledApp, NappWindowState } from "./types.js"

export const BACKUP_KIND = 30078
export const BACKUP_D_PREFIX = "nostrapps/backup/"

// What goes in: settings and relays whole, apps (nappIds) and spaces (ids) one
// by one. A window names its app by address, so a space can go in without it.
export interface BackupParts {
  settings: boolean
  relays: boolean
  apps: Set<string>
  spaces: Set<string>
}

// Replaceable and addressable manifests only: a regular event has no address.
export function addrFor(app: InstalledApp): string | null {
  const e = app.event
  if (!e) return null
  if (e.kind >= 30000 && e.kind < 40000) {
    return `${e.kind}:${e.pubkey}:${e.tags.find(t => t[0] === "d")?.[1] ?? ""}`
  }
  if (e.kind >= 10000 && e.kind < 20000) return `${e.kind}:${e.pubkey}:`
  return null
}

export function backupTags(theme: string, parts: BackupParts): string[][] {
  const tags: string[][] = []

  if (parts.settings) tags.push(["settings", `theme ${theme}`])

  if (parts.relays) {
    const auth = ["relay-auth"]
    if (automaticallyAuthOn()) auth.push("auto")
    for (const { url, decision } of listRelayDecisions()) auth.push(`${decision} ${url}`)
    tags.push(auth)
  }

  const decisions = listDecisions() as Record<string, Record<string, string>>
  const addrs = new Map<string, string>()
  for (const app of persist.getInstalledApps()) {
    const addr = addrFor(app)
    if (!addr) continue
    addrs.set(app.nappId, addr)
    if (!parts.apps.has(app.nappId)) continue

    const tag = ["app", `a ${addr}`]
    for (const r of pool.seenOn.get(app.event!.id) || []) tag.push(`relay ${r.url}`)
    if (app.petname) tag.push(`petname ${app.petname}`)
    const grants = persist.getPolicy(app.nappId).domains
    if (grants.length) tag.push(`grant ${grants.join(" ")}`)
    for (const [method, decision] of Object.entries(decisions[app.nappId] ?? {})) {
      tag.push(`perm ${method} ${decision}`)
    }
    const size = persist.getWindowSize(app.nappId)
    if (size) tag.push(["size", size.width, size.height].filter(v => v != null).join(" "))
    const config = configValues(app.nappId)
    if (config) tag.push(`config ${JSON.stringify(config)}`)
    tags.push(tag)
  }

  const current = persist.getCurrentSpaceId()
  for (const { id, name, ephemeral } of persist.listSpaces()) {
    if (ephemeral || !parts.spaces.has(id)) continue
    const saved = persist.getSpaceSaved(id)
    const space = ["space", `id ${id}`, `name ${name}`]
    if (id === current) space.push("current")
    if (persist.getSpacePackMode(id)) space.push("pack")
    if (saved.packMode) space.push("saved-pack")
    tags.push(space)
    for (const w of persist.getSpaceOpen(id)) {
      const t = windowTag("window", id, w, addrs)
      if (t) tags.push(t)
    }
    for (const w of saved.open) {
      const t = windowTag("saved", id, w, addrs)
      if (t) tags.push(t)
    }
  }

  return tags
}

export function backupEvent(theme: string, name: string, parts: BackupParts): EventTemplate {
  return {
    kind: BACKUP_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", BACKUP_D_PREFIX + name]],
    content: JSON.stringify(backupTags(theme, parts))
  }
}

// Stored values minus the ones the napp's schema marks secret.
function configValues(nappId: string): Record<string, unknown> | null {
  const { schema, values } = persist.getNappletConfig(nappId)
  const props = schema?.properties ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (props[k]?.["x-napplet-secret"] === true) continue
    out[k] = v
  }
  return Object.keys(out).length ? out : null
}

function windowTag(
  name: "window" | "saved",
  spaceId: string,
  w: NappWindowState,
  addrs: Map<string, string>
): string[] | null {
  let app: string
  if (w.system) {
    if (!w.systemId) return null
    app = `system ${w.systemId}`
  } else {
    const addr = addrs.get(w.nappId)
    if (!addr) return null
    app = `a ${addr}`
  }

  const tag = [name, `space ${spaceId}`, app]
  if (w.petname) tag.push(`petname ${w.petname}`)
  const p = w.position
  if (p) tag.push(["pos", p.left, p.top, p.width, p.height].filter(v => v != null).join(" "))
  const s = w.status
  if (s?.zIndex) tag.push(`z ${s.zIndex}`)
  if (s?.minimized) tag.push("minimized")
  if (s?.pinned) tag.push("pinned")
  if (s?.userSized) tag.push("user-sized")
  if (w.params != null) tag.push(`params ${JSON.stringify(w.params)}`)
  return tag
}

// ─── local versions ─────────────────────────────────────────────

const HISTORY_KEY = "nostrapps:backups"
// Per name. The relay has the newest anyway; this is how far back you can go.
const KEEP = 10

export interface BackupVersion {
  name: string
  created_at: number
  content: string
}

// Newest first.
export function listBackups(): BackupVersion[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        v =>
          v &&
          typeof v.name === "string" &&
          typeof v.created_at === "number" &&
          typeof v.content === "string"
      )
      .sort((a, b) => b.created_at - a.created_at)
  } catch {
    return []
  }
}

// Stamped past the name's newest, so it always lands on top (and would replace
// it on a relay, which keeps the later created_at).
export function saveBackup(event: EventTemplate): BackupVersion {
  const name = (event.tags.find(t => t[0] === "d")?.[1] ?? "").slice(BACKUP_D_PREFIX.length)
  const all = listBackups()
  const newest = all.find(v => v.name === name)
  const version = {
    name,
    created_at: Math.max(event.created_at, (newest?.created_at ?? 0) + 1),
    content: event.content
  }
  let n = 0
  const kept = [version, ...all].filter(v => v.name !== name || ++n <= KEEP)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(kept))
  return version
}

export function versionEvent(v: BackupVersion): EventTemplate {
  return {
    kind: BACKUP_KIND,
    created_at: v.created_at,
    tags: [["d", BACKUP_D_PREFIX + v.name]],
    content: v.content
  }
}

// What a version holds, in a line: "4 apps · 2 spaces · settings · relays".
export function summarize(content: string): string {
  let records: string[][] = []
  try {
    records = JSON.parse(content)
  } catch {}
  const count = (name: string) => records.filter(r => r[0] === name).length
  const out: string[] = []
  const apps = count("app")
  const spaces = count("space")
  if (apps) out.push(`${apps} app${apps === 1 ? "" : "s"}`)
  if (spaces) out.push(`${spaces} space${spaces === 1 ? "" : "s"}`)
  if (count("settings")) out.push("settings")
  if (count("relay-auth")) out.push("relays")
  return out.join(" · ") || "empty"
}
