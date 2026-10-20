export const id = "settings"
export const title = "Settings"
export const slash = "/settings"

import type { SystemCtx } from "../types.js"
import * as perms from "../permissions.js"
import * as handlers from "../handlers.js"
import { dispatchAction } from "../handlers.js"
import { loginControls } from "../login.js"
import { nappName, nappNameEl } from "../napp-name.js"
import { author, badge, busy, button, check, code, details, el, empty, item, itemList } from "./ui.js"
import { backupSection } from "./backup-section.js"
import { permissionsSection } from "./permissions-section.js"

export function mount(container: HTMLElement, ctx: SystemCtx, opts: { fit?(): void } = {}) {
  const pubkeyEl = el("span", "settings-pubkey")
  const accountTypeEl = badge("", { class: "settings-account-type" })
  const disconnectBtn = button({
    label: "disconnect",
    class: "settings-disconnect-btn",
    onClick: () => ctx.disconnect()
  })
  const connectedEl = el("div", "settings-account-connected", pubkeyEl, accountTypeEl, disconnectBtn)
  connectedEl.hidden = true
  const disconnectedEl = el("div", "settings-account-disconnected")
  const resetBtn = button({ label: "erase all data", variant: "danger", class: "settings-reset-btn" })
  const buildRow = el("div", "settings-build-row", buildLine(), resetBtn)
  const panel = el(
    "div",
    "settings-panel",
    details(
      { summary: "user", sticky: true, open: true, class: "settings-user" },
      el("div", "settings-account", connectedEl, disconnectedEl)
    ),
    buildRow
  )
  container.replaceChildren(panel)

  // The three ways in, from login.ts — the same block the prompt a napp raises
  // is built from. Rebuilt on logout so a stale form doesn't sit there.
  function fillLoginOptions() {
    disconnectedEl.replaceChildren(loginControls())
  }

  function renderAccount(pk: string | null) {
    if (pk) {
      connectedEl.hidden = false
      disconnectedEl.hidden = true
      pubkeyEl.replaceChildren(
        author(pk, {
          picture: "s", // the row's size: it shares the line with a button
          onClick: (_pubkey, e) => {
            e.stopPropagation()
            dispatchAction("settings", "profile", pk).catch(() => {})
          }
        })
      )
      const type = ctx.account.getType?.()
      accountTypeEl.textContent = type === "nip46" ? "bunker" : "extension"
    } else {
      connectedEl.hidden = true
      disconnectedEl.hidden = false
      fillLoginOptions()
    }
  }

  resetBtn.addEventListener("click", () => {
    const ok = window.confirm(
      "Erase all nostrapps data?\n\n" +
        "This wipes every installed app, all settings, your account " +
        "connection, all permissions, all storage. The launcher will reload " +
        "into a fresh state.\n\n" +
        "This cannot be undone."
    )
    if (!ok) return
    resetBtn.textContent = "erasing"
    // The wipe runs until the reload, so the button breathes meanwhile.
    busy(resetBtn)
    resetBtn.setAttribute("disabled", "")
    ctx.factoryReset?.()
  })

  renderAccount(ctx.account.getPubkey())

  const unsubAccount = ctx.account.subscribe(renderAccount)

  // ─── Permissions + actions (collapsible disclosures) ────────────

  const permissions = permissionsSection({
    napp: nappName,
    icon: perms.nappIcon,
    forget: (nappId, method) => perms.forgetDecision(nappId, method),
    forgetAll: () => perms.forgetAllDecisions()
  })

  const actionsDetails = details({ summary: "actions", sticky: true, class: "settings-actions" })
  const actionsSummary = actionsDetails.querySelector("summary") as HTMLElement
  const handlersEl = document.createElement("div")
  handlersEl.className = "perm-list"
  actionsDetails.appendChild(handlersEl)

  // ─── relays (auth policy) section ───────────────────────────────

  const relaysDetails = details({ summary: "relays", sticky: true, class: "settings-relays" })
  const relaysSummary = relaysDetails.querySelector("summary") as HTMLElement
  const relaysEl = document.createElement("div")
  relaysEl.className = "perm-list"
  relaysDetails.appendChild(relaysEl)

  const backup = backupSection(ctx)

  // Sections live directly on the root panel (user · permissions · actions ·
  // relays · backups), inserted before the build/reset footer.
  panel.insertBefore(permissions.el, buildRow)
  panel.insertBefore(actionsDetails, buildRow)
  panel.insertBefore(relaysDetails, buildRow)
  panel.insertBefore(backup.el, buildRow)

  // A section-wide action sitting above its list, right aligned — the section's
  // "forget all", next to the per-row "forget" buttons below it.
  function listAction(label: string, onClick: () => void): HTMLElement {
    const row = document.createElement("div")
    row.className = "perm-list-actions"
    row.appendChild(button({ label, variant: "outline", onClick }))
    return row
  }

  function renderRelays() {
    relaysEl.replaceChildren()
    const decisions = ctx.relayAuth.decisions()
    relaysSummary.textContent =
      `relays (${decisions.length})` + (ctx.relayAuth.getAuto() ? " · auto" : "")

    // The global switch: answer every relay auth challenge without asking.
    // Off (the default) → per-relay confirmation toasts, remembered here below.
    relaysEl.appendChild(
      check({
        label: "always authenticate",
        class: "relay-auth-auto-row",
        checked: ctx.relayAuth.getAuto(),
        onChange: on => ctx.relayAuth.setAuto(on) // notify → renderRelays
      })
    )

    // Remembered per-relay decisions from the confirmation toasts.
    if (decisions.length === 0) {
      if (!ctx.relayAuth.getAuto()) {
        relaysEl.appendChild(empty("No per-relay auth decisions stored yet."))
      }
      return
    }
    relaysEl.appendChild(listAction("forget all", () => ctx.relayAuth.forgetAll()))
    // Design-system rows: the url truncates with an ellipsis instead of
    // widening the panel.
    const list = itemList()
    for (const { url, decision } of decisions) {
      const d = badge(decision, {
        tone: decision === "allow" ? "good" : "danger",
        class: "perm-decision"
      })
      const f = button({
        label: "forget",
        variant: "outline",
        class: "perm-forget",
        onClick: () => ctx.relayAuth.forget(url) // notify → renderRelays
      })
      list.appendChild(item({ label: code(url) }, d, f))
    }
    relaysEl.appendChild(list)
  }

  function renderHandlerPrefs() {
    handlersEl.replaceChildren()
    const snapshot = handlers.snapshotActionMap()
    actionsSummary.textContent = `actions (${snapshot.length})`
    if (snapshot.length === 0) {
      handlersEl.appendChild(empty("No actions registered in memory yet."))
      return
    }
    for (const [action, nappIds] of snapshot) {
      const row = document.createElement("div")
      row.className = "perm-row"
      const name = code(action, "perm-method")
      const targets = document.createElement("span")
      targets.className = "perm-napp-id"
      for (const id of nappIds) {
        if (targets.childNodes.length) targets.append(", ")
        targets.appendChild(nappNameEl(id))
      }
      row.append(name, targets)
      handlersEl.appendChild(row)
    }
  }

  function renderPerms() {
    permissions.render(perms.listDecisions())
    renderHandlerPrefs()
  }

  // Opening a section is a click, so the window may take the room for it.
  // (`toggle` doesn't bubble — capture reaches it.)
  panel.addEventListener("toggle", () => opts.fit?.(), true)

  renderPerms()
  const unsubPerms = perms.subscribe(renderPerms)
  const unsubHandlers = handlers.subscribe(renderHandlerPrefs)

  renderRelays()
  const unsubRelays = ctx.relayAuth.subscribe(renderRelays)

  return {
    unmount() {
      unsubAccount()
      unsubPerms()
      unsubHandlers()
      unsubRelays()
      backup.unmount()
    }
  }
}

// What this build was made from, the commit and its date, opening the commit
// on the repo.
function buildLine(): HTMLButtonElement {
  const { id, date, url } = __BUILD__
  return button({
    label: `build ${id}${date ? ` · ${date}` : ""}`,
    variant: "link",
    class: "settings-build",
    disabled: !url,
    onClick: () => window.open(url, "_blank", "noopener,noreferrer")
  })
}
