// Space share links. Everything sits after `#` (the fragment never reaches the
// host) as plain key=value pairs in the same readable form the launcher input
// takes, so a link can be typed by hand and survives every linkifier:
//
//   #space=<slug>&app=<naddr|nsite host>&action=<name>~<payload>&app=…
//
// Order is the layout (an equal grid, reading order); each `action` goes to the
// `app` before it. No spaces, no JSON, no `>`: `~` separates name from payload
// (unreserved, and no action name has one), lists are comma-separated.
import { decode, neventEncode, npubEncode } from "@nostr/tools/nip19"

export type LinkAction = { name: string; payload: string }
export type LinkWindow = { input: string; actions: LinkAction[] }
export type ShareLink = { name: string; windows: LinkWindow[] }

export const DEFAULT_SPACE_NAME = "shared"
const SLUG = /^[a-z0-9-]{1,32}$/
const ACTION_NAME = /^[a-z0-9:_-]+$/i
// What a payload may carry and still paste anywhere: unreserved chars plus
// `:`, `/` and `,` (relay urls, lists). No `&`/`=` (structure), no `+` (reads
// as a space), nothing that needs percent-encoding.
const SAFE = /^[A-Za-z0-9._~:/,-]*$/
// Actions whose payload is a list of strings.
const LIST_ACTIONS = new Set(["feed", "relay"])
const HEX64 = /^[0-9a-f]{64}$/i

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  return SLUG.test(s) ? s : DEFAULT_SPACE_NAME
}

// Tolerant: unknown keys are ignored, an `action` before any `app` is dropped,
// a name that isn't a slug falls back to the default. Null when there's no app.
export function parseShareLink(hash: string): ShareLink | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (!raw) return null
  let name = DEFAULT_SPACE_NAME
  const windows: LinkWindow[] = []
  for (const [key, value] of new URLSearchParams(raw)) {
    if (key === "space") {
      if (SLUG.test(value)) name = value
    } else if (key === "app") {
      const input = value.trim()
      if (input) windows.push({ input, actions: [] })
    } else if (key === "action") {
      const win = windows[windows.length - 1]
      if (!win) continue
      const i = value.indexOf("~")
      const nm = (i === -1 ? value : value.slice(0, i)).trim()
      if (!ACTION_NAME.test(nm)) continue
      win.actions.push({ name: nm, payload: i === -1 ? "" : value.slice(i + 1) })
    }
  }
  return windows.length ? { name, windows } : null
}

export function buildShareLink(link: ShareLink, base: string): string {
  const parts = [`space=${slugify(link.name)}`]
  for (const w of link.windows) {
    parts.push(`app=${w.input}`)
    for (const a of w.actions) parts.push(`action=${a.name}~${a.payload}`)
  }
  return `${base}#${parts.join("&")}`
}

// Link text → what the action handler expects. `profile` wants hex; lists are
// comma-separated; everything else is passed through (`view` payloads stay
// nip19 strings — the host resolves them).
export function decodePayload(name: string, raw: string): unknown {
  if (name === "profile") return pubkeyHex(raw)
  if (LIST_ACTIONS.has(name)) {
    const items = raw
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
    return name === "feed" ? items.map(pubkeyHex) : items
  }
  return raw
}

// The inverse, for Share. Null when the payload can't be written into a link
// (an object with no event id, a string with unsafe characters).
export function encodePayload(name: string, payload: unknown): string | null {
  if (typeof payload === "string") {
    const s = name === "profile" && HEX64.test(payload) ? npubEncode(payload) : payload
    return SAFE.test(s) ? s : null
  }
  if (LIST_ACTIONS.has(name) && Array.isArray(payload)) {
    const items = payload
      .filter((s): s is string => typeof s === "string")
      .map(s => (name === "feed" && HEX64.test(s) ? npubEncode(s) : s))
    const joined = items.join(",")
    return items.length && SAFE.test(joined) ? joined : null
  }
  // A resolved event (view:<kind> handlers always get the full event): point
  // at it, the receiver resolves it again.
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id === "string" && HEX64.test(id)) return neventEncode({ id })
  return null
}

function pubkeyHex(s: string): string {
  const t = s.trim()
  if (HEX64.test(t)) return t.toLowerCase()
  try {
    const d = decode(t)
    if (d.type === "npub") return d.data
    if (d.type === "nprofile") return d.data.pubkey
  } catch {}
  return t
}
