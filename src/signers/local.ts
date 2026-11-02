import { EventTemplate, VerifiedEvent, finalizeEvent, getPublicKey } from "@nostr/tools/pure"
import { cachedPublicKey } from "../account.js"
import { decode } from "@nostr/tools/nip19"
import { decrypt as nip49Decrypt } from "@nostr/tools/nip49"
import * as nip04 from "@nostr/tools/nip04"
import * as nip44 from "@nostr/tools/nip44"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { openDialog } from "../dialog.js"
import { button, input } from "../system-napps/ui.js"

// A secret key pasted straight into the launcher. Stored as given: a plain
// key (hex or nsec) as hex, an ncryptsec as the ncryptsec — the password is
// never stored, so an encrypted key is asked for once per tab, the first time
// something needs it, and then kept in memory until the tab goes away.
const KEY_KEY = "nostrapps:local:key"

let unlocked: Uint8Array | null = null

function stored(): string | null {
  return localStorage.getItem(KEY_KEY)
}

export function hasStoredKey() {
  return !!stored()
}

// Hex, nsec or ncryptsec in; what to store out, plus the decrypted key when
// it is already at hand (always, except for an ncryptsec).
function parseKeyInput(raw: string): { store: string; secret: Uint8Array | null } {
  const s = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return { store: s.toLowerCase(), secret: hexToBytes(s) }
  if (s.startsWith("nsec1")) {
    const d = decode(s)
    if (d.type !== "nsec") throw new Error("Invalid nsec")
    return { store: bytesToHex(d.data), secret: d.data }
  }
  if (s.startsWith("ncryptsec1")) return { store: s, secret: null }
  throw new Error("Paste a hex key, an nsec or an ncryptsec.")
}

export function isEncryptedKey(raw: string) {
  return raw.trim().startsWith("ncryptsec1")
}

// Store the key and return its pubkey. An ncryptsec is decrypted here too —
// there is no pubkey without it — so the password given at login also unlocks
// this tab. It comes from the login form rather than askPassword(): the login
// prompt a napp raises is itself a dialog, and a second one would queue
// behind it forever.
export function loginLocalKey(raw: string, password = ""): string {
  const { store, secret } = parseKeyInput(raw)
  let sk = secret
  if (!sk) {
    try {
      sk = nip49Decrypt(store, password)
    } catch {
      throw new Error("Wrong password")
    }
  }
  localStorage.setItem(KEY_KEY, store)
  unlocked = sk
  return getPublicKey(sk)
}

export function forgetLocalKey() {
  localStorage.removeItem(KEY_KEY)
  unlocked = null
}

// One password prompt at a time: a burst of signing requests all wait on the
// same answer.
let inflight: Promise<Uint8Array> | null = null

async function secretKey(): Promise<Uint8Array> {
  if (unlocked) return unlocked
  const s = stored()
  if (!s) throw new Error("No key stored")
  if (!s.startsWith("ncryptsec1")) return (unlocked = hexToBytes(s))
  if (inflight) return inflight
  inflight = askPassword(s)
    .then(sk => {
      if (!sk) throw new Error("Key is locked")
      return (unlocked = sk)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// The decrypted key, or null if the user dismissed the prompt. A wrong
// password keeps the dialog open with the error under the field.
function askPassword(ncryptsec: string): Promise<Uint8Array | null> {
  return openDialog<Uint8Array | null>({
    title: "Unlock key",
    queue: { kind: "unlock key" },
    dismissValue: null,
    class: "login-dialog",
    build: resolve => {
      const form = document.createElement("form")
      form.className = "login-bunker-form"
      const line = document.createElement("p")
      line.textContent = "Your key is encrypted. Type its password to use it in this tab."
      const pw = input({
        type: "password",
        placeholder: "password",
        autocomplete: "current-password"
      })
      pw.autofocus = true
      const error = document.createElement("div")
      error.className = "login-error"
      error.hidden = true
      const submit = button({ label: "unlock", type: "submit", variant: "primary" })
      const cancel = button({ label: "cancel", onClick: () => resolve(null) })
      const actions = document.createElement("div")
      actions.className = "login-bunker-actions"
      actions.append(submit, cancel)
      form.append(line, pw, actions, error)
      form.addEventListener("submit", async e => {
        e.preventDefault()
        error.hidden = true
        submit.disabled = true
        submit.textContent = "unlocking…"
        // scrypt blocks the thread; let the label paint first.
        await new Promise(r => setTimeout(r, 20))
        try {
          resolve(nip49Decrypt(ncryptsec, pw.value))
        } catch {
          error.textContent = "Wrong password"
          error.hidden = false
          pw.select()
        } finally {
          submit.disabled = false
          submit.textContent = "unlock"
        }
      })
      return form
    }
  })
}

// Standard signer shape (matches nip07Signer). The pubkey comes from the
// account, so asking for it never needs the password.
export const localSigner = {
  getPublicKey() {
    return cachedPublicKey(async () => getPublicKey(await secretKey()))
  },
  async signEvent(evt: EventTemplate): Promise<VerifiedEvent> {
    return finalizeEvent(evt, await secretKey())
  },
  nip04: {
    async encrypt(pubkey: string, plaintext: string) {
      return nip04.encrypt(await secretKey(), pubkey, plaintext)
    },
    async decrypt(pubkey: string, ciphertext: string) {
      return nip04.decrypt(await secretKey(), pubkey, ciphertext)
    }
  },
  nip44: {
    async encrypt(pubkey: string, plaintext: string) {
      return nip44.encrypt(plaintext, nip44.getConversationKey(await secretKey(), pubkey))
    },
    async decrypt(pubkey: string, ciphertext: string) {
      return nip44.decrypt(ciphertext, nip44.getConversationKey(await secretKey(), pubkey))
    }
  }
}
