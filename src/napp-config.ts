// NAP-CONFIG: shell-owned settings for a napp. The app declares a restricted
// JSON Schema (config.registerSchema); we render the form, store the values,
// and push config.values on every save. Secrets never ship in the artifact —
// the schema marks them x-napplet-secret and the value lives only here.
import { openDialog } from "./dialog.js"
import { button, check, input } from "./system-napps/ui.js"
import * as persist from "./persistence.js"
import { pushNappletConfig } from "./sandbox/host.js"

export type ConfigSchemaErrorCode =
  | "invalid-schema"
  | "unsupported-draft"
  | "ref-not-allowed"
  | "pattern-not-allowed"
  | "secret-with-default"
  | "schema-too-deep"
  | "version-conflict"
  | "no-schema"

// Keywords holding data, not subschemas — a "$ref" inside a default is fine.
const DATA_KEYS = new Set(["default", "examples", "enum", "const"])

// The restricted dialect: no $ref, no regex, bounded depth — any accepted
// schema must be renderable by a dumb walker.
export function validateConfigSchema(
  schema: any
): { code: ConfigSchemaErrorCode; error: string } | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return { code: "invalid-schema", error: "schema must be an object" }
  if (typeof schema.$schema === "string" && !/draft-07|2020-12/.test(schema.$schema))
    return { code: "unsupported-draft", error: `unsupported $schema: ${schema.$schema}` }
  let bad: { code: ConfigSchemaErrorCode; error: string } | null = null
  const walk = (node: any, depth: number) => {
    if (bad || !node || typeof node !== "object") return
    if (depth > 6) {
      bad = { code: "schema-too-deep", error: "nesting deeper than 6 levels" }
      return
    }
    if ("$ref" in node) {
      bad = { code: "ref-not-allowed", error: "$ref is not allowed" }
      return
    }
    if ("pattern" in node || "patternProperties" in node) {
      bad = { code: "pattern-not-allowed", error: "regex keywords are not allowed" }
      return
    }
    if (node["x-napplet-secret"] === true && "default" in node) {
      bad = { code: "secret-with-default", error: "a secret cannot carry a default" }
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (DATA_KEYS.has(k)) continue
      if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
      else walk(v, depth + 1)
    }
  }
  walk(schema, 0)
  return bad
}

// Stored values over schema defaults — what config.get/config.values carry.
export function effectiveConfigValues(nappId: string): Record<string, unknown> {
  const { schema, values } = persist.getNappletConfig(nappId)
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries<any>(schema?.properties ?? {})) {
    if (p && typeof p === "object" && "default" in p) out[k] = p.default
  }
  return { ...out, ...values }
}

// The settings form. Flat renderer over the schema's top-level properties:
// boolean → check, enum → select, number/integer → number input, string → text
// (password when x-napplet-secret). x-napplet-section groups, x-napplet-order
// sorts. Save persists and pushes config.values to the napp's open windows.
export function openNappConfigSettings(
  nappId: string,
  opts: { title?: string; section?: string } = {}
): Promise<void> {
  const { schema } = persist.getNappletConfig(nappId)
  if (!schema) return Promise.resolve()
  const values = effectiveConfigValues(nappId)
  const props = Object.entries<any>(schema.properties ?? {}).filter(
    ([, p]) => p && typeof p === "object"
  )
  props.sort((a, b) => (a[1]["x-napplet-order"] ?? 0) - (b[1]["x-napplet-order"] ?? 0))
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : [])

  return openDialog<void>({
    dismissValue: undefined,
    class: "napp-perms-dialog",
    build: resolve => {
      const wrap = document.createElement("div")
      wrap.className = "napp-perms napp-config"

      const name = document.createElement("div")
      name.className = "napp-perms-name"
      name.textContent = opts.title || schema.title || nappId
      const t = document.createElement("span")
      t.className = "napp-perms-type"
      t.textContent = "settings"
      name.appendChild(t)
      wrap.appendChild(name)

      if (schema.description) {
        const d = document.createElement("p")
        d.className = "napp-perms-reqs"
        d.textContent = schema.description
        wrap.appendChild(d)
      }

      const readers = new Map<string, () => unknown>()
      let openedSection: string | null = null
      let focusRow: HTMLElement | null = null
      for (const [key, p] of props) {
        const section = typeof p["x-napplet-section"] === "string" ? p["x-napplet-section"] : null
        if (section && section !== openedSection) {
          const h = document.createElement("div")
          h.className = "napp-config-section"
          h.textContent = section
          wrap.appendChild(h)
          openedSection = section
        }
        const row = configRow(key, p, values[key], required.has(key), readers)
        wrap.appendChild(row)
        if (opts.section && section === opts.section && !focusRow) focusRow = row
      }

      const actions = document.createElement("div")
      actions.className = "napp-perms-actions"
      actions.append(
        button({ label: "Cancel", variant: "outline", onClick: () => resolve(undefined) }),
        button({
          label: "Save",
          variant: "primary",
          onClick: () => {
            const out: Record<string, unknown> = {}
            for (const [key, read] of readers) {
              const v = read()
              if (v !== undefined) out[key] = v
            }
            persist.setNappletConfigValues(nappId, out)
            pushNappletConfig(nappId)
            resolve(undefined)
          }
        })
      )
      wrap.appendChild(actions)
      if (focusRow) setTimeout(() => focusRow!.scrollIntoView({ block: "center" }))
      return wrap
    }
  })
}

function configRow(
  key: string,
  p: any,
  value: unknown,
  required: boolean,
  readers: Map<string, () => unknown>
): HTMLElement {
  const row = document.createElement("label")
  row.className = "napp-config-row"

  const head = document.createElement("div")
  head.className = "napp-config-head"
  const title = document.createElement("span")
  title.textContent = (p.title || key) + (required ? " *" : "")
  const type = Array.isArray(p.type) ? p.type[0] : p.type

  let control: HTMLElement
  if (type === "boolean") {
    const box = check({ checked: value === true })
    readers.set(key, () => box.checked)
    head.append(box, title)
    control = head // check rides the title line, no separate control
  } else if (Array.isArray(p.enum) && p.enum.length) {
    const sel = document.createElement("select")
    sel.className = "ui-input"
    for (const v of p.enum) {
      const o = document.createElement("option")
      o.value = String(v)
      o.textContent = String(v)
      sel.appendChild(o)
    }
    if (value !== undefined) sel.value = String(value)
    // hand back the enum member itself, not its string form
    readers.set(key, () => p.enum.find((v: unknown) => String(v) === sel.value))
    head.appendChild(title)
    control = sel
  } else if (type === "number" || type === "integer") {
    const el = input({ type: "number", value: value === undefined ? "" : String(value) })
    if (typeof p.minimum === "number") el.min = String(p.minimum)
    if (typeof p.maximum === "number") el.max = String(p.maximum)
    if (type === "integer") el.step = "1"
    readers.set(key, () => {
      if (el.value === "") return undefined
      const n = Number(el.value)
      return type === "integer" ? Math.round(n) : n
    })
    head.appendChild(title)
    control = el
  } else {
    const el = input({
      type: p["x-napplet-secret"] === true ? "password" : "text",
      value: value === undefined ? "" : String(value)
    })
    readers.set(key, () => (el.value === "" && !required ? undefined : el.value))
    head.appendChild(title)
    control = el
  }

  row.appendChild(head)
  if (p.description) {
    const d = document.createElement("div")
    d.className = "napp-perms-desc"
    d.textContent = p.description
    row.appendChild(d)
  }
  if (control !== head) row.appendChild(control)
  return row
}
