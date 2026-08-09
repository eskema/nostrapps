import { openDialog } from "./dialog.js"

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
  "napp.copyText"
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

// A detail can be a plain sentence, or a sentence plus a `code` payload — the
// payload renders as a wrapping code block, matching the <code> chips the rest
// of the dialog uses (a url or key would otherwise overflow the card).
export type ApprovalDetail = string | { text: string; code?: string }

export async function requireApproval(nappId: string, method: string, detail?: ApprovalDetail) {
  const cached = getDecision(nappId, method)
  if (cached === "allow") return true
  if (cached === "deny") return false

  const decision = await openDialog<string>({
    title: "Permission request",
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
  return decision === "allow-once" || decision === "allow-always"
}

function permissionBody(nappId: string, method: string, detail?: ApprovalDetail): Node {
  const wrap = document.createElement("div")
  const p = document.createElement("p")
  const napp = document.createElement("code")
  napp.textContent = nappId
  const meth = document.createElement("code")
  meth.textContent = method
  p.append("Napp ", napp, " wants to use ", meth)
  wrap.appendChild(p)
  // Some methods can say what they are actually about to do — a filename is a
  // far better basis for a decision than a method name.
  if (detail) {
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
  return wrap
}
