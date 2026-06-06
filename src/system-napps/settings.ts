export const id = "settings"
export const title = "Settings"
export const slash = "/settings"

const GOOGLE_LABEL = "log in with google"

// Manual build marker shown in Settings. Bump the integer by hand whenever we
// want to confirm we're looking at a fresh build; the date is just a note.
const APP_VERSION = "1 · 2026-06-06"

import type { SystemCtx } from "../types.js"
import * as perms from "../permissions.js"
import * as handlers from "../handlers.js"
import { dispatchAction } from "../handlers.js"
import { startOutbox, stopOutbox } from "../outbox.js"

export function mount(container: HTMLElement, ctx: SystemCtx) {
  container.innerHTML = `
    <div class="settings-panel">
      <div class="settings-row">
        <span class="settings-label">Theme</span>
        <div class="settings-theme">
          <button type="button" data-choice="light" title="Light">☀</button>
          <button type="button" data-choice="dark" title="Dark">☾</button>
          <button type="button" data-choice="auto" title="Auto">◐</button>
        </div>
      </div>

      <div class="settings-row settings-reset-row">
        <span class="settings-label">Reset</span>
        <button type="button" class="settings-reset-btn">
          erase all data
        </button>
      </div>

      <div class="settings-row settings-account-row">
        <span class="settings-label">Account</span>
        <div class="settings-account">
          <div class="settings-account-connected" hidden>
            <nostr-name class="settings-pubkey" style="cursor:pointer"></nostr-name>
            <span class="settings-account-type"></span>
            <button type="button" class="settings-disconnect-btn">disconnect</button>
          </div>
          <div class="settings-account-disconnected">
            <button type="button" class="settings-connect-extension">
              connect with extension
            </button>
            <button type="button" class="settings-connect-bunker-toggle">
              connect with bunker
            </button>
            <button type="button" class="settings-connect-google">
              ${GOOGLE_LABEL}
            </button>
            <div class="settings-google-error" hidden></div>
            <form class="settings-bunker-form" hidden>
              <input
                type="text"
                class="settings-bunker-input"
                placeholder="bunker://…"
                autocomplete="off"
                spellcheck="false"
              />
              <div class="settings-bunker-actions">
                <button type="submit" class="settings-bunker-submit">connect</button>
                <button type="button" class="settings-bunker-cancel">cancel</button>
              </div>
              <div class="settings-bunker-error" hidden></div>
            </form>
          </div>
        </div>
      </div>

      <hr class="settings-separator" />

      <div class="perm-list" data-section="decisions"></div>
      <div class="perm-list" data-section="handlers"></div>

      <div class="settings-build">build ${APP_VERSION}</div>
    </div>
  `

  const themeBtns = container.querySelectorAll(".settings-theme button") as unknown as HTMLElement[]
  const connectedEl = container.querySelector(".settings-account-connected") as HTMLElement
  const disconnectedEl = container.querySelector(".settings-account-disconnected") as HTMLElement
  const pubkeyEl = container.querySelector(".settings-pubkey") as HTMLElement
  const accountTypeEl = container.querySelector(".settings-account-type") as HTMLElement
  const disconnectBtn = container.querySelector(".settings-disconnect-btn") as HTMLElement
  const connectExtBtn = container.querySelector(".settings-connect-extension") as HTMLElement
  const bunkerToggleBtn = container.querySelector(".settings-connect-bunker-toggle") as HTMLElement
  const googleBtn = container.querySelector(".settings-connect-google") as HTMLElement
  const googleError = container.querySelector(".settings-google-error") as HTMLElement
  const bunkerForm = container.querySelector(".settings-bunker-form") as HTMLElement
  const bunkerInput = container.querySelector(".settings-bunker-input") as HTMLInputElement
  const bunkerSubmit = container.querySelector(".settings-bunker-submit") as HTMLElement
  const bunkerCancel = container.querySelector(".settings-bunker-cancel") as HTMLElement
  const bunkerError = container.querySelector(".settings-bunker-error") as HTMLElement
  const resetBtn = container.querySelector(".settings-reset-btn") as HTMLElement

  function renderTheme(choice: string) {
    for (const btn of themeBtns) {
      btn.classList.toggle("active", btn.dataset.choice === choice)
    }
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
      bunkerForm.hidden = true
      bunkerError.hidden = true
      bunkerInput.value = ""
      googleError.hidden = true
      googleError.textContent = ""
    }
  }

  function showBunkerError(msg: string) {
    bunkerError.textContent = msg
    bunkerError.hidden = false
  }

  for (const btn of themeBtns) {
    btn.addEventListener("click", () => ctx.theme.set(btn.dataset.choice!))
  }

  disconnectBtn.addEventListener("click", () => ctx.disconnect())

  connectExtBtn.addEventListener("click", async () => {
    try {
      await ctx.connect()
    } catch {
      // setStatus already logged it
    }
  })

  bunkerToggleBtn.addEventListener("click", () => {
    bunkerForm.hidden = !bunkerForm.hidden
    if (!bunkerForm.hidden) bunkerInput.focus()
  })

  googleBtn.addEventListener("click", async () => {
    googleError.hidden = true
    googleError.textContent = ""
    googleBtn.disabled = true
    googleBtn.textContent = "connecting…"
    try {
      // On success the account.subscribe callback re-renders the
      // connected state; nothing to do here.
      await ctx.connectGoogle()
    } catch (err: any) {
      googleError.textContent = err?.message || String(err)
      googleError.hidden = false
    } finally {
      googleBtn.disabled = false
      googleBtn.textContent = GOOGLE_LABEL
    }
  })

  bunkerCancel.addEventListener("click", () => {
    bunkerForm.hidden = true
    bunkerError.hidden = true
    bunkerInput.value = ""
  })

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

  bunkerForm.addEventListener("submit", async e => {
    e.preventDefault()
    bunkerError.hidden = true
    const uri = bunkerInput.value.trim()
    if (!uri) return
    bunkerSubmit.disabled = true
    bunkerSubmit.textContent = "connecting…"
    try {
      await ctx.connectBunker(uri)
    } catch (err: any) {
      showBunkerError(err?.message || String(err))
    } finally {
      bunkerSubmit.disabled = false
      bunkerSubmit.textContent = "connect"
    }
  })

  renderTheme(ctx.theme.get())
  renderAccount(ctx.account.getPubkey())

  const unsubTheme = ctx.theme.subscribe(renderTheme)
  const unsubAccount = ctx.account.subscribe(renderAccount)

  // ─── Permissions ────────────────────────────────────────

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

    const heading = document.createElement("h4")
    heading.className = "store-section-heading"
    heading.textContent = "Action handlers"
    handlersEl.appendChild(heading)

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

  function renderPerms() {
    renderDecisions()
    renderHandlerPrefs()
  }

  renderPerms()
  const unsubPerms = perms.subscribe(renderPerms)
  const unsubHandlers = handlers.subscribe(renderHandlerPrefs)

  return {
    unmount() {
      unsubTheme()
      unsubAccount()
      unsubPerms()
      unsubHandlers()
    }
  }
}
