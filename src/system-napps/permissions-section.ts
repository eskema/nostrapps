// Settings' permissions: what a new install's screen starts from, folded,
// nsites' and napps' apart from napplets', then by napp, what its install
// screen granted, then what the prompts were told to remember, in the
// prompts' words ("SAVE files"), each to forget. A napp is one line opening
// its permission screen: its icon, "<title> <type> from <author>", and at the
// end what it's granted. It is handed the grants, the decisions and what a forget
// does, so the mock page (mocks/permissions.html) can lay it out with made-up
// ones. render() puts a new set in place, a row or a napp added, gone or
// changed, the rest left as it is.
import { nappByline, type NappName } from "../napp-name.js"
import { decisionLabel } from "../permissions.js"
import { badge, button, details, el, empty, item, itemList, overline } from "./ui.js"

export type Decisions = Record<string, Record<string, string>>
// An installed napp's granted rows, as named on its screen, ui left out.
export type Grants = Record<string, string[]>

export interface PermissionsSectionOpts {
  napp(nappId: string): Pick<NappName, "title" | "author" | "authorLabel" | "type">
  icon?(nappId: string): HTMLElement | undefined
  // The rows a new install starts from.
  defaults?: { napps: HTMLElement; napplets: HTMLElement }
  // An installed napp's permission screen.
  open?(nappId: string): void
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
  open: HTMLButtonElement
  items: HTMLElement
  rows: Map<string, Row>
  grants: HTMLElement
  forget: HTMLElement
}

const decisionBadge = (decision: string) =>
  badge(decision, { tone: decision === "allow" ? "good" : "danger" })

export function permissionsSection(opts: PermissionsSectionOpts) {
  const section = details({ summary: "permissions", sticky: true, class: "settings-permissions" })
  const summary = section.querySelector("summary") as HTMLElement
  const top = el(
    "div",
    "perm-list-actions",
    button({
      label: "forget all",
      variant: "link",
      title: "Forget every allow and deny the prompts remembered",
      onClick: () => opts.forgetAll()
    })
  )
  const none = empty("no permission was granted yet")
  const list = el("div", "perm-list", top, none)
  if (opts.defaults)
    list.prepend(
      el(
        "div",
        "perm-defaults",
        details({ summary: "nsites and napps defaults" }, opts.defaults.napps),
        details({ summary: "napplets defaults" }, opts.defaults.napplets)
      )
    )
  section.appendChild(list)
  const groups = new Map<string, Group>()

  function group(nappId: string): Group {
    const napp = opts.napp(nappId)
    const icon = opts.icon?.(nappId)
    const title = el(
      "span",
      "perm-napp-title",
      ...(icon ? [icon] : []),
      el("strong", "", napp.title),
      " ",
      nappByline(napp)
    )
    const forget = button({
      label: "forget",
      variant: "link",
      title: `Forget everything ${napp.title} was allowed or denied`,
      onClick: () => opts.forget(nappId)
    })
    const grants = overline("", "perm-napp-grants")
    const open = button({
      variant: "link",
      class: "perm-napp-open",
      title: `${napp.title}'s permissions`,
      onClick: () => opts.open?.(nappId)
    })
    open.append(title, grants)
    const items = itemList()
    return {
      el: el("div", "perm-napp", el("div", "perm-napp-head", open, forget), items),
      open,
      items,
      rows: new Map(),
      grants,
      forget
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

  function render(all: Decisions, grants: Grants = {}) {
    const ids = [...new Set([...Object.keys(grants), ...Object.keys(all)])]
    summary.textContent = `permissions (${ids.length})`
    top.hidden = Object.keys(all).length === 0
    none.hidden = ids.length > 0
    for (const [id, g] of groups)
      if (!(id in all) && !(id in grants)) {
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
      // Only an installed napp has grants; one gone may still have decisions
      // left to forget.
      const installed = id in grants
      const text = installed ? (grants[id].length ? grants[id].join(", ") : "nothing granted") : ""
      if (g.grants.textContent !== text) g.grants.textContent = text
      g.grants.hidden = !installed
      g.open.disabled = !installed
      const methods = all[id] ?? {}
      g.forget.hidden = Object.keys(methods).length === 0
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
