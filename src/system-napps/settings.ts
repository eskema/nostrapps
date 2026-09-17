export const id = "settings"
export const title = "Settings"
export const slash = "/settings"

// Manual build marker shown in Settings. Bump the integer by hand whenever we
// want to confirm we're looking at a fresh build; the date is just a note.
const APP_VERSION = "1 · 2026-06-06"

import type { SystemCtx } from "../types.js"
import * as perms from "../permissions.js"
import * as handlers from "../handlers.js"
import { dispatchAction } from "../handlers.js"
import { startOutbox, stopOutbox } from "../outbox.js"
import { loginControls } from "../login.js"
import { nappNameEl } from "../napp-name.js"
import { button, check, details, item, itemList } from "./ui.js"
import { backupSection } from "./backup-section.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  container.innerHTML = `
    <div class="settings-panel">
      <details class="ui-details settings-user" open>
        <summary>user</summary>
        <div class="settings-account">
          <div class="settings-account-connected" hidden>
            <nostr-name class="settings-pubkey" style="cursor:pointer"></nostr-name>
            <span class="settings-account-type"></span>
            <button type="button" class="btn btn-outline settings-disconnect-btn">disconnect</button>
          </div>
          <div class="settings-account-disconnected"></div>
        </div>
      </details>

      <div class="settings-build-row">
        <span class="settings-build">build ${APP_VERSION}</span>
        <button type="button" class="btn btn-danger settings-reset-btn">
          erase all data
        </button>
      </div>
    </div>
  `

  const connectedEl = container.querySelector(".settings-account-connected") as HTMLElement
  const disconnectedEl = container.querySelector(".settings-account-disconnected") as HTMLElement
  const pubkeyEl = container.querySelector(".settings-pubkey") as HTMLElement
  const accountTypeEl = container.querySelector(".settings-account-type") as HTMLElement
  const disconnectBtn = container.querySelector(".settings-disconnect-btn") as HTMLElement
  const resetBtn = container.querySelector(".settings-reset-btn") as HTMLElement

  // The three ways in, from login.ts — the same block the prompt a napp raises
  // is built from. Rebuilt on logout so a stale form doesn't sit there.
  function fillLoginOptions() {
    disconnectedEl.replaceChildren(loginControls())
  }

  function renderAccount(pk: string | null) {
    if (pk) {
      startOutbox(pk).catch(() => {})
      connectedEl.hidden = false
      disconnectedEl.hidden = true
      pubkeyEl.setAttribute("pubkey", pk)
      pubkeyEl.onclick = e => {
        e.stopPropagation()
        dispatchAction("settings", "profile", pk).catch(() => {})
      }
      const type = ctx.account.getType?.()
      accountTypeEl.textContent = type === "nip46" ? "bunker" : "extension"
    } else {
      stopOutbox()
      connectedEl.hidden = true
      disconnectedEl.hidden = false
      fillLoginOptions()
    }
  }

  disconnectBtn.addEventListener("click", () => ctx.disconnect())

  resetBtn.addEventListener("click", () => {
    const ok = window.confirm(
      "Erase all nostrapps data?\n\n" +
        "This wipes every installed app, all settings, your account " +
        "connection, all permissions, all storage. The launcher will reload " +
        "into a fresh state.\n\n" +
        "This cannot be undone."
    )
    if (!ok) return
    ctx.factoryReset?.()
  })

  renderAccount(ctx.account.getPubkey())

  const unsubAccount = ctx.account.subscribe(renderAccount)

  // ─── Permissions + actions (collapsible disclosures) ────────────

  const panel = container.querySelector(".settings-panel") as HTMLElement
  const buildRow = container.querySelector(".settings-build-row") as HTMLElement

  const permDetails = details({ summary: "permissions", class: "settings-permissions" })
  const permSummary = permDetails.querySelector("summary") as HTMLElement
  const decisionsEl = document.createElement("div")
  decisionsEl.className = "perm-list"
  permDetails.appendChild(decisionsEl)

  const actionsDetails = details({ summary: "actions", class: "settings-actions" })
  const actionsSummary = actionsDetails.querySelector("summary") as HTMLElement
  const handlersEl = document.createElement("div")
  handlersEl.className = "perm-list"
  actionsDetails.appendChild(handlersEl)

  // ─── relays (auth policy) section ───────────────────────────────

  const relaysDetails = details({ summary: "relays", class: "settings-relays" })
  const relaysSummary = relaysDetails.querySelector("summary") as HTMLElement
  const relaysEl = document.createElement("div")
  relaysEl.className = "perm-list"
  relaysDetails.appendChild(relaysEl)

  const backup = backupSection(ctx)

  // Sections live directly on the root panel (user · permissions · actions ·
  // relays · backups), inserted before the build/reset footer.
  panel.insertBefore(permDetails, buildRow)
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
    relaysEl.innerHTML = ""
    const decisions = ctx.relayAuth.decisions()
    relaysSummary.textContent =
      `relays (${decisions.length})` + (ctx.relayAuth.getAuto() ? " · auto" : "")

    // The global switch: answer every relay auth challenge without asking.
    // Off (the default) → per-relay confirmation toasts, remembered here below.
    const autoRow = document.createElement("label")
    autoRow.className = "relay-auth-auto-row"
    const text = document.createElement("div")
    text.className = "napp-perms-text"
    const label = document.createElement("div")
    label.className = "napp-perms-label"
    label.textContent = "always authenticate"
    text.append(label)
    autoRow.append(
      check({
        checked: ctx.relayAuth.getAuto(),
        onChange: on => ctx.relayAuth.setAuto(on) // notify → renderRelays
      }),
      text
    )
    relaysEl.appendChild(autoRow)

    // Remembered per-relay decisions from the confirmation toasts.
    if (decisions.length === 0) {
      if (!ctx.relayAuth.getAuto()) {
        const empty = document.createElement("div")
        empty.className = "perm-empty"
        empty.textContent = "No per-relay auth decisions stored yet."
        relaysEl.appendChild(empty)
      }
      return
    }
    relaysEl.appendChild(listAction("forget all", () => ctx.relayAuth.forgetAll()))
    // Design-system rows: the url truncates with an ellipsis instead of
    // widening the panel.
    const list = itemList()
    for (const { url, decision } of decisions) {
      const d = document.createElement("span")
      d.className = `perm-decision perm-${decision}`
      d.textContent = decision
      const f = button({
        label: "forget",
        variant: "outline",
        class: "perm-forget",
        onClick: () => ctx.relayAuth.forget(url) // notify → renderRelays
      })
      list.appendChild(item({ label: url }, d, f))
    }
    relaysEl.appendChild(list)
  }

  function renderDecisions() {
    decisionsEl.innerHTML = ""
    const all = perms.listDecisions()
    const entries = Object.entries(all)
    permSummary.textContent = `permissions (${entries.length})`
    if (entries.length === 0) {
      const empty = document.createElement("div")
      empty.className = "perm-empty"
      empty.textContent = "no permission was granted yet"
      decisionsEl.appendChild(empty)
      return
    }
    decisionsEl.appendChild(listAction("forget all", () => perms.forgetAllDecisions()))
    for (const [nappId, methods] of entries as [string, Record<string, string>][]) {
      const group = document.createElement("div")
      group.className = "perm-group"

      const head = document.createElement("div")
      head.className = "perm-group-head"
      const name = nappNameEl(nappId)
      name.classList.add("perm-napp-id")
      head.appendChild(name)
      const clearAll = button({
        label: "forget all",
        variant: "outline",
        class: "perm-forget-all",
        onClick: () => perms.forgetDecision(nappId)
      })
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
        const f = button({
          label: "forget",
          variant: "outline",
          class: "perm-forget",
          onClick: () => perms.forgetDecision(nappId, method)
        })
        row.append(m, d, f)
        group.appendChild(row)
      }

      decisionsEl.appendChild(group)
    }
  }

  function renderHandlerPrefs() {
    handlersEl.innerHTML = ""
    const snapshot = handlers.snapshotActionMap()
    actionsSummary.textContent = `actions (${snapshot.length})`
    if (snapshot.length === 0) {
      const empty = document.createElement("div")
      empty.className = "perm-empty"
      empty.textContent = "No actions registered in memory yet."
      handlersEl.appendChild(empty)
      return
    }
    for (const [action, nappIds] of snapshot) {
      const row = document.createElement("div")
      row.className = "perm-row"
      const name = document.createElement("code")
      name.className = "perm-method"
      name.textContent = action
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
    renderDecisions()
    renderHandlerPrefs()
  }

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
