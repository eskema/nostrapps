// What people make of an app, shown in its detail under files: reactions
// (NIP-25) and comments (NIP-22), on its address so every version's, and
// reactions on this version's id. Asked of relay.nostrapps.com, the relays
// the manifest was seen on and the developer's read relays, live while the
// detail is open. One row per event, the author and what they said in a
// line, newest first; a comment's replies in order under it, one level in.

import { pool } from "@nostr/gadgets/global"
import { loadRelayList } from "@nostr/gadgets/lists"
import { decode } from "@nostr/tools/nip19"
import { normalizeURL } from "@nostr/tools/utils"
import type { Filter } from "@nostr/tools/filter"
import type { NostrEvent } from "@nostr/tools"

import { NAPP_RELAYS } from "../nsite/fetch.js"
import { author, el } from "./ui.js"

// Hidden until the first reaction or comment lands; null without an address
// to ask by.
export function appFeedback(
  event: NostrEvent,
  seen: string[],
  signal: AbortSignal
): HTMLElement | null {
  const d = event.tags.find(t => t[0] === "d")?.[1]
  if (d === undefined) return null
  const addr = `${event.kind}:${event.pubkey}:${d}`

  const list = el("div", "apps-feedback")
  list.hidden = true

  const rows = new Map<string, HTMLElement>() // event id → its row
  const parentOf = new Map<string, string>() // reply id → the comment it answers
  const waiting = new Map<string, string[]>() // parent not here yet → its replies, at the top meanwhile

  const repliesOf = (row: HTMLElement) => row.lastElementChild as HTMLElement

  function insertSorted(into: HTMLElement, row: HTMLElement, newestFirst: boolean) {
    const at = Number(row.dataset.at)
    for (const c of into.children) {
      const cat = Number((c as HTMLElement).dataset.at)
      if (newestFirst ? cat < at : cat > at) return void into.insertBefore(row, c)
    }
    into.append(row)
  }

  // The thread's first comment as far as it's known, and the missing link
  // above it if there is one.
  function threadOf(id: string): { top: string; missing?: string } {
    const walked = new Set([id])
    let cur = id
    for (;;) {
      const p = parentOf.get(cur)
      if (!p || walked.has(p)) return { top: cur }
      if (!rows.has(p)) return { top: cur, missing: p }
      walked.add(p)
      cur = p
    }
  }

  function place(id: string) {
    const row = rows.get(id)!
    const { top, missing } = threadOf(id)
    if (top === id) {
      if (missing) waiting.set(missing, [...(waiting.get(missing) || []), id])
      insertSorted(list, row, true)
      return
    }
    const into = repliesOf(rows.get(top)!)
    insertSorted(into, row, false)
    // a row that led a thread brings its replies along
    for (const r of [...repliesOf(row).children]) insertSorted(into, r as HTMLElement, false)
  }

  function add(evt: NostrEvent, said: Node) {
    const row = el(
      "div",
      "apps-feedback-row",
      el("div", "apps-feedback-line", author(evt.pubkey, { picture: true }), " ", said),
      el("div", "apps-feedback-replies")
    )
    row.dataset.at = String(evt.created_at)
    rows.set(evt.id, row)
    place(evt.id)
    const answers = waiting.get(evt.id)
    if (answers) {
      waiting.delete(evt.id)
      for (const id of answers) place(id)
    }
    list.hidden = false
  }

  function addComment(evt: NostrEvent) {
    if (!evt.tags.some(t => t[0] === "A" && t[1] === addr)) return
    const k = evt.tags.find(t => t[0] === "k")?.[1]
    const e = evt.tags.find(t => t[0] === "e")?.[1]
    if (k === "1111" && e) parentOf.set(evt.id, e)
    add(evt, commentText(evt.content.trim()))
  }

  function addReaction(evt: NostrEvent) {
    const k = evt.tags.find(t => t[0] === "k")?.[1]
    if (k && k !== String(event.kind)) return
    const target = evt.tags.filter(t => t[0] === "e").pop()?.[1]
    if (target !== event.id && !evt.tags.some(t => t[0] === "a" && t[1] === addr)) return
    add(evt, reactionFace(evt))
  }

  ;(async () => {
    const dev = await loadRelayList(event.pubkey).catch(() => null)
    if (signal.aborted) return
    const reads = (dev?.items || []).filter(i => i.read).map(i => i.url)
    const pooled = Array.from(pool.seenOn.get(event.id) || []).map(r => r.url)
    const relays = new Set<string>()
    for (const url of [...NAPP_RELAYS, ...seen, ...pooled, ...reads]) {
      try {
        relays.add(normalizeURL(url))
      } catch {}
    }
    const filters: Filter[] = [
      { kinds: [1111], "#A": [addr], limit: 500 },
      { kinds: [7], "#a": [addr], limit: 500 },
      { kinds: [7], "#e": [event.id], limit: 500 }
    ]
    pool.subscribeMap(
      [...relays].flatMap(url => filters.map(filter => ({ url, filter }))),
      {
        label: "app-feedback",
        abort: signal,
        onevent(evt) {
          if (rows.has(evt.id)) return
          if (evt.kind === 1111) addComment(evt)
          else if (evt.kind === 7) addReaction(evt)
        }
      }
    )
  })()

  return list
}

// What a reaction shows: "+" a heart, "-" a thumb down, a custom :emoji: its
// image, anything else as written.
function reactionFace(evt: NostrEvent): Node {
  const c = evt.content.trim()
  if (c === "" || c === "+") return document.createTextNode("❤️")
  if (c === "-") return document.createTextNode("👎")
  const name = /^:([\w-]+):$/.exec(c)?.[1]
  const url = name && evt.tags.find(t => t[0] === "emoji" && t[1] === name)?.[2]
  if (url && /^https:\/\//i.test(url)) {
    const img = el("img", "apps-reaction-emoji")
    img.alt = c
    img.title = c
    img.referrerPolicy = "no-referrer"
    img.onerror = () => img.replaceWith(c)
    img.src = url
    return img
  }
  return document.createTextNode(c)
}

// Plain text with its links and nostr: mentions live.
const TOKENS = /(https?:\/\/[^\s<>"]+)|nostr:((?:npub|nprofile)1[02-9ac-hj-np-z]+)/gi

function commentText(content: string): HTMLElement {
  const p = el("span", "apps-feedback-text")
  let last = 0
  for (const m of content.matchAll(TOKENS)) {
    p.append(content.slice(last, m.index))
    last = m.index + m[0].length
    if (m[1]) {
      const url = m[1].replace(/[.,;:!?)\]'"]+$/, "")
      const a = el("a", "", url)
      a.href = url
      a.target = "_blank"
      a.rel = "noopener noreferrer"
      p.append(a, m[1].slice(url.length))
      continue
    }
    let pk: string | null = null
    try {
      const r = decode(m[2])
      if (r.type === "npub") pk = r.data
      else if (r.type === "nprofile") pk = r.data.pubkey
    } catch {}
    p.append(pk ? author(pk, { prefix: "@" }) : m[0])
  }
  p.append(content.slice(last))
  return p
}
