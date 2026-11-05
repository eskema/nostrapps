import { openDialog, type DialogAction } from "./dialog.js"
import { nappByline, nappName, nappNameEl, type NappName } from "./napp-name.js"
import { getInstalledApp, getPolicy, setPolicy } from "./persistence.js"
import { appIcon, author, code, el, overline } from "./system-napps/ui.js"
import { getPubkey, subscribe as onAccountChanged } from "./account.js"

const STORAGE_KEY = "nostrapps:permissions"

// Install rows control domain access. Napplet operations have separate,
// account-scoped decisions. Napps retain their row-level ask/allow behavior.
const ROW_OF: Record<string, string> = {
  signEvent: "write",
  "napp.publish": "write",
  "nip04.encrypt": "encrypt",
  "nip44.encrypt": "encrypt",
  "nip04.decrypt": "decrypt",
  "nip44.decrypt": "decrypt",
  "relay.publish": "relay",
  "relay.publishEncrypted": "relay",
  "outbox.publish": "outbox",
  "common.react": "common",
  "common.report": "common",
  "common.follow": "common",
  "common.unfollow": "common",
  "link.open": "link",
  "resource.https": "resource",
  "resource.blossom": "resource",
  "resource.http": "resource",
  "relay.read": "relay",
  "outbox.read": "outbox"
}

// The rows that have an ask box.
export const ASKABLE = new Set(Object.values(ROW_OF))

const holds = (nappId: string, row: string) => getPolicy(nappId).domains.includes(row)
const asks = (nappId: string, row: string) => !!getPolicy(nappId).ask?.includes(row)

// What answers a request without a prompt: its row, or a decision kept for a
// method with none. Null: ask.
const isNapplet = (id: string) => id.startsWith("napplet~")
const account = () => getPubkey() || "signed-out"
const decisionKey = (id: string) => (isNapplet(id) ? JSON.stringify([account(), id]) : id)
const sessions = new Map<string, Record<string, string>>()

function settled(nappId: string, method: string): boolean | null {
  const row = ROW_OF[method]
  if (row && !holds(nappId, row)) return false
  if (isNapplet(nappId)) {
    const cached = getDecision(nappId, method)
    if (cached) return cached === "allow" || cached === "session"
    if (row) return asks(nappId, row) ? null : true
    return null
  }
  if (row) return asks(nappId, row) ? null : true
  const cached = getDecision(nappId, method)
  return cached ? cached === "allow" : null
}

// A napp prompt's "always" updates the install row. Napplets remember
// individual operations for the current account instead.
function answerRow(nappId: string, row: string, allow: boolean) {
  const p = getPolicy(nappId)
  setPolicy(nappId, {
    domains: allow ? p.domains : p.domains.filter(d => d !== row),
    ask: (p.ask ?? []).filter(d => d !== row)
  })
  if (!allow) revoked(nappId)
  notify()
}

// Who carries an unticked row to the napp's origin (its window.nostr).
let revoked: (nappId: string) => void = () => {}
export function onRowRevoked(fn: (nappId: string) => void) {
  revoked = fn
}

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
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, any>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function getDecision(nappId: string, method: string) {
  const key = decisionKey(nappId)
  if (sessions.get(key)?.[method] === "session") return "session"
  const saved = readAll()[key]?.[method]
  return saved === "allow" || saved === "deny" ? saved : null
}

export function setDecision(nappId: string, method: string, decision: string) {
  if (decision !== "allow" && decision !== "deny") return
  const all = readAll()
  const key = decisionKey(nappId)
  if (!all[key] || typeof all[key] !== "object" || Array.isArray(all[key])) all[key] = {}
  all[key][method] = decision
  delete sessions.get(key)?.[method]
  writeAll(all)
  notify()
}

export function clearDecisions(nappId: string) {
  const all = readAll()
  delete all[nappId]
  for (const key of Object.keys(all)) {
    try {
      if (JSON.parse(key)?.[1] === nappId) delete all[key]
    } catch {}
  }
  for (const key of sessions.keys()) {
    try {
      if (JSON.parse(key)?.[1] === nappId) sessions.delete(key)
    } catch {}
  }
  cancelApprovals(nappId)
  writeAll(all)
  notify()
}

// Settings shows the current account's napplet decisions and session grants.
// Napp decisions represented by install rows remain hidden here.
export function listDecisions(includeSession = true): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const all = { ...readAll() }
  if (includeSession) for (const [key, methods] of sessions) all[key] = { ...all[key], ...methods }
  for (const [key, methods] of Object.entries(all)) {
    let id = key
    if (key.startsWith("[")) {
      try {
        const [owner, app] = JSON.parse(key)
        if (owner !== account() || typeof app !== "string" || !isNapplet(app)) continue
        id = app
      } catch {
        continue
      }
    } else if (isNapplet(id)) continue // Old approvals were not account-scoped.
    if (!methods || typeof methods !== "object" || Array.isArray(methods)) continue
    const kept = Object.entries(methods).filter(
      ([m, d]) =>
        (isNapplet(id) || !(m in ROW_OF)) && ["allow", "deny", "session"].includes(String(d))
    )
    if (kept.length) out[id] = Object.fromEntries(kept) as Record<string, string>
  }
  return out
}

// Forget approvals for the current account; other accounts keep their choices.
export function forgetAllDecisions() {
  for (const id of Object.keys(listDecisions())) forgetDecision(id)
}

export function forgetDecision(nappId: string, method?: string) {
  const all = readAll()
  const key = decisionKey(nappId)
  if (method) {
    if (all[key]) delete all[key][method]
    delete sessions.get(key)?.[method]
  } else {
    delete all[key]
    sessions.delete(key)
  }
  cancelApprovals(nappId)
  window.dispatchEvent(
    new CustomEvent("nostrapps:permission-revoked", { detail: { nappId, method } })
  )
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

// A detail goes on from "<napp> wants to <verb>": a plain sentence; a prebuilt
// node for richer layouts (folds, relay rows), a fragment's children each a
// row; or the parts of a sentence: what the verb acts on, to go after it
// ("wants to sign a note"), a line going on from that, and rows under it all.
export type ApprovalDetail = string | { object?: string | Node; line?: Node; body?: Node } | Node

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
const approvalControllers = new Map<string, AbortController>()
const generation = new Map<string, number>() // nappId → bumped when it goes away

const lineKey = (nappId: string, method: string) => `${nappId}\u0000${method}`
const coolingDown = (key: string) => Date.now() - (deniedAt.get(key) ?? 0) < DENY_COOLDOWN_MS

// Whether a request would be refused without a prompt: callers check this
// before any work that only a prompt needs (a publish looks up relays).
export function wouldRefuse(nappId: string, method: string): boolean {
  const answer = settled(nappId, method)
  if (answer !== null) return !answer
  const key = lineKey(nappId, method)
  return coolingDown(key) || (waiting.get(key) ?? 0) >= LINE_MAX
}

// Whether the row answers a request on its own, so no prompt and no details
// to build for one.
export function coveredByGrant(nappId: string, method: string): boolean {
  return settled(nappId, method) === true
}

// Closing the last window cancels both visible and queued approvals.
export function cancelApprovals(nappId: string) {
  generation.set(nappId, (generation.get(nappId) ?? 0) + 1)
  approvalControllers.get(nappId)?.abort()
  approvalControllers.delete(nappId)
}

export async function requireApproval(
  nappId: string,
  method: string,
  detail?: ApprovalDetail,
  options?: { signal?: AbortSignal }
) {
  if (options?.signal?.aborted) return false
  const owner = account()
  let controller = approvalControllers.get(nappId)
  if (!controller) approvalControllers.set(nappId, (controller = new AbortController()))
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const valid = () => !signal.aborted && owner === account()
  const answer = settled(nappId, method)
  if (answer !== null) return answer
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
    if (!valid() || (generation.get(nappId) ?? 0) !== gen) return false
    const now = settled(nappId, method)
    if (now !== null) return now
    if (coolingDown(key)) return false

    const decision = await openDialog<string>({
      signal,
      title: "Permission request",
      queue: { kind: "permission", name: nappNameEl(nappId), type: method },
      body: permissionBody(nappName(nappId), method, detail, nappIcon(nappId)),
      class: isNapplet(nappId)
        ? "app-dialog-permission app-dialog-napplet-permission"
        : "app-dialog-permission",
      actions: isNapplet(nappId) ? NAPPLET_PERMISSION_ACTIONS : PERMISSION_ACTIONS,
      dismissValue: "deny-once" // Esc / backdrop → deny
    })
    // A dismissed or revoked request must never save a stale approval.
    if (!valid() || (generation.get(nappId) ?? 0) !== gen) return false
    if (ROW_OF[method] && !holds(nappId, ROW_OF[method])) return false
    const row = ROW_OF[method]
    if (decision === "allow-session" && isNapplet(nappId)) {
      const key = decisionKey(nappId)
      sessions.set(key, { ...sessions.get(key), [method]: "session" })
      notify()
    }
    if (decision === "allow-always" || decision === "deny-always") {
      const allow = decision === "allow-always"
      if (row && !isNapplet(nappId)) answerRow(nappId, row, allow)
      else setDecision(nappId, method, allow ? "allow" : "deny")
    }
    if (decision === "deny-once") deniedAt.set(key, Date.now())
    return decision === "allow-once" || decision === "allow-always" || decision === "allow-session"
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

// Two columns, read in rows: deny | allow, then deny always | allow always.
export const PERMISSION_ACTIONS: DialogAction<string>[] = [
  { label: "Deny", value: "deny-once", variant: "outline" },
  { label: "Allow", value: "allow-once", variant: "primary", autofocus: true },
  { label: "Deny always", value: "deny-always", variant: "link" },
  { label: "Allow always", value: "allow-always", variant: "link" }
]

const NAPPLET_PERMISSION_ACTIONS: DialogAction<string>[] = [
  ...PERMISSION_ACTIONS.slice(0, 2),
  { label: "Allow for this session", value: "allow-session", variant: "outline" },
  ...PERMISSION_ACTIONS.slice(2)
]

let permissionAccount = account()
onAccountChanged(() => {
  const next = account()
  if (next === permissionAccount) return
  permissionAccount = next
  for (const id of approvalControllers.keys()) cancelApprovals(id)
  sessions.clear()
  deniedAt.clear()
  notify()
})
window.addEventListener("storage", event => {
  if (
    event.key === STORAGE_KEY ||
    event.key === "nostrapps:policy" ||
    event.key === "nostrapps:pubkey" ||
    event.key === null
  ) {
    for (const id of approvalControllers.keys()) cancelApprovals(id)
    sessions.clear()
    notify()
  }
})
window.addEventListener("nostrapps:policy-changed", event => {
  const id = (event as CustomEvent<string>).detail
  cancelApprovals(id)
  sessions.delete(decisionKey(id))
  notify()
})

// How Settings names a remembered decision: the prompt's verb, then what
// tells apart the methods sharing it, and what the grant covers.
const DECISION_WORDS: Record<string, string> = {
  signEvent: "events",
  "napp.publish": "events",
  "relay.publish": "events",
  "relay.publishEncrypted": "encrypted events",
  "outbox.publish": "events to outboxes",
  "napp.saveFile": "files",
  "napp.copyText": "to clipboard",
  "link.open": "links",
  "common.follow": "people",
  "common.unfollow": "people",
  "resource.https": "HTTPS resources",
  "resource.http": "HTTP resources",
  "resource.blossom": "Blossom resources",
  "relay.read": "events from relays",
  "outbox.read": "events from author relays"
}

export function decisionLabel(method: string): HTMLElement {
  const verb = VERBS[method]
  const label = el("span", "", el("span", "ui-title", verb || "use"))
  const words = verb ? DECISION_WORDS[method] : undefined
  if (words) label.append(" ", words)
  if (!verb) label.append(" ", code(method))
  const nip = /^nip(04|44)\./.exec(method)
  if (nip) label.append(" ", overline(`NIP-${nip[1]}`))
  return label
}

// What each method is asking to do, as the verb of "<napp> wants to <verb>".
const VERBS: Record<string, string> = {
  signEvent: "sign",
  "napp.publish": "publish",
  "relay.publish": "publish",
  "relay.publishEncrypted": "publish",
  "outbox.publish": "publish",
  "nip04.encrypt": "encrypt",
  "nip44.encrypt": "encrypt",
  "nip04.decrypt": "decrypt",
  "nip44.decrypt": "decrypt",
  "napp.saveFile": "save",
  "napp.copyText": "copy",
  "link.open": "open",
  "common.follow": "follow",
  "common.unfollow": "unfollow",
  "common.react": "react",
  "common.report": "report",
  "resource.https": "read",
  "resource.http": "read",
  "resource.blossom": "read",
  "relay.read": "read",
  "outbox.read": "read"
}

// The napp's icon before its name: a plate holding the place, then the first
// of its sources that loads. None loading, it drops out. Its sources are
// looked up lazily: nsite/icon.ts reaches into the host, which imports this.
export function nappIcon(nappId: string): HTMLElement | undefined {
  const app = getInstalledApp(nappId)
  if (!app) return undefined
  const icon = appIcon({ size: "s", fade: true })
  import("./nsite/icon.js")
    .then(m => m.installedIconSources(app))
    .then(srcs => {
      // A blossom server can sit on a request for a missing blob without ever
      // answering (the <img> fires neither load nor error): past this long the
      // next source is asked; the last is waited on.
      let i = 0
      let wait = 0
      const next = () => {
        window.clearTimeout(wait)
        if (i < srcs.length) {
          icon.img.src = srcs[i++]
          if (i < srcs.length) wait = window.setTimeout(next, 4000)
        } else icon.remove()
      }
      icon.img.addEventListener("error", next)
      icon.img.addEventListener("load", () => window.clearTimeout(wait))
      next()
    })
    .catch(() => icon.remove())
  return icon
}

// Who asks and what, the way an Apps card names an app: the icon in line with
// the title; "<type> from <author> wants to" under it, in the card's author
// line; then the ask a size up: the verb and what it acts on ("SIGN a note"),
// that kept whole on the line or wrapped whole to the next, and the sentence
// going on from it under them, at the text's size ("notifying <person>.").
// The rest of what it is about under that.
export function permissionBody(
  napp: Pick<NappName, "title" | "author" | "authorLabel" | "type">,
  method: string,
  detail?: ApprovalDetail,
  icon?: HTMLElement
): Node {
  const verb = VERBS[method]
  const ask = el("p", "permission-verb", el("span", "ui-title", verb || "use"))
  // Some methods can say what they are actually about to do — a filename is a
  // far better basis for a decision than a method name. What the verb acts on
  // goes on its line, the sentence going on from it on the next; anything
  // else goes under it all.
  let object: Node | string | undefined = verb ? DECISION_WORDS[method] : code(method)
  let line: Node | undefined
  let rest: Node | undefined
  if (typeof detail === "string") line = el("p", "", detail)
  else if (detail instanceof Node) rest = detail
  else if (detail) {
    object = detail.object ?? object
    line = detail.line
    rest = detail.body
  }
  const named = el("div", "permission-name", ...(icon ? [icon] : []), el("strong", "", napp.title))
  const from = nappByline(napp)
  from.meta(" wants to")
  if (object) ask.append(" ", el("span", "permission-object", object))
  const said = el("div", "permission-ask", ask, ...(line ? [line] : []))
  const wrap = el("div", "permission", el("div", "permission-head", named, from, said))
  if (rest) wrap.append(rest)
  if (napp.type === "napplet") {
    const pk = getPubkey()
    wrap.append(
      el(
        "p",
        "napp-perms-reqs",
        ...(pk
          ? ["For ", author(pk, { link: false }), " on this device."]
          : ["For this signed-out session on this device."])
      )
    )
  }
  return wrap
}
