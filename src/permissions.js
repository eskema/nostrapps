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

export function isGated(method) {
  return GATED_METHODS.has(method)
}

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
  } catch {
    return {}
  }
}

function writeAll(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function getDecision(nappId, method) {
  return readAll()[nappId]?.[method] ?? null
}

export function setDecision(nappId, method, decision) {
  const all = readAll()
  all[nappId] ??= {}
  all[nappId][method] = decision
  writeAll(all)
  notify()
}

export function clearDecisions(nappId) {
  const all = readAll()
  delete all[nappId]
  writeAll(all)
  notify()
}

export function listDecisions() {
  return readAll()
}

export function forgetDecision(nappId, method) {
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

const subscribers = new Set()

function notify() {
  for (const fn of subscribers) {
    try {
      fn()
    } catch {}
  }
}

export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

let dialogEl
let promptChain = Promise.resolve()

export function mountDialog(dialog) {
  dialogEl = dialog
}

export async function requireApproval(nappId, method) {
  const cached = getDecision(nappId, method)
  if (cached === "allow") return true
  if (cached === "deny") return false

  const decision = await prompt(nappId, method)
  if (decision === "allow-always") setDecision(nappId, method, "allow")
  if (decision === "deny-always") setDecision(nappId, method, "deny")
  return decision === "allow-once" || decision === "allow-always"
}

function prompt(nappId, method) {
  const next = promptChain.then(() => showOne(nappId, method))
  promptChain = next.catch(() => {})
  return next
}

function showOne(nappId, method) {
  if (!dialogEl) return Promise.resolve("deny-once")
  return new Promise(resolve => {
    dialogEl.querySelector("[data-perm-nappid]").textContent = nappId
    dialogEl.querySelector("[data-perm-method]").textContent = method
    dialogEl.returnValue = ""
    dialogEl.showModal()
    const onClose = () => {
      dialogEl.removeEventListener("close", onClose)
      resolve(dialogEl.returnValue || "deny-once")
    }
    dialogEl.addEventListener("close", onClose)
  })
}
