export const id = "apps"
export const title = "Apps"
export const slash = "/apps"

import type { SystemCtx } from "../types.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  container.innerHTML = `<div class="apps-list"></div>`
  const listEl = container.querySelector(".apps-list")!

  function render() {
    const apps = ctx.apps.list()
    listEl.innerHTML = ""

    if (apps.length === 0) {
      const empty = document.createElement("div")
      empty.className = "apps-empty"
      empty.textContent = "No local apps registered yet."
      listEl.appendChild(empty)
      return
    }

    for (const app of apps) {
      const card = document.createElement("div")
      card.className = "apps-card"
      card.addEventListener("mouseup", (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest("button")) return
        ctx.launchAppInfo(app)
      })

      const head = document.createElement("div")
      head.className = "apps-card-head"

      const titles = document.createElement("div")
      titles.className = "apps-card-titles"

      const name = document.createElement("h3")
      name.className = "apps-title"
      name.textContent = app.name || app.nappId
      titles.appendChild(name)

      const meta = document.createElement("div")
      meta.className = "apps-meta"

      const idEl = document.createElement("code")
      idEl.className = "apps-napp-id"
      idEl.textContent = app.nappId
      meta.appendChild(idEl)

      if (app.openCount > 0) {
        const openEl = document.createElement("span")
        openEl.textContent = `${app.openCount} open`
        meta.appendChild(openEl)
      }

      if (app.manifest?.createdAt) {
        const manifestDate = document.createElement("span")
        manifestDate.textContent = new Date(app.manifest.createdAt * 1000).toLocaleDateString()
        meta.appendChild(manifestDate)
      }

      titles.appendChild(meta)

      if (app.handlers.length > 0) {
        const handlers = document.createElement("div")
        handlers.className = "apps-handlers"
        for (const action of app.handlers) {
          const chip = document.createElement("span")
          chip.className = "apps-handler"
          chip.textContent = action
          handlers.appendChild(chip)
        }
        titles.appendChild(handlers)
      }

      const actions = document.createElement("div")
      actions.className = "apps-actions"

      const del = document.createElement("button")
      del.type = "button"
      del.textContent = "delete"
      del.addEventListener("mouseup", async () => {
        ctx.setStatus?.(`Apps: delete requested for ${app.nappId}`)
        const ok = window.confirm(
          `Delete ${app.name || app.nappId}?\n\nThis removes local app files, windows, permissions, and stored state for this app.`
        )
        if (!ok) {
          ctx.setStatus?.(`Apps: delete cancelled for ${app.nappId}`)
          return
        }
        del.disabled = true
        del.textContent = "deleting…"
        try {
          ctx.setStatus?.(`Apps: deleting ${app.nappId}…`)
          await ctx.uninstall(app.nappId)
          ctx.setStatus?.(`Apps: delete finished for ${app.nappId}`)
        } catch (err: any) {
          ctx.setStatus?.(`Apps: delete failed for ${app.nappId}: ${err?.message || String(err)}`)
          del.disabled = false
          del.textContent = "error"
          del.title = err?.message || String(err)
          setTimeout(() => {
            del.textContent = "delete"
            del.removeAttribute("title")
          }, 3000)
        }
      })
      actions.appendChild(del)

      head.append(titles, actions)
      card.appendChild(head)
      listEl!.appendChild(card)
    }
  }

  render()
  const unsub = ctx.apps.subscribe(render)

  return {
    unmount() {
      unsub()
    }
  }
}
