// Settings' permissions: what the prompts were told to remember, by napp, in
// the prompts' words ("SIGN any event"), each to forget. A napp reads as the
// prompt's head does: its icon and title, the Apps card's byline under them.
// It is handed the decisions and what a forget does, so the mock page
// (mocks/permissions.html) can lay it out with made-up ones. render() puts a
// new set of decisions in place, a row or a napp added, gone or changed, the
// rest left as it is.
import { nappByline, type NappName } from "../napp-name.js"
import { decisionLabel } from "../permissions.js"
import { badge, button, details, el, empty, item, itemList } from "./ui.js"

export type Decisions = Record<string, Record<string, string>>

export interface PermissionsSectionOpts {
  napp(nappId: string): Pick<NappName, "title" | "author" | "authorLabel" | "type">
  icon?(nappId: string): HTMLElement | undefined
  forget(nappId: string, method?: string): void
  forgetAll(): void
}

interface Row {
  el: HTMLElement
  decision: string
  badge: HTMLElement
}

interface Group {
  el: HTMLElement
  items: HTMLElement
  rows: Map<string, Row>
}

const decisionBadge = (decision: string) =>
  badge(decision, { tone: decision === "allow" ? "good" : "danger" })

export function permissionsSection(opts: PermissionsSectionOpts) {
  const section = details({ summary: "permissions", sticky: true, class: "settings-permissions" })
  const summary = section.querySelector("summary") as HTMLElement
  const top = el(
    "div",
    "perm-list-actions",
    button({ label: "forget all", variant: "link", onClick: () => opts.forgetAll() })
  )
  const none = empty("no permission was granted yet")
  const list = el("div", "perm-list", top, none)
  section.appendChild(list)
  const groups = new Map<string, Group>()

  function group(nappId: string): Group {
    const napp = opts.napp(nappId)
    const icon = opts.icon?.(nappId)
    const title = el(
      "div",
      "perm-napp-title",
      ...(icon ? [icon] : []),
      el("strong", "", napp.title)
    )
    const forget = button({
      label: "forget",
      variant: "link",
      title: `Forget everything ${napp.title} was allowed or denied`,
      onClick: () => opts.forget(nappId)
    })
    const items = itemList()
    return {
      el: el(
        "div",
        "perm-napp",
        el("div", "perm-napp-head", title, forget, nappByline(napp)),
        items
      ),
      items,
      rows: new Map()
    }
  }

  function row(nappId: string, method: string, decision: string): Row {
    const b = decisionBadge(decision)
    const forget = button({
      variant: "ghost",
      icon: "close",
      title: "Forget",
      class: "perm-forget",
      onClick: () => opts.forget(nappId, method)
    })
    return {
      el: item({ label: decisionLabel(method), title: method }, b, forget),
      decision,
      badge: b
    }
  }

  function render(all: Decisions) {
    const ids = Object.keys(all)
    summary.textContent = `permissions (${ids.length})`
    top.hidden = ids.length === 0
    none.hidden = ids.length > 0
    for (const [id, g] of groups)
      if (!(id in all)) {
        g.el.remove()
        groups.delete(id)
      }
    for (const id of ids) {
      let g = groups.get(id)
      if (!g) {
        g = group(id)
        groups.set(id, g)
        list.append(g.el)
      }
      const methods = all[id]
      for (const [m, r] of g.rows)
        if (!(m in methods)) {
          r.el.remove()
          g.rows.delete(m)
        }
      for (const [m, d] of Object.entries(methods)) {
        const r = g.rows.get(m)
        if (!r) {
          const fresh = row(id, m, d)
          g.rows.set(m, fresh)
          g.items.append(fresh.el)
        } else if (r.decision !== d) {
          const b = decisionBadge(d)
          r.badge.replaceWith(b)
          Object.assign(r, { decision: d, badge: b })
        }
      }
    }
  }

  return { el: section, render }
}
