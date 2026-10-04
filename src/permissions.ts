import { openDialog, type DialogAction } from "./dialog.js"
import { nappByline, nappName, nappNameEl, type NappName } from "./napp-name.js"
import { getInstalledApp } from "./persistence.js"
import { appIcon, code, el, overline } from "./system-napps/ui.js"

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
      body: permissionBody(nappName(nappId), method, detail, nappIcon(nappId)),
      class: "app-dialog-permission",
      actions: PERMISSION_ACTIONS,
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

// Two columns, read in rows: deny | allow, then deny always | allow always.
export const PERMISSION_ACTIONS: DialogAction<string>[] = [
  { label: "Deny", value: "deny-once", variant: "outline" },
  { label: "Allow", value: "allow-once", variant: "primary", autofocus: true },
  { label: "Deny always", value: "deny-always", variant: "link" },
  { label: "Allow always", value: "allow-always", variant: "link" }
]

// How Settings names a remembered decision: the prompt's verb, then what
// tells apart the methods sharing it, and what the grant covers ("sign any
// event": an always for signEvent is one for every kind).
const DECISION_WORDS: Record<string, string> = {
  signEvent: "any event",
  "napp.publish": "events",
  "relay.publish": "events",
  "relay.publishEncrypted": "encrypted events",
  "outbox.publish": "events to outboxes",
  "napp.saveFile": "files",
  "napp.copyText": "to clipboard",
  "link.open": "links",
  "common.follow": "people",
  "common.unfollow": "people"
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
  "common.report": "report"
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
  let object: Node | string | undefined = verb ? undefined : code(method)
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
  return wrap
}
