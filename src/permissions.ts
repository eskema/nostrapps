const STORAGE_KEY = "nostrapps:permissions"

const GATED_METHODS = new Set([
  "signEvent",
  "nip04.encrypt",
  "nip04.decrypt",
  "nip44.encrypt",
  "nip44.decrypt",
  "pool.publish",
  "pool.setRelays"
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

let dialogEl: HTMLDialogElement | null
let promptChain: Promise<void> = Promise.resolve()

export function mountDialog(dialog: HTMLDialogElement | null) {
  dialogEl = dialog
}

export async function requireApproval(nappId: string, method: string) {
  const cached = getDecision(nappId, method)
  if (cached === "allow") return true
  if (cached === "deny") return false

  const decision = await prompt(nappId, method)
  if (decision === "allow-always") setDecision(nappId, method, "allow")
  if (decision === "deny-always") setDecision(nappId, method, "deny")
  return decision === "allow-once" || decision === "allow-always"
}

function prompt(nappId: string, method: string): Promise<string> {
  const next: Promise<string> = promptChain.then(() => showOne(nappId, method))
  promptChain = next.catch(() => {}) as Promise<void>
  return next
}

function showOne(nappId: string, method: string): Promise<string> {
  const el = dialogEl
  if (!el) return Promise.resolve("deny-once")
  return new Promise(resolve => {
    el.querySelector("[data-perm-nappid]")!.textContent = nappId
    el.querySelector("[data-perm-method]")!.textContent = method
    el.returnValue = ""
    el.showModal()
    const onClose = () => {
      el.removeEventListener("close", onClose)
      resolve(el.returnValue || "deny-once")
    }
    el.addEventListener("close", onClose)
  })
}
