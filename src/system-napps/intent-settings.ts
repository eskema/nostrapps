import { getPubkey } from "../account.js"
import { intentCatalog, intentPreferences, intentRoutes, forgetIntentRoute, refreshIntentPreferences, discoverIntents, editIntentPreference, subscribeIntents, unlockIntentPreference } from "../intents/manager.js"
import { manifestContracts, conventionIdentity } from "../intents/catalog.js"
import { handlerEntries, type HandlerEdit } from "../intents/preferences.js"
import { button, el, code, details } from "./ui.js"

export function intentSettings() {
  const content = el("div", "intent-settings")
  const section = details({ summary: "intent handlers", sticky: true }, content)
  let active = true, busy = false, message = ""
  let role = "", identity = ""
  const run = async (work: () => Promise<unknown>) => {
    busy = true; message = ""; render()
    try { await work() } catch (e) { message = e instanceof Error ? e.message : String(e) }
    finally { busy = false; if (active) render() }
  }
  function render() {
    const catalog = intentCatalog(), preferences = intentPreferences()
    const roles = [...new Set([...preferences.keys(), ...[...catalog.values()].flatMap(e => manifestContracts(e).map(c => c.archetype))])].sort()
    role ||= roles[0] ?? ""
    content.replaceChildren(button({ label: busy ? "Loading…" : "Refresh handlers", disabled: busy, onClick: () => void run(() => Promise.all([refreshIntentPreferences(), discoverIntents()])) }))
    if (message) content.append(el("p", "", message))
    for (const [convention, route] of Object.entries(intentRoutes())) content.append(el("div", "", code(convention), ` · ${route}`, button({ label: "Forget route", onClick: () => forgetIntentRoute(convention) })))
    if (!getPubkey()) { content.append(el("p", "", "Connect an account to sync handler preferences.")); return }
    const roleInput = document.createElement("input")
    roleInput.placeholder = "Archetype"; roleInput.setAttribute("aria-label", "Intent archetype"); roleInput.value = role
    roleInput.addEventListener("change", () => { role = roleInput.value.trim(); identity = ""; render() })
    const rolesList = document.createElement("select")
    rolesList.setAttribute("aria-label", "Saved archetypes")
    for (const r of roles) rolesList.add(new Option(r, r, false, r === role))
    rolesList.addEventListener("change", () => { role = rolesList.value; identity = ""; render() })
    content.append(roleInput, rolesList)
    if (!conventionIdentity(`napplet:${role}/open`)) return
    const contracts = [...new Set([...catalog.values()].flatMap(e => manifestContracts(e).filter(c => c.archetype === role).map(c => c.convention)))]
    const pref = preferences.get(role)
    for (const tag of [...pref?.event.tags ?? [], ...pref?.privateTags ?? []]) if (tag[0] === "i" && !contracts.includes(tag[1])) contracts.push(tag[1])
    const scope = document.createElement("select"); scope.setAttribute("aria-label", "Handler chain")
    scope.add(new Option("All intents for this archetype", "", false, !identity))
    for (const c of contracts) scope.add(new Option(c, c, false, c === identity))
    scope.addEventListener("change", () => { identity = scope.value; render() })
    content.append(scope)
    const edit = (change: HandlerEdit) => run(() => editIntentPreference(role, { identity: identity || undefined, ...change }))
    if (pref?.locked) {
      content.append(button({ label: "Unlock private preferences", disabled: busy, onClick: () => void run(() => unlockIntentPreference(role)) }))
      return
    }
    for (const entry of handlerEntries(pref, identity || undefined)) {
      const row = el("div", "", code(entry.reference), entry.hidden ? " · private" : " · public")
      row.append(
        button({ label: "Prefer", disabled: busy, onClick: () => void edit({ action: "prefer", reference: entry.reference, hidden: entry.hidden }) }),
        button({ label: entry.hidden ? "Make public" : "Make private", disabled: busy, onClick: () => void edit({ action: "visibility", reference: entry.reference, hidden: !entry.hidden }) }),
        button({ label: "Remove handler", disabled: busy, onClick: () => void edit({ action: "remove", reference: entry.reference }) })
      )
      content.append(row)
    }
    const target = document.createElement("select"); target.setAttribute("aria-label", "Add intent handler")
    for (const [ref, event] of catalog) if (manifestContracts(event).some(c => c.archetype === role && (!identity || c.convention === identity))) target.add(new Option(event.tags.find(t => t[0] === "title")?.[1] || ref, ref))
    content.append(target, button({ label: "Add handler", disabled: busy || !target.options.length, onClick: () => void edit({ action: "add", reference: target.value }) }), button({ label: "Reset chain", disabled: busy, onClick: () => void edit({ action: "reset" }) }), button({ label: "Clear archetype preferences", disabled: busy, onClick: () => void edit({ action: "clear" }) }))
  }
  const stop = subscribeIntents(() => { if (active && !busy) render() })
  section.addEventListener("toggle", () => { if (section.open) void run(() => Promise.all([refreshIntentPreferences(), discoverIntents()])) })
  render()
  return { section, unmount() { active = false; stop() } }
}
