// What a permission prompt shows under "<napp> wants to <verb>": the payload a
// napp hands over, folded, and what can be read off it. Built here, without
// the host, so mocks/permissions.html can lay every prompt out at once.
import { aKind, eventFacts } from "./event-facts.js"
import { kindName } from "./kind-names.js"
import { permRow } from "./napp-permissions.js"
import {
  author as authorEl,
  check,
  code,
  codeBlock,
  details,
  el,
  overline
} from "./system-napps/ui.js"

// Text shown in a prompt's fold is cut here: past it a dialog would stall,
// and the summary still gives the full length.
const PREVIEW_MAX = 20_000
const preview = (text: string) =>
  text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text
const characters = (text: string) => `${text.length} character${text.length === 1 ? "" : "s"}`

// "nip44" → "NIP-44".
export function nipName(nip: string): string {
  return `NIP-${nip.slice(3)}`
}

// What is about to land on the clipboard: "copy to clipboard", then the text
// as it will paste, folded under its length.
export function describeCopyText(params: any): { object: string; body: Node } {
  const text = typeof params?.text === "string" ? params.text : ""
  return {
    object: "to clipboard",
    body: details(
      { fold: true, class: "app-dialog-fold", summary: characters(text) },
      codeBlock(preview(text), "app-dialog-detail-code")
    )
  }
}

// nip04/nip44 encrypt and decrypt: who it is with after the verb, then the
// text folded under its length, the NIP at the summary's end. Encrypting, the
// text is what will be encrypted, for whom; decrypting, the ciphertext, and
// only whose conversation it is: the call carries the other side's key and
// nothing that says which way the message went. With your own key (private
// lists, app data) it says yourself.
export function describeCipher(
  method: string,
  params: any,
  me: string | null
): { object?: Node; body: Node } {
  const decrypt = method.endsWith(".decrypt")
  const peer =
    typeof params?.pubkey === "string" && /^[0-9a-f]{64}$/i.test(params.pubkey)
      ? params.pubkey
      : null
  const self = peer !== null && peer === me
  const person = () => authorEl(peer, { link: false })
  const object = !peer
    ? undefined
    : decrypt
      ? el("span", "", ...(self ? ["a message to yourself"] : ["a message with ", person()]))
      : el("span", "", ...(self ? ["for yourself"] : ["for ", person()]))
  const raw = decrypt ? params?.ciphertext : params?.plaintext
  const text = typeof raw === "string" ? raw : ""
  return {
    object,
    body: details(
      {
        fold: true,
        class: "app-dialog-fold app-dialog-cipher",
        summary: [el("span", "", characters(text)), overline(nipName(method.slice(0, 5)))]
      },
      codeBlock(preview(text), "app-dialog-detail-code")
    )
  }
}

// The event a napp wants signed or published, folded: the summary gives the
// kind, how long its content is and how many tags (what the kind is goes after
// the verb), and the fold holds the event as JSON, as the signer gets it.
function eventFold(evt: any): HTMLDetailsElement {
  const kind = Number(evt?.kind)
  const n = Array.isArray(evt?.tags) ? evt.tags.length : 0
  const length = typeof evt?.content === "string" ? evt.content.length : 0
  let json: string
  try {
    json = JSON.stringify(evt, null, 2) ?? "no event"
  } catch {
    json = "unreadable event"
  }
  return details(
    {
      fold: true,
      class: "app-dialog-fold app-dialog-event",
      summary: [
        code(`kind-${Number.isFinite(kind) ? kind : "unknown"}`),
        length ? overline(`content ${length}`) : el("span", ""),
        overline(`${n} tag${n === 1 ? "" : "s"}`)
      ]
    },
    codeBlock(json, "app-dialog-detail-code")
  )
}

export interface EventDetailOpts {
  // The caller's own words for the event, going on from a verb of its own
  // ("wants to follow <person>"), in place of what the event says.
  line?: Array<Node | string>
  // The event this one replaces (the current follow list, profile, …): the
  // facts then say what changes.
  prev?: any
  // False when the verb isn't one that takes the event ("wants to react"):
  // no "a <kind>" after it.
  object?: boolean
  // Words to end what the event says with, in place of its stop: where a
  // publish goes, ", to 3 relays:".
  end?: Array<Node | string>
}

// What the kind is, after the verb: "wants to sign a note".
const eventObject = (evt: any) => aKind(Number(evt?.kind), "event")

// An approval detail for an event: what it is, after the verb; the caller's
// line, or else what the event says when its kind is one we can read, to go
// on from the ask; then the rest of what it says, and its fold.
export function eventDetail(
  evt: any,
  opts: EventDetailOpts = {}
): { object?: string; line?: HTMLElement; body: DocumentFragment } {
  const body = document.createDocumentFragment()
  const facts = opts.line?.length ? null : eventFacts(evt, opts.prev)
  if (facts) body.append(...facts.more)
  body.append(eventFold(evt))
  const end = opts.end ?? []
  const said = opts.line?.length
    ? opts.line
    : facts
      ? [...facts.sentence, ...(end.length ? [", ", ...end] : ["."])]
      : end
  return {
    object: opts.object === false ? undefined : eventObject(evt),
    line: said.length ? el("p", "", ...said) : undefined,
    body
  }
}

function stripRelayScheme(url: string): string {
  return url.replace(/^wss?:\/\//i, "").replace(/\/$/, "")
}

const toRelays = (n: number) => (n ? `to ${n} relay${n === 1 ? "" : "s"}:` : "to no relays:")

// A publish: where it goes, at the end of what the event says ("…, to 3
// relays:"); the relays a row each to untick like an install's grants, then
// the event. `relays()` is what is still ticked, read once the prompt is
// answered (all of them when it never showed).
export function publishDetail(
  event: any,
  targets: string[],
  prev?: any
): { object?: string; line?: HTMLElement; body: DocumentFragment; relays: () => string[] } {
  const count = el(
    "span",
    "",
    targets.length ? toRelays(targets.length) : "to no relays (none found)."
  )
  const detail = eventDetail(event, { prev, end: [count] })
  const boxes = targets.map(() => check({ checked: true }))
  const section = el("div", "app-dialog-relays")
  targets.forEach((url, i) => {
    boxes[i].addEventListener("change", () => {
      count.textContent = toRelays(boxes.filter(b => b.checked).length)
    })
    section.append(permRow(boxes[i], code(stripRelayScheme(url))))
  })
  // Before the fold: where it goes, then what it is.
  if (targets.length) detail.body.insertBefore(section, detail.body.lastChild)
  return { ...detail, relays: () => targets.filter((_, i) => boxes[i].checked) }
}
