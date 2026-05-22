import { guessMime } from "./mime.js"

export async function collectLocalFolder(fileList, onProgress = () => {}) {
  const files = Array.from(fileList)
  if (files.length === 0) throw new Error("No files selected")

  const rootName = files[0].webkitRelativePath.split("/")[0]
  if (!rootName) throw new Error("Could not determine folder name")

  const nappId = `local-${slug(rootName)}`
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
        const parsed = JSON.parse(text)
        metadata = parseMetadata(parsed)
      } catch {
        // ignore bad metadata
      }
    }
  }

  return { nappId, files: out, metadata }
}

function parseMetadata(raw) {
  const actions = []
  if (Array.isArray(raw.actions)) {
    actions.push(...raw.actions.filter(a => typeof a === "string" && a.length))
  }
  return {
    nappId: raw.id,
    name: raw.name,
    icon: typeof raw.icon === "string" && raw.icon ? raw.icon : null,
    actions: [...new Set(actions)]
  }
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
