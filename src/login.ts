// Getting a key into the launcher. Three ways in — extension, bunker, the
// google shortcut — shared by the settings panel and by the prompt a napp
// raises when it asks for an identity nobody has connected yet.
//
// Every signer path in the bridge goes through requireAccount(), so an app
// that asks for the key on load gets a login screen instead of an empty
// string it will quietly render nothing for.
import { openDialog } from "./dialog.js"
import { button, input } from "./system-napps/ui.js"
import { getPubkey, setAccount } from "./account.js"
import { connectBunkerInput } from "./signers/nip46.js"
import { googleLoginAndCreateBunker } from "./signers/google.js"
import { nappNameEl } from "./napp-name.js"

const GOOGLE_LABEL = "log in with google"

// Progress lines go to the launcher log, wherever the login was started from —
// the settings panel or the prompt a napp raised. main.ts wires this at boot.
let statusSink: (msg: string) => void = () => {}
export function setLoginStatusSink(fn: (msg: string) => void) {
  statusSink = fn
}

// ─── the three ways in ───────────────────────────────────────────
// Each ends the same way: a pubkey and the signer type it came from, saved as
// the account.

export async function loginWithExtension(): Promise<string> {
  if (!window.nostr) throw new Error("No NIP-07 extension detected")
  const pk = await window.nostr.getPublicKey()
  setAccount(pk, "nip07")
  return pk
}

export async function loginWithBunker(uri: string): Promise<string> {
  const pk = await connectBunkerInput(uri)
  setAccount(pk, "nip46")
  return pk
}

// One-shot Google OAuth → Pomegranate sharding → bunker handoff. End state is
// identical to a pasted bunker URI; the user never sees one.
export async function loginWithGoogle(onProgress?: (msg: string) => void): Promise<string> {
  const uri = await googleLoginAndCreateBunker({ onProgress })
  const pk = await connectBunkerInput(uri)
  setAccount(pk, "nip46")
  return pk
}

// ─── the controls ────────────────────────────────────────────────

export interface LoginControlsOpts {
  // Fired with the pubkey once any path completes.
  onDone?: (pubkey: string) => void
}

// The three login paths as one block, used by the settings panel and by the
// prompt. Errors land under the button that caused them rather than only in
// the log — the prompt has no log to look at.
export function loginControls(opts: LoginControlsOpts = {}): HTMLElement {
  const status = (msg: string) => statusSink(msg)
  const done = (pk: string) => {
    status(`Connected as ${pk.slice(0, 8)}…`)
    opts.onDone?.(pk)
  }

  const wrap = document.createElement("div")
  wrap.className = "login-options"

  const errorEl = () => {
    const el = document.createElement("div")
    el.className = "login-error"
    el.hidden = true
    return el
  }
  const fail = (el: HTMLElement, err: any) => {
    el.textContent = err?.message || String(err)
    el.hidden = false
  }

  // extension. Always offered, never gated on window.nostr being there when
  // this is built: extensions inject on their own schedule, so a snapshot
  // taken at build time drops the row for anyone whose extension was a beat
  // late. loginWithExtension checks at click time, which is the only moment
  // the answer is worth anything.
  const extError = errorEl()
  const extSection = document.createElement("div")
  extSection.className = "login-section"
  extSection.append(
    button({
      label: "connect with extension",
      onClick: async () => {
        extError.hidden = true
        try {
          status("Requesting pubkey from extension…")
          done(await loginWithExtension())
        } catch (err: any) {
          status(`Error: ${err.message}`)
          fail(extError, err)
        }
      }
    }),
    extError
  )
  wrap.appendChild(extSection)

  // bunker
  const bunkerSection = document.createElement("div")
  bunkerSection.className = "login-section"
  const bunkerError = errorEl()
  const bunkerForm = document.createElement("form")
  bunkerForm.className = "login-bunker-form"
  bunkerForm.hidden = true
  const bunkerInput = input({
    placeholder: "bunker://…",
    autocomplete: "off",
    spellcheck: false
  })
  const bunkerSubmit = button({ label: "connect", type: "submit" })
  const bunkerCancel = button({
    label: "cancel",
    onClick: () => {
      bunkerForm.hidden = true
      bunkerError.hidden = true
      bunkerInput.value = ""
    }
  })
  const bunkerActions = document.createElement("div")
  bunkerActions.className = "login-bunker-actions"
  bunkerActions.append(bunkerSubmit, bunkerCancel)
  bunkerForm.append(bunkerInput, bunkerActions, bunkerError)
  bunkerForm.addEventListener("submit", async e => {
    e.preventDefault()
    bunkerError.hidden = true
    const uri = bunkerInput.value.trim()
    if (!uri) return
    bunkerSubmit.disabled = true
    bunkerSubmit.textContent = "connecting…"
    try {
      status("Connecting to bunker…")
      done(await loginWithBunker(uri))
    } catch (err: any) {
      status(`Error: ${err.message}`)
      fail(bunkerError, err)
    } finally {
      bunkerSubmit.disabled = false
      bunkerSubmit.textContent = "connect"
    }
  })
  bunkerSection.append(
    button({
      label: "connect with bunker",
      onClick: () => {
        bunkerForm.hidden = !bunkerForm.hidden
        if (!bunkerForm.hidden) bunkerInput.focus()
      }
    }),
    bunkerForm
  )
  wrap.appendChild(bunkerSection)

  // google
  const googleSection = document.createElement("div")
  googleSection.className = "login-section"
  const googleError = errorEl()
  const googleBtn = button({
    label: GOOGLE_LABEL,
    onClick: async () => {
      googleError.hidden = true
      googleBtn.disabled = true
      googleBtn.textContent = "connecting…"
      try {
        done(await loginWithGoogle(status))
      } catch (err: any) {
        status(`Error: ${err.message}`)
        fail(googleError, err)
      } finally {
        googleBtn.disabled = false
        googleBtn.textContent = GOOGLE_LABEL
      }
    }
  })
  googleSection.append(googleBtn, googleError)
  wrap.appendChild(googleSection)

  return wrap
}

// ─── the gate ────────────────────────────────────────────────────

// One prompt at a time: a share link opening three apps that all want the key
// on load must not stack three dialogs — everyone waiting shares the first
// one's answer.
let inflight: Promise<string | null> | null = null
// A refusal sticks for the page session, but only against passive reads: a
// napp asking who you are on load should not re-ask every time it polls.
// Anything behind a click in the napp (signing, publishing) always asks.
// Only "later" counts — a stray click on the backdrop is not an answer, and
// it would otherwise lock the prompt away with no logged-in account to
// disconnect from to get it back.
let refused = false

export interface AccountRequest {
  nappId: string
  // Completes "… wants to <what>".
  what: string
  // A read on load rather than something the user just clicked.
  passive?: boolean
}

// The pubkey, asking the user to log in if there isn't one. Null if they
// declined — callers report that rather than failing blank.
export function requireAccount(req: AccountRequest): Promise<string | null> {
  const pk = getPubkey()
  if (pk) return Promise.resolve(pk)
  if (req.passive && refused) return Promise.resolve(null)
  if (inflight) return inflight
  inflight = promptLogin(req)
    .then(({ pubkey, remember }) => {
      if (remember) refused = true
      return pubkey
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// Forget a refusal. Logging out is a fresh start: an app told "later" under
// the old account gets to ask again.
export function resetRefusal() {
  refused = false
}

// `remember` separates a decision from a dismissal: "later" is an answer and
// silences the passive asks, Esc or a click on the backdrop is not.
interface LoginAnswer {
  pubkey: string | null
  remember: boolean
}

function promptLogin(req: AccountRequest): Promise<LoginAnswer> {
  return openDialog<LoginAnswer>({
    title: "Log in",
    dismissValue: { pubkey: null, remember: false },
    class: "login-dialog",
    build: resolve => {
      const wrap = document.createElement("div")
      const line = document.createElement("p")
      line.append(nappNameEl(req.nappId), ` wants to ${req.what}, and no key is connected yet.`)
      wrap.appendChild(line)
      wrap.appendChild(loginControls({ onDone: pk => resolve({ pubkey: pk, remember: false }) }))
      const actions = document.createElement("div")
      actions.className = "login-dialog-actions"
      actions.appendChild(
        button({
          label: "later",
          variant: "outline",
          onClick: () => resolve({ pubkey: null, remember: true })
        })
      )
      wrap.appendChild(actions)
      return wrap
    }
  })
}
