// Relay authentication policy — how the pool answers NIP-42 AUTH challenges.
//
// Two layers, both persisted in localStorage (and thus wiped by factory reset
// along with every other `nostrapps:*` key):
//   • the global "automatically authenticate with relays" switch. When on,
//     every challenge is answered without asking.
//   • per-relay decisions ("allow" / "deny") remembered from the confirmation
//     toasts shown when the switch is off. The next challenge from a relay with
//     a stored decision is answered (or refused) without prompting again.
//
// With no setting and no stored decision, a toast pops up and the AUTH answer
// waits for the user's choice — so nothing is signed until they say so.

import { normalizeURL } from "@nostr/tools/utils"
import { openToast } from "./toast.js"

const AUTO_KEY = "nostrapps:auto-auth"
const DECISIONS_KEY = "nostrapps:relay-auth"

type Decision = "allow" | "deny"

// ─── persisted state ─────────────────────────────────────────────

export function automaticallyAuthOn(): boolean {
  return localStorage.getItem(AUTO_KEY) === "1"
}

export function setAutomaticallyAuth(on: boolean) {
  if (on) localStorage.setItem(AUTO_KEY, "1")
  else localStorage.removeItem(AUTO_KEY)
  notify()
}

function readDecisions(): Record<string, Decision> {
  try {
    const raw = JSON.parse(localStorage.getItem(DECISIONS_KEY) || "{}")
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

function writeDecisions(all: Record<string, Decision>) {
  localStorage.setItem(DECISIONS_KEY, JSON.stringify(all))
}

export function listRelayDecisions(): Array<{ url: string; decision: Decision }> {
  return Object.entries(readDecisions()).map(([url, decision]) => ({
    url,
    decision: decision === "deny" ? "deny" : "allow"
  }))
}

export function getRelayDecision(url: string): Decision | undefined {
  const d = readDecisions()[normalizeURL(url)]
  return d === "deny" ? "deny" : d === "allow" ? "allow" : undefined
}

export function rememberRelayDecision(url: string, allow: boolean) {
  const key = normalizeURL(url)
  const all = readDecisions()
  all[key] = allow ? "allow" : "deny"
  writeDecisions(all)
  notify()
}

export function forgetRelayDecision(url: string) {
  const key = normalizeURL(url)
  const all = readDecisions()
  if (!(key in all)) return
  delete all[key]
  writeDecisions(all)
  notify()
}

// ─── subscribers (Settings UI refreshes) ─────────────────────────

const subs = new Set<() => void>()

export function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

function notify() {
  for (const fn of subs) {
    try {
      fn()
    } catch {}
  }
}

// ─── the confirmation toast ──────────────────────────────────────
// Non-modal (a challenge isn't user-initiated), grouped so a burst of relays
// challenging at once can be answered in one click.

function askRelayAuth(url: string): Promise<boolean> {
  return openToast<boolean>({
    title: "This relay asks for authentication.",
    code: url,
    hint: "Your choice is remembered for this relay.",
    actions: [
      { label: "deny", value: false, variant: "outline" },
      { label: "allow", value: true, variant: "primary" }
    ],
    group: {
      key: "relay-auth",
      label: n => `${n} relays asking`,
      actions: [
        { label: "deny all", value: false, variant: "outline" },
        { label: "allow all", value: true, variant: "primary" }
      ]
    }
  })
}

// Dedupe concurrent challenges from the same relay onto one open prompt —
// otherwise a burst of AUTHs stacks identical toasts.
const pendingPrompts = new Map<string, Promise<boolean>>()

function promptRelayAuth(url: string): Promise<boolean> {
  const existing = pendingPrompts.get(url)
  if (existing) return existing
  const p = askRelayAuth(url).then(ok => {
    rememberRelayDecision(url, ok)
    pendingPrompts.delete(url)
    return ok
  })
  pendingPrompts.set(url, p)
  return p
}

// ─── the decision entry point ────────────────────────────────────
// Called by pool.automaticallyAuth's signer wrapper when a relay challenges.
// Resolves true → sign the auth event; false → refuse.

export async function authorizeRelay(url: string): Promise<boolean> {
  if (automaticallyAuthOn()) return true
  const key = normalizeURL(url)
  const stored = readDecisions()[key]
  if (stored === "allow") return true
  if (stored === "deny") return false
  return promptRelayAuth(key)
}
