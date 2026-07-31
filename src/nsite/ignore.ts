// Junk that comes from the OS, the editor or the toolchain and is never part of
// the site being published. Applied wherever a folder is read — the local~
// folder install and the uploader's directory walk — so the same things are
// skipped whether the files land in napp storage or go up to blossom servers.
//
// Deliberately an explicit list rather than "skip anything dotted": a site's
// `.well-known/nostr.json` (NIP-05) is a dotted directory that MUST ship.

// Dropped along with everything under them.
const IGNORED_DIRS = new Set([
  ".git",
  ".svn",
  ".hg", // VCS internals
  "node_modules", // never part of a built site, and thousands of files
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".TemporaryItems", // macOS volume metadata
  ".idea",
  ".vscode" // editor state
])

// Matched case-insensitively: these come from file managers that don't care.
const IGNORED_FILES = new Set([
  ".ds_store", // macOS Finder
  "thumbs.db",
  "ehthumbs.db",
  "desktop.ini" // Windows Explorer
])

// `path` may be a full relative path or a bare entry name; both are handled.
export function isIgnoredPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) return false
  const name = segments[segments.length - 1]

  // Any ignored directory anywhere in the path takes the whole subtree with it.
  if (segments.some(s => IGNORED_DIRS.has(s))) return true

  if (IGNORED_FILES.has(name.toLowerCase())) return true
  if (name.startsWith("._")) return true // AppleDouble resource forks
  if (name.endsWith("~")) return true // editor backups
  if (/\.sw[a-p]$/.test(name)) return true // vim swap files
  // Secrets: publishing to blossom is public and permanent, and a stray .env in
  // a build folder is the classic way to leak keys.
  if (name === ".env" || name.startsWith(".env.")) return true

  return false
}
