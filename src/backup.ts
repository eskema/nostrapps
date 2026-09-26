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
//     "perm <method> <decision>", "size <w> [h]", "config <key> <value>"]
//   ["space", "id <id>", "name <name>", "current", "pack", "saved-pack"]
//   ["window" | "saved", "space <id>", "a <address>" | "system <id>", "petname <name>",
//     "pos <l> <t> <w> [h]", "stage <w> <h>", "z <n>", "minimized", "pinned",
//     "user-sized", "param <key> <value>"]
//
// A bare key is a flag; with several values the last one takes the rest. A
// config field per setting (the form only holds plain values), a param field
// per list item (the apps napp's discover relays). A window's pos is pixels on
// a stage of that size, and scales to the one it's restored on.
// Records stand alone: tag order only orders spaces, and windows within one.
// Apps and their environment, not content: a window's actions, napp storage and
// secret config stay out. So do local and dev apps, which have no address.
import { pool } from "@nostr/gadgets/global"
import { loadRelayList } from "@nostr/gadgets/lists"
import type { EventTemplate } from "@nostr/tools/pure"
import type { NostrEvent } from "@nostr/tools/core"
import { naddrEncode } from "@nostr/tools/nip19"
import * as persist from "./persistence.js"
import { clearDecisions, listDecisions, setDecision } from "./permissions.js"
import {
  automaticallyAuthOn,
  forgetAllRelayDecisions,
  listRelayDecisions,
  onRelayAuth,
  rememberRelayDecision,
  setAutomaticallyAuth
} from "./relay-auth.js"
import { currentSigner } from "./signers/index.js"
import { FALLBACK_RELAYS } from "./outbox.js"
import { publishOutcomes } from "./utils.js"
import type { InstalledApp, NappWindowState, SpaceData } from "./types.js"

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
    for (const [key, value] of Object.entries(configValues(app.nappId))) {
      tag.push(`config ${key} ${value}`)
    }
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

// Stored values minus the ones the napp's schema marks secret, as text.
function configValues(nappId: string): Record<string, string> {
  const { schema, values } = persist.getNappletConfig(nappId)
  const props = schema?.properties ?? {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    if (props[k]?.["x-napplet-secret"] === true) continue
    if (v == null || typeof v === "object") continue
    out[k] = String(v)
  }
  return out
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
  if (p?.stage) tag.push(`stage ${p.stage.width} ${p.stage.height}`)
  const s = w.status
  if (s?.zIndex) tag.push(`z ${s.zIndex}`)
  if (s?.minimized) tag.push("minimized")
  if (s?.pinned) tag.push("pinned")
  if (s?.userSized) tag.push("user-sized")
  const params =
    w.params && typeof w.params === "object" && !Array.isArray(w.params) ? w.params : {}
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item != null && typeof item !== "object") tag.push(`param ${key} ${item}`)
    }
  }
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
  // Once a relay took it: the signed event's id, and the relays that did.
  published?: { id: string; relays: string[] }
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
  const name = nameOf(event)
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

// A backup event's name: its d tag past the prefix.
export function nameOf(event: { tags: string[][] }): string {
  return (event.tags.find(t => t[0] === "d")?.[1] ?? "").slice(BACKUP_D_PREFIX.length)
}

export function versionEvent(v: BackupVersion): EventTemplate {
  return {
    kind: BACKUP_KIND,
    created_at: v.created_at,
    tags: [["d", BACKUP_D_PREFIX + v.name]],
    content: v.content
  }
}

// A version's content read back. Null theme or relayAuth: that part didn't go
// in.
export interface ParsedBackup {
  theme: string | null
  relayAuth: { auto: boolean; decisions: Array<{ url: string; allow: boolean }> } | null
  apps: ParsedApp[]
  spaces: ParsedSpace[]
}

export interface ParsedApp {
  addr: string
  relays: string[]
  petname: string | null
  grants: string[]
  perms: Array<{ method: string; decision: string }>
  size: { width: number; height?: number } | null
  config: Record<string, string>
}

export interface ParsedSpace {
  id: string
  name: string
  current: boolean
  pack: boolean
  savedPack: boolean
  open: ParsedWindow[]
  saved: ParsedWindow[]
}

export interface ParsedWindow {
  addr: string | null
  system: string | null
  petname: string | null
  pos: number[] | null
  stage: number[] | null
  z: number
  minimized: boolean
  pinned: boolean
  userSized: boolean
  params: Record<string, string[]>
}

export function parseBackup(content: string): ParsedBackup {
  let records: unknown = []
  try {
    records = JSON.parse(content)
  } catch {}
  const out: ParsedBackup = { theme: null, relayAuth: null, apps: [], spaces: [] }
  if (!Array.isArray(records)) return out
  const windows: Array<{ space: string; saved: boolean; w: ParsedWindow }> = []
  for (const r of records) {
    if (!Array.isArray(r)) continue
    const f = fields(r)
    const one = (key: string) => f.get(key)?.[0] ?? null
    const all = (key: string) => f.get(key) ?? []
    if (r[0] === "settings") out.theme = one("theme") ?? ""
    else if (r[0] === "relay-auth") {
      out.relayAuth = {
        auto: f.has("auto"),
        decisions: [
          ...all("allow").map(url => ({ url, allow: true })),
          ...all("deny").map(url => ({ url, allow: false }))
        ]
      }
    } else if (r[0] === "app") {
      const addr = one("a")
      if (!addr) continue
      const size = numbers(one("size"))
      out.apps.push({
        addr,
        relays: all("relay"),
        petname: one("petname"),
        grants: all("grant").flatMap(g => g.split(" ").filter(Boolean)),
        perms: all("perm").map(p => {
          const [method, decision] = pair(p)
          return { method, decision }
        }),
        size: size?.[0] ? { width: size[0], ...(size[1] ? { height: size[1] } : {}) } : null,
        config: Object.fromEntries(all("config").map(pair))
      })
    } else if (r[0] === "space") {
      out.spaces.push({
        id: one("id") ?? "",
        name: one("name") ?? "",
        current: f.has("current"),
        pack: f.has("pack"),
        savedPack: f.has("saved-pack"),
        open: [],
        saved: []
      })
    } else if (r[0] === "window" || r[0] === "saved") {
      const params: Record<string, string[]> = {}
      for (const [key, value] of all("param").map(pair)) (params[key] ??= []).push(value)
      windows.push({
        space: one("space") ?? "",
        saved: r[0] === "saved",
        w: {
          addr: one("a"),
          system: one("system"),
          petname: one("petname"),
          pos: numbers(one("pos")),
          stage: numbers(one("stage")),
          z: Number(one("z")) || 0,
          minimized: f.has("minimized"),
          pinned: f.has("pinned"),
          userSized: f.has("user-sized"),
          params
        }
      })
    }
  }
  // Windows name their space; spaces can come in any order.
  for (const { space, saved, w } of windows) {
    const sp = out.spaces.find(s => s.id === space)
    if (sp) (saved ? sp.saved : sp.open).push(w)
  }
  return out
}

// "key value" → [key, value].
function pair(field: string): [string, string] {
  const i = field.indexOf(" ")
  return i < 0 ? [field, ""] : [field.slice(0, i), field.slice(i + 1)]
}

function numbers(field: string | null): number[] | null {
  if (!field) return null
  const n = field.split(" ").map(Number)
  return n.every(Number.isFinite) ? n : null
}

// A record's fields, key → its values in order ("" for a flag).
function fields(record: unknown[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const field of record.slice(1)) {
    if (typeof field !== "string") continue
    const i = field.indexOf(" ")
    const key = i < 0 ? field : field.slice(0, i)
    const value = i < 0 ? "" : field.slice(i + 1)
    const list = out.get(key)
    if (list) list.push(value)
    else out.set(key, [value])
  }
  return out
}

// ─── publishing ─────────────────────────────────────────────────

// Encrypt a saved version to self, sign it, and send it to the account's
// write relays (its NIP-65 list, the defaults when it has none). The relays
// that took it are recorded on the version.
export async function publishBackup(
  v: BackupVersion,
  pubkey: string,
  onStep?: (step: string) => void
): Promise<Array<{ relay: string; ok: boolean; reason: string }>> {
  const signer = currentSigner()
  onStep?.("encrypting…")
  const content = await signer.nip44.encrypt(pubkey, v.content)
  onStep?.("signing…")
  const signed = await signer.signEvent({ ...versionEvent(v), content })
  onStep?.("publishing…")
  const relays = await writeRelays(pubkey)
  const outcomes = await publishOutcomes(
    relays,
    pool.publish(relays, signed, { onauth: onRelayAuth })
  )
  const took = outcomes.filter(o => o.ok).map(o => o.relay)
  if (took.length) markPublished(v, { id: signed.id, relays: took })
  return outcomes
}

async function writeRelays(pubkey: string): Promise<string[]> {
  try {
    const listed = (await loadRelayList(pubkey)).items.filter(i => i.write).map(i => i.url)
    if (listed.length) return listed
  } catch {}
  return FALLBACK_RELAYS
}

function markPublished(v: BackupVersion, published: { id: string; relays: string[] }) {
  const all = listBackups()
  const i = all.findIndex(x => x.name === v.name && x.created_at === v.created_at)
  if (i < 0) return
  all[i] = { ...all[i], published }
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all))
}

// ─── published backups ──────────────────────────────────────────

// The account's backups on its write relays, where they're published: the
// newest per name, cleared slots (empty content) left out.
export async function fetchPublished(pubkey: string): Promise<NostrEvent[]> {
  const relays = await writeRelays(pubkey)
  const events = await pool.querySync(
    relays,
    { kinds: [BACKUP_KIND], authors: [pubkey] },
    { maxWait: 4000 }
  )
  const newest = new Map<string, NostrEvent>()
  for (const e of events) {
    const d = e.tags.find(t => t[0] === "d")?.[1] ?? ""
    if (!d.startsWith(BACKUP_D_PREFIX) || !e.content) continue
    const seen = newest.get(d)
    if (!seen || e.created_at > seen.created_at) newest.set(d, e)
  }
  return [...newest.values()]
}

// Decrypt a published backup and keep it here as a version, published on the
// relays it was found on.
export async function importPublished(event: NostrEvent, pubkey: string): Promise<BackupVersion> {
  const content = await currentSigner().nip44.decrypt(pubkey, event.content)
  const version: BackupVersion = {
    name: nameOf(event),
    created_at: event.created_at,
    content,
    published: {
      id: event.id,
      relays: Array.from(pool.seenOn.get(event.id) || []).map(r => r.url)
    }
  }
  const others = listBackups().filter(
    v => !(v.name === version.name && v.created_at === version.created_at)
  )
  let n = 0
  const kept = [version, ...others]
    .sort((a, b) => b.created_at - a.created_at)
    .filter(v => v.name !== version.name || ++n <= KEEP)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(kept))
  return version
}

// ─── restoring ──────────────────────────────────────────────────

// A backup of all there is: what "before restore" keeps.
export function everything(): BackupParts {
  return {
    settings: true,
    relays: true,
    apps: new Set(
      persist
        .getInstalledApps()
        .filter(a => addrFor(a))
        .map(a => a.nappId)
    ),
    spaces: new Set(
      persist
        .listSpaces()
        .filter(s => !s.ephemeral)
        .map(s => s.id)
    )
  }
}

export interface RestoreIO {
  // Install from an naddr without opening a window; resolves to the nappId.
  install(naddr: string): Promise<string>
  setTheme(choice: string): void
  onStep?(text: string): void
}

// Put a backup in place: settings and relays whole, its apps installed and set
// up the way they were. Never uninstalls, and an installed app is only set up
// again, so a second run retries just what failed. Resolves to the apps that
// didn't install, and finish(), which swaps the spaces for the backup's own
// (without those apps' windows): call it right before reloading, so nothing
// live writes over the new document in between.
export async function restoreBackup(
  content: string,
  io: RestoreIO
): Promise<{ failed: Array<{ name: string; reason: string }>; finish(): void }> {
  const b = parseBackup(content)
  const failed: Array<{ name: string; reason: string }> = []

  if (b.theme) io.setTheme(b.theme)
  if (b.relayAuth) {
    setAutomaticallyAuth(b.relayAuth.auto)
    forgetAllRelayDecisions()
    for (const d of b.relayAuth.decisions) rememberRelayDecision(d.url, d.allow)
  }

  for (const [i, a] of b.apps.entries()) {
    const { kind, pubkey, d } = splitAddr(a.addr)
    const nappId = nappIdOf(a.addr)
    const name = a.petname || d || "app"
    // The grant first: an install that finds one stored skips its permission
    // screen.
    persist.setPolicy(nappId, { domains: a.grants })
    if (!persist.getInstalledApp(nappId)) {
      io.onStep?.(`installing ${name} (${i + 1}/${b.apps.length})…`)
      try {
        await io.install(naddrEncode({ kind, pubkey, identifier: d, relays: a.relays }))
      } catch (err: any) {
        failed.push({ name, reason: err?.message || String(err) })
        continue
      }
    }
    if (a.petname) persist.setInstalledPetname(nappId, a.petname)
    clearDecisions(nappId)
    for (const p of a.perms) setDecision(nappId, p.method, p.decision)
    if (a.size) persist.rememberWindowSize(nappId, a.size.width, a.size.height)
    if (Object.keys(a.config).length) {
      // Merged: secret values never went in, so the ones kept here stay.
      const { schema, values } = persist.getNappletConfig(nappId)
      persist.setNappletConfigValues(nappId, {
        ...values,
        ...persist.coerceConfigValues(schema, a.config)
      })
    }
  }

  const finish = () => {
    if (!b.spaces.length) return
    let serial = 1
    const place = (w: ParsedWindow): NappWindowState | null => {
      const [left, top, width, height] = w.pos ?? []
      const [sw, sh] = w.stage ?? []
      const stage = sw > 0 && sh > 0 ? { stage: { width: sw, height: sh } } : {}
      const common = {
        status: { minimized: w.minimized, pinned: w.pinned, userSized: w.userSized, zIndex: w.z },
        ...(w.pos && w.pos.length >= 3
          ? { position: { left, top, width, ...(height ? { height } : {}), ...stage } }
          : {}),
        ...(Object.keys(w.params).length ? { params: w.params } : {})
      }
      if (w.system) {
        return {
          nappId: `__${w.system}__`,
          instanceId: `system:${w.system}`,
          petname: w.petname || w.system,
          system: true,
          systemId: w.system,
          ...common
        }
      }
      const app = w.addr ? persist.getInstalledApp(nappIdOf(w.addr)) : undefined
      if (!app) return null
      return {
        nappId: app.nappId,
        instanceId: app.singleton ? app.nappId : String(serial++),
        petname: w.petname || app.petname,
        ...common
      }
    }
    const placed = (ws: ParsedWindow[]) => ws.map(place).filter((w): w is NappWindowState => !!w)
    const list: SpaceData[] = b.spaces.map(s => ({
      id: s.id,
      name: s.name,
      open: placed(s.open),
      saved: placed(s.saved),
      packMode: s.pack,
      savedPackMode: s.savedPack
    }))
    persist.replaceSpaces({ current: (b.spaces.find(s => s.current) ?? b.spaces[0]).id, list })
  }
  return { failed, finish }
}

function splitAddr(addr: string): { kind: number; pubkey: string; d: string } {
  const [kind, pubkey = "", ...d] = addr.split(":")
  return { kind: Number(kind), pubkey, d: d.join(":") }
}

// The nappId an address installs as.
export function nappIdOf(addr: string): string {
  const { kind, pubkey, d } = splitAddr(addr)
  return persist.computeNappId({ kind, pubkey, tags: d ? [["d", d]] : [] })
}
