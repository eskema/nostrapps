export const id = "handler"
export const title = "Handler"
export const singleton = false

import type { InstalledApp, NappWindowState, SystemCtx } from "../types.js"

type HandlerParams = {
  name: string
  payload: unknown
  callerNappId: string
  candidates: string[]
  openCandidates: NappWindowState[]
  select: (nappId: string, instanceId?: string) => void
  cancel: () => void
}

export function mount(container: HTMLElement, ctx: SystemCtx, opts: { params: HandlerParams }) {
  const params = opts.params || {}
  const name = typeof params.name === "string" ? params.name : ""
  const payload = params.payload
  const candidates = Array.isArray(params.candidates) ? params.candidates : []
  let settled = false

  container.innerHTML = `
    <div class="handler-panel">
      <div class="handler-request">
        <div class="handler-request-label">action</div>
        <code class="handler-action-name"></code>
        <div class="handler-request-label">value</div>
        <pre class="handler-payload"></pre>
      </div>
      <div class="handler-candidates"></div>
      <div class="handler-open-instances"></div>
      <div class="handler-actions">
        <button type="button" class="btn btn-outline handler-cancel">cancel</button>
      </div>
    </div>
  `

  const nameEl = container.querySelector(".handler-action-name") as HTMLElement
  const payloadEl = container.querySelector(".handler-payload") as HTMLElement
  const candidatesEl = container.querySelector(".handler-candidates") as HTMLElement
  const openInstancesEl = container.querySelector(".handler-open-instances") as HTMLElement
  const cancelBtn = container.querySelector(".handler-cancel") as HTMLElement

  nameEl.textContent = name || "(none)"
  payloadEl.textContent = formatPayload(payload)

  function finish(fn?: () => void) {
    if (settled) return
    settled = true
    fn?.()
  }

  function appLabel(app: InstalledApp | undefined, nappId: string) {
    return app?.petname || app?.title || nappId
  }

  function renderCandidates() {
    candidatesEl.innerHTML = ""
    const apps = ctx.apps.list()
    const byId = new Map(apps.map(app => [app.nappId, app]))

    const heading = document.createElement("h3")
    heading.textContent = "Open new app"
    candidatesEl.appendChild(heading)

    if (candidates.length === 0) {
      const empty = document.createElement("div")
      empty.className = "handler-empty"
      empty.textContent = "No installed app declares this action."
      candidatesEl.appendChild(empty)
      return
    }

    const list = document.createElement("ul")
    list.className = "handler-list"
    for (const nappId of candidates) {
      const app = byId.get(nappId)
      const item = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"

      const title = document.createElement("span")
      title.className = "handler-pet"
      title.textContent = appLabel(app, nappId)

      const idEl = document.createElement("code")
      idEl.className = "handler-id"
      idEl.textContent = nappId

      button.append(title, idEl)
      button.addEventListener("click", () => finish(() => params.select(nappId)))
      item.appendChild(button)
      list.appendChild(item)
    }
    candidatesEl.appendChild(list)
  }

  function renderOpenInstances() {
    openInstancesEl.innerHTML = ""

    if (params.openCandidates.length === 0) {
      openInstancesEl.style.display = "none"
      return
    }

    openInstancesEl.style.display = ""

    const heading = document.createElement("h3")
    heading.textContent = "Already open"
    openInstancesEl.appendChild(heading)

    const list = document.createElement("ul")
    list.className = "handler-list"
    for (const win of params.openCandidates) {
      const app = ctx.apps.get(win.nappId)

      const item = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"

      const title = document.createElement("span")
      title.className = "handler-pet napp-title"
      title.textContent = appLabel(app, win.nappId)
      title.dataset.instance = win.instanceId

      const idEl = document.createElement("code")
      idEl.className = "handler-id"
      idEl.textContent = app?.title || win.nappId

      button.append(title, idEl)
      button.addEventListener("mouseup", () =>
        finish(() => params.select(win.nappId, win.instanceId))
      )
      item.appendChild(button)
      list.appendChild(item)
    }
    openInstancesEl.appendChild(list)
  }

  cancelBtn.addEventListener("click", () => finish(() => params.cancel?.()))
  renderCandidates()
  renderOpenInstances()
  const unsubscribe = ctx.apps.subscribe(() => {
    renderCandidates()
    renderOpenInstances()
  })

  return {
    unmount() {
      unsubscribe()
      finish(() => params.cancel?.())
    }
  }
}

function formatPayload(payload: unknown) {
  if (payload === undefined) return "undefined"
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
