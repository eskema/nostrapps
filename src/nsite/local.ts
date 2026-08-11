import { guessMime } from "./mime.js"
import { isIgnoredPath } from "./ignore.js"

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

  if (!metadata) throw new Error("missing metadata.json")
  if (!metadata?.id) throw new Error("metadata.json must contain an .id field")

  const nappId = `local~${slug(metadata.id)}`

  return {
    nappId,
    files: out,
    skipped,
    metadata: metadata as {
      id: string
      title?: string
      icon?: string
      singleton?: boolean
      actions: string[]
      requires?: string[]
    }
  }
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
