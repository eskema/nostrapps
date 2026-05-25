import { guessMime } from "./mime.js"

export async function collectLocalFolder(
  fileList: FileList,
  onProgress: (msg: string) => void = () => {}
) {
  const files = Array.from(fileList)
  if (files.length === 0) throw new Error("No files selected")

  const rootName = files[0].webkitRelativePath.split("/")[0]
  if (!rootName) throw new Error("Could not determine folder name")

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

    console.log("path", file.name, "~", path)

    if (path === "/metadata.json") {
      try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        metadata = parseMetadata(parsed)
      } catch {
        throw new Error("metadata.json is not valid JSON")
      }
    }
  }

  if (!metadata) throw new Error("missing metadata.json")
  if (!metadata?.id) throw new Error("metadata.json must contain an .id field")

  const nappId = `local~${slug(metadata.id)}`

  return { nappId, files: out, metadata }
}

function parseMetadata(raw: {
  actions?: string[]
  id?: string
  title?: string
  name?: string
  icon?: string
}) {
  const actions = []
  if (Array.isArray(raw.actions)) {
    actions.push(...raw.actions.filter(a => typeof a === "string" && a.length))
  }
  return {
    id: raw.id,
    title: raw.title,
    name: raw.name,
    icon: typeof raw.icon === "string" && raw.icon ? raw.icon : null,
    actions: [...new Set(actions)]
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
