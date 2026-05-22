export const id = "settings"
export const title = "Settings"
export const slash = "/settings"

const GOOGLE_LABEL = "log in with google"

import type { SystemCtx } from "../types.js"

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
            <code class="settings-pubkey"></code>
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
      connectedEl.hidden = false
      disconnectedEl.hidden = true
      pubkeyEl.textContent = pk.slice(0, 8)
      pubkeyEl.title = pk
      const type = ctx.account.getType?.()
      accountTypeEl.textContent = type === "nip46" ? "bunker" : "extension"
    } else {
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

  return {
    unmount() {
      unsubTheme()
      unsubAccount()
    }
  }
}
