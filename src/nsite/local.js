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
  // Backward compat: handle_action and handle_kind
  if (Array.isArray(raw.handle_action)) {
    actions.push(...raw.handle_action.filter(a => typeof a === "string" && a.length))
  }
  if (Array.isArray(raw.handle_kind)) {
    for (const k of raw.handle_kind) {
      if (Number.isInteger(k) && k >= 0) actions.push(`view:${k}`)
    }
  }
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : null,
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
