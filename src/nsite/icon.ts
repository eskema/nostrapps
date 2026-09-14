// Manifest icons come in three shapes: a data:/http(s): URL (self-contained
// napplets), a blossom sha, or a path into the napp's own files ("/icon.svg").
// Only the first is a usable <img> src as-is — which is why the permission
// screen showed a broken image for everything else.
import type { InstalledApp } from "../types.js"
import { getDevHandle, getDevUrl, nappOriginFor } from "../sandbox/host.js"
import { loadBlossomServers } from "@nostr/gadgets/lists"
import { normalizeServer } from "../utils.js"

const DIRECT = /^(data:|https?:)/i
const SHA = /^[0-9a-f]{64}$/i

const norm = (p: string) => p.replace(/^\//, "").toLowerCase()
const base = (p: string) => norm(p).replace(/^.*\//, "")

// The path a manifest's icon tag points at: itself, or the `path` tag carrying
// the sha it names (path tags are ["path", "/icon.svg", "<sha>", "<mime>"]).
function iconPath(icon: string, tags?: string[][]): string | undefined {
  if (!SHA.test(icon)) return icon
  return tags?.find(t => t[0] === "path" && t[2]?.toLowerCase() === icon.toLowerCase())?.[1]
}

// Usable as an <img> src with no lookup at all: a self-contained napplet's
// inline data: URI, or an icon hosted somewhere absolute.
export function directIconSrc(icon: string | undefined | null): string | undefined {
  return icon && DIRECT.test(icon) ? icon : undefined
}

// For the install screens, which run BEFORE the napp's origin serves anything:
// the files have just been read into memory, so show the icon from there.
export function iconBlobFrom(
  icon: string | undefined,
  files: { path: string; body: Blob }[],
  manifest?: { tags: string[][] } | null
): Blob | undefined {
  if (!icon || DIRECT.test(icon)) return undefined
  const want = iconPath(icon, manifest?.tags)
  if (!want) return undefined
  // The declared path may not match the file exactly (root vs subfolder), so
  // fall back to the basename anywhere in the folder — same as the Apps cards.
  const hit =
    files.find(f => norm(f.path) === norm(want)) || files.find(f => base(f.path) === base(want))
  return hit?.body
}

// For an app that's already installed: its origin IS serving, so a path (or the
// path behind a sha) resolves against it — the same URL the Apps list uses.
export function installedIconSrc(app: InstalledApp): string | undefined {
  const icon = app.icon
  if (!icon) return undefined
  if (DIRECT.test(icon)) return icon
  const path = iconPath(icon, app.event?.tags)
  if (!path) return undefined
  return `${nappOriginFor(app.nappId)}${path.startsWith("/") ? "" : "/"}${path}`
}

// For a dev app loaded from a picked directory: read the file off the handle,
// the way metadata.json was read.
export async function iconBlobFromDir(
  dir: FileSystemDirectoryHandle,
  icon: string | undefined
): Promise<Blob | undefined> {
  if (!icon || DIRECT.test(icon)) return undefined
  const parts = icon.split("/").filter(Boolean)
  if (!parts.length) return undefined
  try {
    let d = dir
    for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg)
    return await (await d.getFileHandle(parts[parts.length - 1])).getFile()
  } catch {
    return undefined // no such file — the screen just shows no icon
  }
}

// Conventional icon filenames to look for when a manifest declares no usable
// `icon` tag. Matched by BASENAME (so an icon in a subfolder still counts);
// apple-touch-icon is handled separately (preferred, any size/path).
const ICON_FALLBACK_NAMES = [
  "icon.svg",
  "favicon.svg",
  "icon.png",
  "favicon.png",
  "icon-192.png",
  "favicon.ico"
]

// Resolve a manifest's icon to a blossom sha, fetched from the author's servers
// (the Apps cards, installedIconSources below). The `icon` tag may hold a sha OR
// a path (e.g. "/icon.svg" from metadata.json) — for a path we map it to the
// file's sha via the manifest's `path` tags. With no usable icon tag we look
// through the manifest's files BY FILENAME (so icons in subfolders are found,
// not just at the root), preferring an apple-touch-icon, then a conventional
// favicon name.
export function resolveCardIcon(evt: any): {
  sha: string | null
  mime: string | null
  url: string | null
} {
  const pathTags = evt.tags.filter((t: any) => t[0] === "path" && t[1] && t[2])
  const basename = (p: any) => String(p).replace(/^.*\//, "").toLowerCase()
  // Match the full declared path (manifests vary on the leading slash).
  const byFullPath = (p: string) => {
    const want = String(p).replace(/^\//, "")
    return pathTags.find((t: any) => String(t[1]).replace(/^\//, "") === want)
  }
  const byName = (name: string) => pathTags.find((t: any) => basename(t[1]) === name)

  const iconTag = evt.tags.find((t: any) => t[0] === "icon" && t[1])
  if (iconTag) {
    const val = iconTag[1] as string
    if (/^[0-9a-f]{64}$/i.test(val)) return { sha: val, mime: iconTag[2] || null, url: null }
    // A self-contained napplet has no file paths to point at, so its icon is an
    // inline data: URI or an absolute URL — use it directly.
    if (/^(data:|https?:)/i.test(val)) return { sha: null, mime: null, url: val }
    // The declared path may not match exactly (root vs subfolder); fall back to
    // its filename anywhere in the manifest.
    const pt = byFullPath(val) || byName(basename(val))
    if (pt) return { sha: pt[2], mime: pt[3] || null, url: null }
  }

  // Prefer an apple-touch-icon (a real app icon), wherever it lives.
  const apple = pathTags.find((t: any) => basename(t[1]).startsWith("apple-touch-icon"))
  if (apple) return { sha: apple[2], mime: apple[3] || null, url: null }

  for (const name of ICON_FALLBACK_NAMES) {
    const pt = byName(name)
    if (pt) return { sha: pt[2], mime: pt[3] || null, url: null }
  }
  return { sha: null, mime: null, url: null }
}

// The <img> srcs an installed app's icon can load from in the LAUNCHER page,
// best first. The napp's own origin is no use here: its service worker only
// answers its own documents. Published apps: the icon's sha on the manifest's
// servers, the author's blossom list and the default, like the Apps cards. Dev
// apps: the file off the picked folder, or the dev server. A local/temp app's
// files only exist in its origin's IDB, so those show nothing unless the icon
// is a data:/http(s): URL.
export async function installedIconSources(app: InstalledApp): Promise<string[]> {
  const direct = directIconSrc(app.icon)
  if (direct) return [direct]
  if (app.event) {
    const { sha, url } = resolveCardIcon(app.event)
    if (url) return [url]
    if (!sha) return []
    const own = app.event.tags.filter(t => t[0] === "server" && t[1]).map(t => t[1])
    // The uploader records exactly the servers the blobs went to. Only a
    // manifest naming none is worth the author's blossom list: a relay round
    // trip, with a relay-list lookup ahead of it.
    const authors: string[] = own.length
      ? []
      : await loadBlossomServers(app.event.pubkey)
          .then((r: any) => (r?.items ?? []) as string[])
          .catch(() => [])
    const servers = [...new Set([...own, ...authors, "relay.nostrapps.com"].map(normalizeServer))]
    return servers.map(s => `${s}/${sha}`)
  }
  if (!app.icon) return []
  const dir = getDevHandle(app.nappId)
  if (dir) {
    const blob = await iconBlobFromDir(dir, app.icon)
    return blob ? [URL.createObjectURL(blob)] : []
  }
  const base = getDevUrl(app.nappId)
  return base ? [new URL(app.icon.replace(/^\//, ""), base).toString()] : []
}
