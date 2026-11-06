// Settings' actions: what's available, an action a row opening to the napps
// that declare it, one of them to tick as its default (every caller without
// a route of its own goes there); then what the pickers were told to
// remember, a caller a row opening to its routes, each to change (the same
// picker again) or forget. render() puts a new set in place, rows and items
// added, gone or changed, the rest left as it is, so an open row stays open.
import type { OpenCandidate } from "../handlers.js"
import type { Route } from "../action-routes.js"
import type { InstalledApp } from "../types.js"
import { nappNameEl, nappNameText } from "../napp-name.js"
import {
  badge,
  button,
  check,
  code,
  details,
  el,
  empty,
  item,
  itemList,
  overline,
  row,
  rowList
} from "./ui.js"

export type Available = Array<[action: string, nappIds: string[]]>
export type Defaults = Record<string, string>
export type Routes = Record<string, Record<string, Route>>

export interface ActionsSectionOpts {
  apps: { get(nappId: string): InstalledApp | undefined }
  // Every space's open windows: a route's window gets its number and space.
  windows(): OpenCandidate[]
  currentSpaceId(): string
  setDefault(action: string, nappId: string | null): void
  change(caller: string, action: string): void
  forget(caller: string, action?: string): void
  forgetAll(): void
}

interface ActionRow {
  el: HTMLDetailsElement
  dflt: HTMLElement
  apps: HTMLElement
  checks: Map<string, HTMLInputElement>
}

interface CallerRow {
  el: HTMLDetailsElement
  count: HTMLElement
  items: HTMLElement
  routes: Map<string, { el: HTMLElement; key: string }>
}

export function actionsSection(opts: ActionsSectionOpts) {
  const section = details({ summary: "actions", sticky: true, class: "settings-actions" })
  const summary = section.querySelector("summary") as HTMLElement

  // ── available ──
  const available = details({ summary: "available", class: "actions-available" })
  const availableSummary = available.querySelector("summary") as HTMLElement
  const noActions = empty("No actions registered in memory yet.")
  const actionRows = rowList("actions-rows")
  available.append(noActions, actionRows)

  // ── remembered ──
  const forgetAll = button({
    label: "forget all",
    variant: "link",
    title: "Forget every choice the pickers remembered",
    onClick: () => opts.forgetAll()
  })
  const head = el("div", "actions-remembered-head", overline("remembered"), forgetAll)
  const noRoutes = empty("nothing remembered yet")
  const callerRows = rowList("actions-rows")

  section.append(el("div", "perm-list", available, head, noRoutes, callerRows))

  const actions = new Map<string, ActionRow>()
  const callers = new Map<string, CallerRow>()

  const appName = (nappId: string) =>
    opts.apps.get(nappId) ? nappNameEl(nappId) : el("span", "", nappNameText(nappId))

  function actionRow(action: string): ActionRow {
    const dflt = el("span", "actions-default")
    const apps = el("div", "actions-apps")
    const r = row(actionRows, code(action), dflt)
    r.append(apps)
    return { el: r, dflt, apps, checks: new Map() }
  }

  function callerRow(caller: string): CallerRow {
    const count = badge("")
    const name = caller === "launcher" ? el("span", "", "launcher") : appName(caller)
    name.classList.add("actions-caller")
    const r = row(callerRows, name, count)
    const items = itemList()
    r.append(items)
    return { el: r, count, items, routes: new Map() }
  }

  // A route's window: its number among the napp's open windows (the picker's),
  // and its space when it's another; gone, it says so until the next dispatch
  // opens the window that takes its place.
  function windowBadge(route: Route): HTMLElement {
    if (!route.instanceId) return badge("new window")
    const wins = opts.windows().filter(w => w.window.nappId === route.nappId)
    const i = wins.findIndex(w => w.window.instanceId === route.instanceId)
    if (i === -1) return badge("window closed", { tone: "warn" })
    const w = wins[i]
    const space = w.spaceId !== opts.currentSpaceId() ? ` · ${w.spaceName}` : ""
    return badge(`#${i + 1}${space}`)
  }

  // What tells one rendering of a route from the next.
  function routeKey(route: Route): string {
    return `${route.nappId}|${windowBadge(route).textContent}|${route.auxiliary ? "aux" : ""}`
  }

  function routeItem(caller: string, action: string, route: Route): HTMLElement {
    const label = el("span", "actions-route", code(action), " → ", appName(route.nappId))
    const change = button({
      label: "change",
      variant: "link",
      title: "Choose another napp or window for it",
      onClick: () => opts.change(caller, action)
    })
    const forget = button({
      variant: "ghost",
      icon: "close",
      title: "Forget",
      class: "perm-forget",
      onClick: () => opts.forget(caller, action)
    })
    return item({ label, title: `${action} from ${caller}` }, windowBadge(route), change, forget)
  }

  function render(avail: Available, defaults: Defaults, routes: Routes) {
    const byAction = new Map(avail)
    summary.textContent = `actions (${avail.length})`
    availableSummary.textContent = `available (${avail.length})`
    noActions.hidden = avail.length > 0
    for (const [action, r] of actions)
      if (!byAction.has(action)) {
        r.el.remove()
        actions.delete(action)
      }
    for (const [action, declared] of avail) {
      let r = actions.get(action)
      if (!r) {
        r = actionRow(action)
        actions.set(action, r)
      }
      // A view:<kind> can also go to a napp taking any view, as the lookup
      // has it.
      const ids = action.startsWith("view:")
        ? [...new Set([...declared, ...(byAction.get("view") ?? [])])]
        : declared
      const own = defaults[action]
      const inherited = !own && action.startsWith("view:") ? defaults["view"] : undefined
      const picked = own ?? inherited
      const text = picked ? nappNameText(picked) + (inherited ? " (from view)" : "") : ""
      if (r.dflt.textContent !== text) r.dflt.textContent = text
      for (const [id, c] of r.checks)
        if (!ids.includes(id)) {
          c.closest("label")?.remove()
          r.checks.delete(id)
        }
      for (const id of ids) {
        let c = r.checks.get(id)
        if (!c) {
          const l = check({
            label: nappNameText(id),
            onChange: on => opts.setDefault(action, on ? id : null)
          })
          c = l.querySelector("input") as HTMLInputElement
          r.checks.set(id, c)
          r.apps.append(l)
        }
        c.checked = own === id
      }
    }

    const ids = Object.keys(routes)
    noRoutes.hidden = ids.length > 0
    forgetAll.hidden = ids.length === 0
    for (const [caller, r] of callers)
      if (!(caller in routes)) {
        r.el.remove()
        callers.delete(caller)
      }
    for (const caller of ids) {
      let r = callers.get(caller)
      if (!r) {
        r = callerRow(caller)
        callers.set(caller, r)
      }
      const its = routes[caller]
      const n = String(Object.keys(its).length)
      if (r.count.textContent !== n) r.count.textContent = n
      for (const [action, it] of r.routes)
        if (!(action in its)) {
          it.el.remove()
          r.routes.delete(action)
        }
      for (const [action, route] of Object.entries(its)) {
        const key = routeKey(route)
        const it = r.routes.get(action)
        if (it && it.key === key) continue
        const fresh = routeItem(caller, action, route)
        if (it) it.el.replaceWith(fresh)
        else r.items.append(fresh)
        r.routes.set(action, { el: fresh, key })
      }
    }
  }

  return { el: section, render }
}
