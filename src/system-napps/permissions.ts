import * as perms from "../permissions.js"
import * as persist from "../persistence.js"
import * as handlers from "../handlers.js"

export const id = "permissions"
export const title = "Permissions"
export const slash = "/permissions"

export function mount(container: HTMLElement) {
  container.innerHTML = `
    <div class="perm-list" data-section="decisions"></div>
    <div class="perm-list" data-section="handlers"></div>
  `
  const decisionsEl = container.querySelector('[data-section="decisions"]')!
  const handlersEl = container.querySelector('[data-section="handlers"]')!

  function renderDecisions() {
    decisionsEl.innerHTML = ""
    const all = perms.listDecisions()
    const entries = Object.entries(all)
    if (entries.length === 0) {
      const empty = document.createElement("div")
      empty.className = "perm-empty"
      empty.textContent = "No permission decisions stored yet."
      decisionsEl.appendChild(empty)
      return
    }
    for (const [nappId, methods] of entries as [string, Record<string, string>][]) {
      const group = document.createElement("div")
      group.className = "perm-group"

      const head = document.createElement("div")
      head.className = "perm-group-head"
      const name = document.createElement("code")
      name.className = "perm-napp-id"
      name.textContent = nappId
      head.appendChild(name)
      const clearAll = document.createElement("button")
      clearAll.type = "button"
      clearAll.textContent = "forget all"
      clearAll.addEventListener("click", () => perms.forgetDecision(nappId))
      head.appendChild(clearAll)
      group.appendChild(head)

      for (const [method, decision] of Object.entries(methods) as [string, string][]) {
        const row = document.createElement("div")
        row.className = "perm-row"
        const m = document.createElement("code")
        m.className = "perm-method"
        m.textContent = method
        const d = document.createElement("span")
        d.className = `perm-decision perm-${decision}`
        d.textContent = decision
        const f = document.createElement("button")
        f.type = "button"
        f.textContent = "forget"
        f.addEventListener("click", () => perms.forgetDecision(nappId, method))
        row.append(m, d, f)
        group.appendChild(row)
      }

      decisionsEl.appendChild(group)
    }
  }

  function renderHandlerPrefs() {
    handlersEl.innerHTML = ""
    const all = persist.readHandlerPrefsAll()
    const entries = Object.entries(all)

    const heading = document.createElement("h4")
    heading.className = "store-section-heading"
    heading.textContent = "Handler choices"
    handlersEl.appendChild(heading)

    if (entries.length === 0) {
      const empty = document.createElement("div")
      empty.className = "perm-empty"
      empty.textContent =
        "No remembered action picks yet. Picks are saved when an app calls window.napp.action() and you choose between options."
      handlersEl.appendChild(empty)
    } else {
      for (const entry of entries) {
        const key = entry[0] as string
        const target = entry[1] as string
        const [caller, type, value] = key.split("|")
        const row = document.createElement("div")
        row.className = "perm-row"
        const desc = document.createElement("span")
        desc.className = "perm-method"
        desc.textContent = `${caller || "(any)"} → ${type}:${value}`
        const t = document.createElement("code")
        t.className = "perm-napp-id"
        t.textContent = target
        const f = document.createElement("button")
        f.type = "button"
        f.textContent = "forget"
        f.addEventListener("click", () => {
          persist.setHandlerPref(caller, type, value, null)
          renderHandlerPrefs()
        })
        row.append(desc, t, f)
        handlersEl.appendChild(row)
      }
    }

    const debug = document.createElement("details")
    debug.className = "perm-group"
    const summary = document.createElement("summary")
    summary.textContent = "Action map"
    debug.appendChild(summary)

    const snapshot = handlers.snapshotActionMap()
    if (snapshot.length === 0) {
      const empty = document.createElement("div")
      empty.className = "perm-empty"
      empty.textContent = "No actions registered in memory yet."
      debug.appendChild(empty)
    } else {
      for (const [action, nappIds] of snapshot) {
        const row = document.createElement("div")
        row.className = "perm-row"
        const name = document.createElement("code")
        name.className = "perm-method"
        name.textContent = action
        const targets = document.createElement("code")
        targets.className = "perm-napp-id"
        targets.textContent = nappIds.join(", ")
        row.append(name, targets)
        debug.appendChild(row)
      }
    }

    handlersEl.appendChild(debug)
  }

  function render() {
    renderDecisions()
    renderHandlerPrefs()
  }

  render()
  const unsub = perms.subscribe(render)
  const unsubHandlers = handlers.subscribe(renderHandlerPrefs)

  return {
    unmount() {
      unsub()
      unsubHandlers()
    }
  }
}
