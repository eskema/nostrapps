import { openDialog } from "./dialog.js"
import { nappNameEl } from "./napp-name.js"

const STORAGE_KEY = "nostrapps:permissions"

const GATED_METHODS = new Set([
  "signEvent",
  "nip04.encrypt",
  "nip04.decrypt",
  "nip44.encrypt",
  "nip44.decrypt",
  // Writing to the user's disk. Napp iframes have no `allow-downloads`, so this
  // rpc is the only route out — which is what makes it gateable at all.
  "napp.saveFile",
  // Writing to the user's clipboard. The sandbox has no `clipboard-write`
  // delegation, so like saveFile this rpc is the only route — the prompt can
  // show what is actually about to land on the clipboard.
  "napp.copyText",
  // Publishing a finished (signed) event. The prompt shows the event summary
  // and the relays it will be published to.
  "napp.publish"
])

export function isGated(method: string) {
  return GATED_METHODS.has(method)
}

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, any>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function getDecision(nappId: string, method: string) {
  return readAll()[nappId]?.[method] ?? null
}

export function setDecision(nappId: string, method: string, decision: string) {
  const all = readAll()
  all[nappId] ??= {}
  all[nappId][method] = decision
  writeAll(all)
  notify()
}

export function clearDecisions(nappId: string) {
  const all = readAll()
  delete all[nappId]
  writeAll(all)
  notify()
}

export function listDecisions() {
  return readAll()
}

// Drop every napp's decisions at once (settings' "forget all"). One write, one
// notify — not a forget per napp.
export function forgetAllDecisions() {
  if (Object.keys(readAll()).length === 0) return
  writeAll({})
  notify()
}

export function forgetDecision(nappId: string, method?: string) {
  const all = readAll()
  if (!all[nappId]) return
  if (method) {
    delete all[nappId][method]
    if (Object.keys(all[nappId]).length === 0) delete all[nappId]
  } else {
    delete all[nappId]
  }
  writeAll(all)
  notify()
}

const subscribers = new Set<() => void>()

function notify() {
  for (const fn of subscribers) {
    try {
      fn()
    } catch {}
  }
}

export function subscribe(fn: () => void) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

// A detail can be a plain sentence, a sentence plus a `code` payload — the
// payload renders as a wrapping code block, matching the <code> chips the rest
// of the dialog uses (a url or key would otherwise overflow the card) — or a
// prebuilt node for richer layouts (event previews, relay lists).
export type ApprovalDetail = string | { text: string; code?: string } | Node

// ─── asking, with limits ─────────────────────────────────────────
// One prompt per napp and method at a time: a napp calling in a loop would
// otherwise queue a dialog per call behind a modal that blocks the launcher.
// The rest wait in a line of their own, each still for its own answer ("allow
// once" for one event is no answer for the next); an "always" answer settles
// the whole line. Beyond LINE_MAX waiting, and for a short while after a
// denial (Esc included), requests are refused without asking.
const LINE_MAX = 20
const DENY_COOLDOWN_MS = 10_000
const lines = new Map<string, Promise<void>>() // key → the line's tail
const waiting = new Map<string, number>() // key → requests in the line, asking one included
const deniedAt = new Map<string, number>()
const generation = new Map<string, number>() // nappId → bumped when it goes away

const lineKey = (nappId: string, method: string) => `${nappId}\u0000${method}`
const coolingDown = (key: string) => Date.now() - (deniedAt.get(key) ?? 0) < DENY_COOLDOWN_MS

// Whether a request would be refused without a prompt: callers check this
// before any work that only a prompt needs (a publish looks up relays).
export function wouldRefuse(nappId: string, method: string): boolean {
  const cached = getDecision(nappId, method)
  if (cached) return cached === "deny"
  const key = lineKey(nappId, method)
  return coolingDown(key) || (waiting.get(key) ?? 0) >= LINE_MAX
}

// The napp's last window closed: what it still has waiting is refused (a
// dialog already on screen stays, its answer goes nowhere).
export function cancelApprovals(nappId: string) {
  generation.set(nappId, (generation.get(nappId) ?? 0) + 1)
}

export async function requireApproval(nappId: string, method: string, detail?: ApprovalDetail) {
  const cached = getDecision(nappId, method)
  if (cached === "allow") return true
  if (cached === "deny") return false
  const key = lineKey(nappId, method)
  if (coolingDown(key)) return false
  const ahead = waiting.get(key) ?? 0
  if (ahead >= LINE_MAX) return false
  waiting.set(key, ahead + 1)

  const gen = generation.get(nappId) ?? 0
  const prev = lines.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = prev.then(() => new Promise<void>(r => (release = r)))
  lines.set(key, tail)
  try {
    await prev
    // What changed while waiting: the napp gone, an "always", a denial.
    if ((generation.get(nappId) ?? 0) !== gen) return false
    const now = getDecision(nappId, method)
    if (now === "allow") return true
    if (now === "deny" || coolingDown(key)) return false

    const decision = await openDialog<string>({
      title: "Permission request",
      queue: { kind: "permission", name: nappNameEl(nappId), type: method },
      body: permissionBody(nappId, method, detail),
      actions: [
        { label: "Deny always", value: "deny-always", variant: "outline" },
        { label: "Deny", value: "deny-once", variant: "outline" },
        { label: "Allow once", value: "allow-once", variant: "primary" },
        { label: "Allow always", value: "allow-always", variant: "primary", autofocus: true }
      ],
      dismissValue: "deny-once" // Esc / backdrop → deny
    })
    if (decision === "allow-always") setDecision(nappId, method, "allow")
    if (decision === "deny-always") setDecision(nappId, method, "deny")
    if (decision === "deny-once") deniedAt.set(key, Date.now())
    return decision === "allow-once" || decision === "allow-always"
  } finally {
    release?.()
    const left = (waiting.get(key) ?? 1) - 1
    if (left > 0) waiting.set(key, left)
    else {
      waiting.delete(key)
      if (lines.get(key) === tail) lines.delete(key)
    }
  }
}

function permissionBody(nappId: string, method: string, detail?: ApprovalDetail): Node {
  const wrap = document.createElement("div")
  const p = document.createElement("p")
  const meth = document.createElement("code")
  meth.textContent = method
  p.append(nappNameEl(nappId), " wants to use ", meth)
  wrap.appendChild(p)
  // Some methods can say what they are actually about to do — a filename is a
  // far better basis for a decision than a method name.
  if (detail) {
    if (detail instanceof Node) {
      wrap.appendChild(detail)
    } else {
      const d = document.createElement("p")
      d.textContent = typeof detail === "string" ? detail : detail.text
      wrap.appendChild(d)
      if (typeof detail !== "string" && detail.code) {
        const c = document.createElement("code")
        c.className = "app-dialog-detail-code"
        c.textContent = detail.code
        wrap.appendChild(c)
      }
    }
  }
  return wrap
}
