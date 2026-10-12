// What people make of an app, shown in its detail under files: reactions
// (NIP-25) and comments (NIP-22), on its address so every version's, and
// reactions on this version's id. Asked of relay.nostrapps.com, the relays
// the manifest was seen on and the developer's read relays, live while the
// detail is open. Reactions: a chip per emoji, a person counted once, a click
// shows who. Comments: newest thread first, its replies in order under it,
// one level in. Logged in, "follows" keeps people followed, the developer and
// the viewer.

import { pool } from "@nostr/gadgets/global"
import { loadFollowsList, loadRelayList } from "@nostr/gadgets/lists"
import { decode } from "@nostr/tools/nip19"
import { normalizeURL } from "@nostr/tools/utils"
import type { Filter } from "@nostr/tools/filter"
import type { NostrEvent } from "@nostr/tools"

import type { SystemCtx } from "../types.js"
import { NAPP_RELAYS } from "../nsite/fetch.js"
import { ago } from "../utils.js"
import { author, bar, chip, details, el, empty, tabs } from "./ui.js"

type Mode = "everyone" | "follows"
const MODE_KEY = "nostrapps:app-feedback"

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "everyone" ? "everyone" : "follows"
  } catch {
    return "follows"
  }
}

interface Reaction {
  chip: HTMLButtonElement
  n: HTMLElement
  pks: Set<string>
}

// Hidden until the first reaction or comment lands; null without an address
// to ask by.
export function appFeedback(
  event: NostrEvent,
  ctx: SystemCtx,
  seen: string[],
  signal: AbortSignal
): HTMLDetailsElement | null {
  const d = event.tags.find(t => t[0] === "d")?.[1]
  if (d === undefined) return null
  const addr = `${event.kind}:${event.pubkey}:${d}`
  const me = ctx.account?.getPubkey() || null

  let mode = readMode()
  let follows: Set<string> | null = null
  const passes = (pk: string) =>
    !follows || mode === "everyone" || follows.has(pk) || pk === event.pubkey || pk === me

  const filter = tabs<Mode>({
    items: ["everyone", "follows"],
    active: mode,
    onChange: m => {
      mode = m
      try {
        localStorage.setItem(MODE_KEY, m)
      } catch {}
      for (const r of reactions.values()) paintReaction(r)
      fillWho()
      for (const row of rows.values()) row.hidden = !passes(row.dataset.pubkey!)
      counts()
    }
  })
  filter.hidden = true
  const reactionBar = bar()
  const who = bar()
  who.hidden = true
  const list = el("div", "apps-comments")
  const none = empty("none from people you follow")
  none.hidden = true
  const section = details(
    { summary: "", open: true, class: "apps-detail-feedback" },
    el("div", "apps-feedback", filter, reactionBar, who, list, none)
  )
  section.hidden = true
  const summary = section.querySelector("summary")!

  function counts() {
    let reacted = 0
    let reactedShown = 0
    for (const r of reactions.values()) {
      reacted += r.pks.size
      reactedShown += passing(r.pks).length
    }
    let commentsShown = 0
    for (const row of rows.values()) if (shown(row)) commentsShown++
    const part = (name: string, n: number, total: number) =>
      total ? `${name} (${n === total ? n : `${n} of ${total}`})` : ""
    summary.textContent = [
      part("reactions", reactedShown, reacted),
      part("comments", commentsShown, rows.size)
    ]
      .filter(Boolean)
      .join(" · ")
    none.hidden = reactedShown + commentsShown > 0
  }

  // ─── reactions ───

  const reactions = new Map<string, Reaction>() // what was reacted → who
  let opened: Reaction | null = null

  const passing = (pks: Set<string>) => [...pks].filter(passes)

  function paintReaction(r: Reaction) {
    const n = passing(r.pks).length
    r.n.textContent = String(n)
    r.chip.hidden = !n
    if (r === opened && !n) pick(null)
  }

  function fillWho() {
    who.replaceChildren(
      ...(opened ? passing(opened.pks).map(pk => author(pk, { picture: true })) : [])
    )
    who.hidden = !opened
  }

  // A chip shows who reacted with it; a second click, or another chip, closes it.
  function pick(r: Reaction | null) {
    const lit = (c: HTMLElement, on: boolean) => {
      c.classList.toggle("btn-primary", on)
      c.classList.toggle("btn-ghost", !on)
    }
    if (opened) lit(opened.chip, false)
    opened = r === opened ? null : r
    if (opened) lit(opened.chip, true)
    fillWho()
  }

  function addReaction(evt: NostrEvent) {
    const k = evt.tags.find(t => t[0] === "k")?.[1]
    if (k && k !== String(event.kind)) return
    const target = evt.tags.filter(t => t[0] === "e").pop()?.[1]
    if (target !== event.id && !evt.tags.some(t => t[0] === "a" && t[1] === addr)) return
    const face = reactionFace(evt)
    let r = reactions.get(face.key)
    if (!r) {
      const n = el("span", "apps-reaction-n")
      const made: Reaction = {
        chip: chip({ label: "", class: "apps-reaction" }),
        n,
        pks: new Set()
      }
      made.chip.querySelector(".btn-chip-label")!.append(face.node, " ", n)
      made.chip.addEventListener("click", () => pick(made))
      reactions.set(face.key, made)
      reactionBar.append(made.chip)
      r = made
    }
    if (r.pks.has(evt.pubkey)) return
    r.pks.add(evt.pubkey)
    paintReaction(r)
    if (r === opened && passes(evt.pubkey)) who.append(author(evt.pubkey, { picture: true }))
    section.hidden = false
    counts()
  }

  // ─── comments ───

  const rows = new Map<string, HTMLElement>() // comment id → its row
  const parentOf = new Map<string, string>() // reply id → the comment it answers
  const waiting = new Map<string, string[]>() // parent not here yet → its replies, at the top meanwhile

  const repliesOf = (row: HTMLElement) => row.lastElementChild as HTMLElement
  // Shown: its author passes, and so does its thread's.
  const shown = (row: HTMLElement) =>
    !row.hidden && !row.parentElement?.closest<HTMLElement>(".apps-comment")?.hidden

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

  function addComment(evt: NostrEvent) {
    if (rows.has(evt.id)) return
    if (!evt.tags.some(t => t[0] === "A" && t[1] === addr)) return
    const k = evt.tags.find(t => t[0] === "k")?.[1]
    const e = evt.tags.find(t => t[0] === "e")?.[1]
    if (k === "1111" && e) parentOf.set(evt.id, e)

    const when = el("span", "apps-comment-when", ago(evt.created_at * 1000))
    when.title = new Date(evt.created_at * 1000).toLocaleString()
    const row = el(
      "div",
      "apps-comment",
      el("div", "apps-comment-head", author(evt.pubkey, { picture: true }), when),
      commentText(evt.content),
      el("div", "apps-comment-replies")
    )
    row.dataset.at = String(evt.created_at)
    row.dataset.pubkey = evt.pubkey
    row.hidden = !passes(evt.pubkey)
    rows.set(evt.id, row)
    place(evt.id)
    const answers = waiting.get(evt.id)
    if (answers) {
      waiting.delete(evt.id)
      for (const id of answers) place(id)
    }
    section.hidden = false
    counts()
  }

  ;(async () => {
    const [dev, mine] = await Promise.all([
      loadRelayList(event.pubkey).catch(() => null),
      me ? loadFollowsList(me).catch(() => null) : null
    ])
    if (signal.aborted) return
    if (mine) {
      follows = new Set(mine.items)
      filter.hidden = false
    }
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
          if (evt.kind === 1111) addComment(evt)
          else if (evt.kind === 7) addReaction(evt)
        },
        // the first load in: most used first, then as they come
        oneose() {
          const order = [...reactions.values()].sort((a, b) => b.pks.size - a.pks.size)
          reactionBar.append(...order.map(r => r.chip))
        }
      }
    )
  })()

  return section
}

// What a reaction shows: "+" a heart, "-" a thumb down, a custom :emoji: its
// image, anything else as written.
function reactionFace(evt: NostrEvent): { key: string; node: Node } {
  const c = evt.content.trim()
  if (c === "" || c === "+") return { key: "❤", node: document.createTextNode("❤️") }
  if (c === "-") return { key: "👎", node: document.createTextNode("👎") }
  const name = /^:([\w-]+):$/.exec(c)?.[1]
  const url = name && evt.tags.find(t => t[0] === "emoji" && t[1] === name)?.[2]
  if (url && /^https:\/\//i.test(url)) {
    const img = el("img", "apps-reaction-emoji")
    img.alt = c
    img.title = c
    img.referrerPolicy = "no-referrer"
    img.onerror = () => img.replaceWith(c)
    img.src = url
    return { key: `${c} ${url}`, node: img }
  }
  // one chip whether or not the emoji carries its presentation selector
  return { key: c.replace(/\uFE0F/g, ""), node: document.createTextNode(c) }
}

// Plain text with its links and nostr: mentions live.
const TOKENS = /(https?:\/\/[^\s<>"]+)|nostr:((?:npub|nprofile)1[02-9ac-hj-np-z]+)/gi

function commentText(content: string): HTMLElement {
  const p = el("div", "apps-comment-text")
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
