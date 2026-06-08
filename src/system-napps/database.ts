export const id = "database"
export const title = "Database"
export const slash = "/database"

const VARIADIC_FIELDS = [
  { key: "ids", label: "ids", placeholder: "event id" },
  { key: "authors", label: "authors", placeholder: "pubkey" },
  { key: "kinds", label: "kinds", placeholder: "kind number", numeric: true },
  { key: "tags", label: "tags", placeholder: "e=value or #e=value", tagPairs: true }
]

import type { SystemCtx } from "../types.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  container.innerHTML = `
    <div class="db-panel">
      <form class="db-form">
        <div class="db-variadic-fields"></div>
        <div class="db-static-grid">
          <label class="db-field">
            <span>since</span>
            <input type="number" name="since" placeholder="unix timestamp" inputmode="numeric" />
          </label>
          <label class="db-field">
            <span>until</span>
            <input type="number" name="until" placeholder="unix timestamp" inputmode="numeric" />
          </label>
          <label class="db-field">
            <span>limit</span>
            <input type="number" name="limit" placeholder="100" inputmode="numeric" />
          </label>
        </div>
        <div class="db-actions">
          <button type="submit" class="btn btn-outline">run query</button>
        </div>
      </form>
      <div class="db-status"></div>
      <div class="db-results"></div>
    </div>
  `

  const form = container.querySelector(".db-form") as HTMLFormElement
  const variadicEl = container.querySelector(".db-variadic-fields") as HTMLElement
  const statusEl = container.querySelector(".db-status") as HTMLElement
  const resultsEl = container.querySelector(".db-results") as HTMLElement

  function setStatus(msg: string | undefined) {
    statusEl.textContent = msg || ""
    statusEl.hidden = !msg
  }

  function syncVariadicRows(wrapper: HTMLElement) {
    const inputs = [...wrapper.querySelectorAll("input")]
    while (inputs.length < 1) {
      wrapper.appendChild(
        makeVariadicInput(
          wrapper,
          wrapper.dataset.fieldKey || "",
          wrapper.dataset.placeholder || ""
        )
      )
      inputs.push(wrapper.lastElementChild as HTMLInputElement)
    }

    let filled = inputs.filter(input => input.value.trim() !== "").length
    while (filled === inputs.length) {
      wrapper.appendChild(
        makeVariadicInput(
          wrapper,
          wrapper.dataset.fieldKey || "",
          wrapper.dataset.placeholder || ""
        )
      )
      inputs.push(wrapper.lastElementChild as HTMLInputElement)
      filled = inputs.filter(input => input.value.trim() !== "").length
    }

    while (
      inputs.length > 1 &&
      inputs[inputs.length - 1].value.trim() === "" &&
      inputs[inputs.length - 2].value.trim() === ""
    ) {
      inputs.pop()!.remove()
    }
  }

  function makeVariadicInput(wrapper: HTMLElement, fieldKey: string, placeholder: string) {
    const input = document.createElement("input")
    input.type = "text"
    input.name = fieldKey
    input.placeholder = placeholder
    input.autocomplete = "off"
    input.spellcheck = false
    input.addEventListener("input", () => syncVariadicRows(wrapper))
    return input
  }

  for (const field of VARIADIC_FIELDS) {
    const fieldEl = document.createElement("label")
    fieldEl.className = "db-field db-field-stack"

    const title = document.createElement("span")
    title.textContent = field.label
    fieldEl.appendChild(title)

    const inputs = document.createElement("div")
    inputs.className = "db-variadic-group"
    inputs.dataset.fieldKey = field.key
    inputs.dataset.placeholder = field.placeholder
    fieldEl.appendChild(inputs)

    inputs.appendChild(makeVariadicInput(inputs, field.key, field.placeholder))
    variadicEl.appendChild(fieldEl)
  }

  function readVariadic(name: string) {
    return [...(form.querySelectorAll(`input[name="${name}"]`) as unknown as HTMLInputElement[])]
      .map(input => input.value.trim())
      .filter(Boolean)
  }

  function parseNumber(name: string) {
    const raw = (form.elements.namedItem(name) as HTMLInputElement).value.trim()
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${name} must be number`)
    return value
  }

  function buildFilter() {
    const filter: Record<string, unknown> = {}
    const ids = readVariadic("ids")
    if (ids.length) filter.ids = ids

    const authors = readVariadic("authors")
    if (authors.length) filter.authors = authors

    const kindsRaw = readVariadic("kinds")
    if (kindsRaw.length) {
      filter.kinds = kindsRaw.map(raw => {
        const value = Number(raw)
        if (!Number.isFinite(value)) throw new Error(`Invalid kind: ${raw}`)
        return value
      })
    }

    const tagValues: string[] = readVariadic("tags") as string[]
    for (const pair of tagValues) {
      const idx = pair.indexOf("=")
      if (idx <= 0 || idx === pair.length - 1) {
        throw new Error(`Invalid tag filter: ${pair}`)
      }
      let key = pair.slice(0, idx).trim()
      const value = pair.slice(idx + 1).trim()
      if (!key || !value) throw new Error(`Invalid tag filter: ${pair}`)
      if (key.startsWith("#")) key = key.slice(1)
      const existing = (filter[`#${key}`] as string[]) || []
      filter[`#${key}`] = [...existing, value]
    }

    const since = parseNumber("since")
    if (since !== undefined) filter.since = since
    const until = parseNumber("until")
    if (until !== undefined) filter.until = until
    const limit = parseNumber("limit")
    if (limit !== undefined) filter.limit = limit

    return filter
  }

  function renderResults(events: any[]) {
    resultsEl.innerHTML = ""

    if (events.length === 0) {
      const empty = document.createElement("div")
      empty.className = "db-empty"
      empty.textContent = "No results."
      resultsEl.appendChild(empty)
      return
    }

    const tableWrap = document.createElement("div")
    tableWrap.className = "db-table-wrap"
    const table = document.createElement("table")
    table.className = "db-table"
    table.innerHTML = `
      <thead>
        <tr>
          <th>created</th>
          <th>kind</th>
          <th>pubkey</th>
          <th>id</th>
          <th>content</th>
          <th>tags</th>
        </tr>
      </thead>
      <tbody></tbody>
    `
    const tbody = table.querySelector("tbody")!

    for (const event of events) {
      const tr = document.createElement("tr")

      const created = document.createElement("td")
      created.textContent = new Date(event.created_at * 1000).toLocaleString()
      tr.appendChild(created)

      const kind = document.createElement("td")
      kind.textContent = String(event.kind)
      tr.appendChild(kind)

      const pubkey = document.createElement("td")
      pubkey.className = "db-mono"
      pubkey.textContent = event.pubkey
      tr.appendChild(pubkey)

      const id = document.createElement("td")
      id.className = "db-mono"
      id.textContent = event.id
      tr.appendChild(id)

      const content = document.createElement("td")
      content.className = "db-content"
      content.textContent = event.content || ""
      tr.appendChild(content)

      const tags = document.createElement("td")
      tags.className = "db-tags"
      tags.textContent = JSON.stringify(event.tags || [])
      tr.appendChild(tags)

      tbody.appendChild(tr)
    }

    tableWrap.appendChild(table)
    resultsEl.appendChild(tableWrap)
  }

  form.addEventListener("submit", async e => {
    e.preventDefault()
    resultsEl.innerHTML = ""
    setStatus("Running query…")

    try {
      const filter = buildFilter()
      const events = await ctx.database.query(filter)
      setStatus(`${events.length} result${events.length === 1 ? "" : "s"}`)
      renderResults(events)
    } catch (err: any) {
      setStatus(`Error: ${err?.message || String(err)}`)
    }
  })
}
