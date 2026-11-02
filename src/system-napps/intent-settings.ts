import { getPubkey, subscribe as subscribeAccount } from "../account.js"
import {
  intentCatalog,
  intentPreferences,
  intentRoutes,
  forgetIntentRoute,
  refreshIntentPreferences,
  discoverIntents,
  editIntentPreference,
  subscribeIntents,
  unlockIntentPreference
} from "../intents/manager.js"
import { canReceiveIntent, manifestContracts, conventionIdentity } from "../intents/catalog.js"
import { handlerEntries, type HandlerEdit } from "../intents/preferences.js"
import { button, el, code, details, appIcon, icon, author } from "./ui.js"

/** Native editor for kind 31129 defaults and convention-specific handler chains. */
export function intentSettings() {
  const content = el("div", "intent-settings")
  const section = details({ summary: "intent handlers", sticky: true }, content)
  let active = true,
    busy = false,
    message = "",
    query = "",
    selected = ""
  let account = getPubkey()
  const expanded = new Set<string>()
  const run = async (work: () => Promise<unknown>) => {
    if (busy || !active) return
    const startedFor = getPubkey()
    busy = true
    message = ""
    render()
    try {
      await work()
    } catch (e) {
      if (startedFor === getPubkey()) message = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
      if (active) {
        render()
        if (startedFor !== getPubkey() && section.open) void refresh()
      }
    }
  }
  const refresh = () => run(() => Promise.all([refreshIntentPreferences(), discoverIntents()]))
  function render() {
    if (account !== getPubkey()) {
      account = getPubkey()
      expanded.clear()
      selected = ""
      query = ""
      message = ""
    }
    const catalog = intentCatalog(),
      preferences = intentPreferences()
    const identities = new Map<string, string[]>()
    for (const [role, pref] of preferences) {
      const contracts = new Set<string>()
      for (const tag of [...pref.event.tags, ...pref.privateTags])
        if (
          tag[0] === "i" &&
          conventionIdentity(tag[1] ?? "")?.archetype === role &&
          handlerEntries(pref, tag[1]).length
        )
          contracts.add(tag[1]!)
      identities.set(role, [...contracts].sort())
    }
    const roles = [...preferences.keys()]
      .filter(role => {
        const pref = preferences.get(role)!
        return pref.locked || handlerEntries(pref).length || identities.get(role)?.length
      })
      .sort()
    if (selected && !roles.includes(selected)) selected = ""
    const matches = (value: string) =>
      query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .every(t => value.toLowerCase().includes(t))
    content.replaceChildren()
    const search = document.createElement("input")
    search.type = "search"
    search.placeholder = "Filter intents…"
    search.value = query
    search.setAttribute("aria-label", "Filter intents")
    search.addEventListener("input", () => {
      const start = search.selectionStart
      query = search.value
      render()
      const next = content.querySelector<HTMLInputElement>('input[type="search"]')!
      next.focus()
      if (start !== null) next.setSelectionRange(start, start)
    })
    const filter = document.createElement("select")
    filter.setAttribute("aria-label", "Archetype")
    filter.add(new Option("All archetypes", ""))
    roles.forEach(r => filter.add(new Option(r, r)))
    filter.value = selected
    filter.onchange = () => {
      selected = filter.value
      render()
    }
    content.append(
      el(
        "div",
        "intent-toolbar",
        search,
        filter,
        button({
          label: busy ? "Loading…" : "Refresh handlers",
          disabled: busy,
          onClick: () => void refresh()
        })
      )
    )
    content.append(
      el(
        "p",
        "",
        "Preferred napplets sync with your account. Intent overrides run before archetype defaults; private handlers run before public handlers within each chain."
      )
    )
    if (message) {
      const error = el("p", "", message)
      error.setAttribute("role", "alert")
      content.append(error)
    }
    const routes = Object.entries(intentRoutes())
    if (routes.length) {
      const routesSection = el(
        "section",
        "intent-routes",
        el("h3", "", "Remembered choices · this device")
      )
      for (const [convention, route] of routes)
        routesSection.append(
          el(
            "div",
            "intent-handler-row",
            code(convention),
            route === "napp" ? "Open in another app" : "Use preferred napplets",
            button({ label: "Forget route", onClick: () => forgetIntentRoute(convention) })
          )
        )
      content.append(routesSection)
    }
    if (!account) {
      content.append(el("p", "", "Connect an account to sync handler preferences."))
      return
    }
    let shown = 0
    for (const role of roles) {
      if (selected && selected !== role) continue
      const pref = preferences.get(role)
      const chains = ["", ...(identities.get(role) ?? [])].filter(
        identity =>
          handlerEntries(pref, identity || undefined).length &&
          matches(`${role} ${identity || "default"}`)
      )
      if (!chains.length && (!pref?.locked || !matches(role))) continue
      shown++
      const group = details({
        summary: role,
        open: expanded.has(role) || !!query || !!selected
      })
      group.classList.add("intent-archetype")
      group.addEventListener("toggle", () => {
        if (group.open) expanded.add(role)
        else expanded.delete(role)
      })
      if (pref?.locked)
        group.append(
          el("p", "", "Private preferences are locked. Unlock to inspect or edit this archetype."),
          button({
            label: "Unlock private preferences",
            disabled: busy,
            onClick: () => void run(() => unlockIntentPreference(role))
          })
        )
      for (const identity of chains) {
        const edit = (change: HandlerEdit) =>
          run(() => editIntentPreference(role, { identity: identity || undefined, ...change }))
        const chain = el("section", "intent-chain", el("h4", "", identity || "Defaults"))
        chain.setAttribute("aria-label", `${role} ${identity || "default"} handlers`)
        const entries = handlerEntries(pref, identity || undefined)
        if (!entries.length)
          chain.append(el("p", "", identity ? "Uses archetype defaults." : "No default handlers."))
        entries.forEach((entry, index) => {
          const event = catalog.get(entry.reference)
          const name = event?.tags.find(t => t[0] === "title")?.[1] || "Unavailable napplet"
          const picture = appIcon({ size: "m", fade: true })
          picture.append(icon("tile"))
          picture.setAttribute("aria-hidden", "true")
          if (event)
            void import("../nsite/icon.js")
              .then(m => m.nappletIconSrc(event))
              .then(src => {
                if (src) picture.img.src = src
              })
              .catch(() => {})
          const info = el(
            "div",
            "intent-handler-name",
            el("strong", "", name),
            ...(event ? [author(event.pubkey, { link: false })] : [])
          )
          if (event?.kind === 5129) info.append(el("span", "", "Pinned snapshot"))
          const row = el(
            "div",
            "intent-handler-row",
            el("span", "", `${index + 1}.`),
            picture,
            info,
            el("span", "", entry.hidden ? "Private" : "Public"),
            button({
              label: "Prefer",
              disabled:
                busy ||
                !!pref?.locked ||
                !entries.slice(0, index).some(e => e.hidden === entry.hidden),
              onClick: () =>
                void edit({ action: "prefer", reference: entry.reference, hidden: entry.hidden })
            }),
            button({
              label: entry.hidden ? "Make public" : "Make private",
              disabled: busy || !!pref?.locked,
              onClick: () =>
                void edit({
                  action: "visibility",
                  reference: entry.reference,
                  hidden: !entry.hidden
                })
            }),
            button({
              icon: "trash",
              title: "Remove handler",
              disabled: busy || !!pref?.locked,
              onClick: () => void edit({ action: "remove", reference: entry.reference })
            })
          )
          chain.append(row)
        })
        const target = document.createElement("select")
        target.setAttribute("aria-label", `Add ${role} ${identity || "default"} handler`)
        target.add(
          new Option(
            entries.length ? "Add fallback…" : identity ? "Add override…" : "Add handler…",
            ""
          )
        )
        for (const [ref, event] of catalog)
          if (
            canReceiveIntent(event) &&
            !entries.some(e => e.reference === ref) &&
            manifestContracts(event).some(
              c => c.archetype === role && (!identity || c.convention === identity)
            )
          )
            target.add(new Option(event.tags.find(t => t[0] === "title")?.[1] || "Napplet", ref))
        target.disabled = busy || !!pref?.locked
        const hidden = document.createElement("input")
        hidden.type = "checkbox"
        hidden.disabled = busy || !!pref?.locked
        const submit = button({
          label: "Add handler",
          disabled: true,
          onClick: () =>
            void edit({ action: "add", reference: target.value, hidden: hidden.checked })
        })
        target.onchange = () => {
          submit.disabled = busy || !!pref?.locked || !target.value
        }
        chain.append(
          el("div", "intent-toolbar", target, el("label", "", hidden, "Private"), submit)
        )
        group.append(chain)
      }
      if (pref)
        group.append(
          el(
            "div",
            "intent-settings-footer",
            button({
              label: "Clear archetype preferences",
              disabled: busy || pref.locked,
              onClick: () => {
                if (window.confirm(`Clear defaults and all intent overrides for ${role}?`))
                  void run(() => editIntentPreference(role, { action: "clear" }))
              }
            })
          )
        )
      content.append(group)
    }
    if (!shown)
      content.append(
        el("p", "", query || selected ? "No matching intents." : "No saved intent handlers.")
      )
  }
  const stopAccount = subscribeAccount(() => {
    if (!active) return
    render()
    if (section.open && !busy) void refresh()
  })
  const stop = subscribeIntents(() => {
    if (active && !busy) render()
  })
  section.addEventListener("toggle", () => {
    if (section.open) void refresh()
  })
  render()
  return {
    section,
    unmount() {
      active = false
      stop()
      stopAccount()
    }
  }
}
