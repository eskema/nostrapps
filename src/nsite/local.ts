import { guessMime } from "./mime.js"
import { WASM_DEFAULT_ENTRY as WASM_ENTRY } from "../sandbox/wasm-abi.js"
import { isIgnoredPath } from "./ignore.js"
import { nappletMetaFromHtml } from "./napplet.js"

export async function collectLocalFolder(
  fileList: FileList,
  onProgress: (msg: string) => void = () => {}
) {
  const picked = Array.from(fileList)
  if (picked.length === 0) throw new Error("No files selected")

  const rootName = picked[0].webkitRelativePath.split("/")[0]
  if (!rootName) throw new Error("Could not determine folder name")

  // Drop OS/editor/toolchain junk before anything is read, so it never reaches
  // napp storage (and the progress count reflects what's actually being read).
  const files = picked.filter(f => !isIgnoredPath(f.webkitRelativePath))
  if (files.length === 0) throw new Error("Nothing to install — every file was a system file")
  const skipped = picked.length - files.length

  const out = []
  let metadata = null
  let i = 0
  for (const file of files) {
    i++
    const relative = file.webkitRelativePath.slice(rootName.length)
    const path = relative.startsWith("/") ? relative : `/${relative}`
    onProgress(`Reading ${i}/${files.length}: ${path}`)
    const mime = file.type || guessMime(path)
    out.push({ path, body: file, mime })

    if (path === "/metadata.json") {
      try {
        const text = await file.text()
        metadata = JSON.parse(text)
      } catch {
        throw new Error("metadata.json is not valid JSON")
      }
    }
  }

  // A lone index.html with no metadata.json is ambiguous — it could be a
  // napplet or a single-file nsite. Return it with its html-derived metadata
  // and let the caller ask the user; a napplet/napplet-* meta only picks the
  // default answer.
  if (!metadata && out.length === 1 && out[0].path === "/index.html") {
    const html = await (out[0].body as File).text()
    const m = nappletMetaFromHtml(html)
    const id = m.id || slug(rootName)
    return {
      nappId: `local~${slug(id)}`,
      files: out,
      skipped,
      single: { html, napplet: m.napplet },
      metadata: {
        id,
        title: m.title || undefined,
        icon: m.icon || undefined,
        description: m.description || undefined,
        actions: [],
        requires: m.requires
      }
    }
  }

  if (!metadata) throw new Error("missing metadata.json")
  if (!metadata?.id) throw new Error("metadata.json must contain an .id field")

  const nappId = `local~${slug(metadata.id)}`

  return {
    nappId,
    files: out,
    skipped,
    single: null as { html: string; napplet: boolean } | null,
    metadata: metadata as {
      id: string
      title?: string
      icon?: string
      description?: string
      actions: string[]
      requires?: string[]
      modes?: unknown
      initial_size?: unknown
      initialSize?: unknown
    }
  }
}

// isWasmListing says whether a folder is a wasm napp: an /app.wasm with no
// index.html beside it. A page wins on any doubt — a folder with both is a
// page that happens to ship a wasm file, not a module that happens to ship a
// page — because the module's name is fixed and there is nothing to name.
export function isWasmListing(paths: Array<{ path: string } | string>): boolean {
  const names = paths.map(p => (typeof p === "string" ? p : p.path))
  return names.some(p => p === `/${WASM_ENTRY}`) && !names.some(p => /(^|\/)index\.html$/i.test(p))
}

// isWasmDevUrl is the same question for a dev server, which cannot be
// listed: /app.wasm answers, or this is a page. HEAD keeps it to headers;
// a server that refuses HEAD is treated as having no module rather than as
// broken, and launch says so if the file turns out to be needed.
export async function isWasmDevUrl(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL(WASM_ENTRY, baseUrl).toString(), { method: "HEAD" })
    return res.ok
  } catch {
    return false
  }
}

// isWasmDirHandle is isWasmListing for a picked folder: its top-level names,
// which is all the decision needs.
export async function isWasmDirHandle(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
  let hasModule = false
  let hasIndex = false
  for await (const entry of (
    dirHandle as unknown as FileSystemDirectoryHandle
  ).values() as AsyncIterable<{
    kind: string
    name: string
  }>) {
    if (entry.kind !== "file" || typeof entry.name !== "string") continue
    if (entry.name === WASM_ENTRY) hasModule = true
    if (/^index\.html$/i.test(entry.name)) hasIndex = true
  }
  return hasModule && !hasIndex
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
