// What an event says, in a sentence a person can judge it by, for the approval
// prompts: the parts of the kinds napps commonly sign that are worth reading
// before agreeing. The sentence goes on from "<napp> wants to sign a <kind>",
// so it never names the kind again: "notifying <person>". The whole event,
// its text included, stays in the fold under it. Given the event it replaces
// (a follow list, a profile), it says what changes.
import { kindName } from "./kind-names.js"
import { author, code, notice } from "./system-napps/ui.js"

type Words = Array<Node | string>

interface Facts {
  // Goes on from "wants to sign a <kind>", with no closing stop.
  sentence: Words
  // What could hurt, under it all: a follow list about to lose most of itself.
  warn?: string
}

const PEOPLE_MAX = 5
const HEX64 = /^[0-9a-f]{64}$/i

const tagValues = (evt: any, name: string): string[] =>
  Array.isArray(evt?.tags)
    ? evt.tags
        .filter((t: unknown) => Array.isArray(t) && t[0] === name && typeof t[1] === "string")
        .map((t: string[]) => t[1])
    : []

const tagged = (evt: any, name: string) => tagValues(evt, name)[0] ?? ""

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const host = (url: string) => url.replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "")

const content = (evt: any) => (typeof evt?.content === "string" ? evt.content : "")

// "a note", "an http auth"; `unknown` for a kind we have no name for.
export function aKind(kind: number, unknown = "post"): string {
  const name = kindName(kind) || unknown
  return `${/^([aeiou]|http\b)/.test(name) ? "an" : "a"} ${name}`
}

// Looks like nip04 ("…?iv=…") or nip44 (one long base64 run) ciphertext.
const encrypted = (text: string) =>
  text.length >= 40 && /^[A-Za-z0-9+/=]+(\?iv=[A-Za-z0-9+/=]+)?$/.test(text)

// "a", "a and b", "a, b and c"; an item can be words of its own.
function and(items: Array<Node | string | Words>): Words {
  const out: Words = []
  items.forEach((it, i) => {
    if (i > 0) out.push(i === items.length - 1 ? " and " : ", ")
    out.push(...[it].flat())
  })
  return out
}

// People by name, PEOPLE_MAX at most, then how many more.
export function peopleList(pubkeys: string[]): Words {
  const keys = [...new Set(pubkeys.filter(p => HEX64.test(p)))]
  const named: Words = keys.slice(0, PEOPLE_MAX).map(p => author(p, { link: false }))
  if (keys.length > PEOPLE_MAX) named.push(`${keys.length - PEOPLE_MAX} more`)
  return and(named)
}

// A list of urls under one tag (relays, servers), each with what the tag marks
// it for; against the list it replaces, what is new and what goes.
function urlList(
  evt: any,
  prev: any,
  tag: string,
  marks: (t: string[]) => string = () => ""
): Words {
  const tags = (e: any): string[][] =>
    Array.isArray(e?.tags)
      ? e.tags.filter((t: unknown) => Array.isArray(t) && t[0] === tag && typeof t[1] === "string")
      : []
  const now = tags(evt)
  const was = new Set(tags(prev).map(t => host(t[1])))
  const kept = new Set(now.map(t => host(t[1])))
  const items: Words[] = now.map(t => {
    const notes = [marks(t), prev && !was.has(host(t[1])) ? "new" : ""].filter(Boolean)
    return [code(host(t[1])), notes.length ? ` (${notes.join(", ")})` : ""]
  })
  const gone = [...was].filter(url => !kept.has(url)).map(url => code(url))
  return [
    ...(items.length ? and(items) : ["no entries"]),
    ...(gone.length ? [", dropping ", ...and(gone)] : [])
  ]
}

// The public items of a list by what they are, each with what changes against
// the list it replaces; private ones are encrypted in the content.
const ITEMS: Record<string, [string, string]> = {
  p: ["person", "people"],
  e: ["note", "notes"],
  a: ["item", "items"],
  t: ["hashtag", "hashtags"],
  word: ["word", "words"],
  r: ["link", "links"],
  relay: ["relay", "relays"],
  emoji: ["emoji", "emoji"],
  group: ["group", "groups"]
}

function listItems(evt: any, prev: any): Words {
  const parts: string[] = []
  for (const [tag, [one, many]] of Object.entries(ITEMS)) {
    const now = new Set(tagValues(evt, tag))
    const was = new Set(tagValues(prev, tag))
    if (!now.size && !was.size) continue
    const added = [...now].filter(v => !was.has(v)).length
    const removed = [...was].filter(v => !now.has(v)).length
    const change = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(", ")
    parts.push(`${plural(now.size, one, many)}${prev && change ? ` (${change})` : ""}`)
  }
  if (content(evt)) parts.push("private items")
  return parts.length ? and(parts) : ["nothing"]
}

// Profile fields in the order a person reads them; the rest after.
const PROFILE_ORDER = [
  "name",
  "display_name",
  "about",
  "picture",
  "banner",
  "website",
  "nip05",
  "lud16"
]

function profileFields(evt: any): Record<string, string> {
  try {
    const o = JSON.parse(content(evt))
    if (!o || typeof o !== "object") return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o))
      if (v !== null && v !== undefined && v !== "") out[k] = String(v)
    return out
  } catch {
    return {}
  }
}

const byProfileOrder = (a: string, b: string) =>
  (PROFILE_ORDER.indexOf(a) + 1 || 99) - (PROFILE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b)

const fieldNames = (keys: string[]) => and(keys.sort(byProfileOrder).map(k => k.replace(/_/g, " ")))

const FACTS: Record<number, (evt: any, prev?: any) => Facts | null> = {
  // Profile: with the current one, the fields that change and go; without,
  // the fields it has.
  0: (evt, prev) => {
    const now = profileFields(evt)
    if (!prev)
      return { sentence: ["with ", ...fieldNames(Object.keys(now)), " (no current one found)"] }
    const was = profileFields(prev)
    const changed = Object.keys(now).filter(k => now[k] !== was[k])
    const removed = Object.keys(was).filter(k => !(k in now))
    if (!changed.length && !removed.length) return { sentence: ["with no changes"] }
    return {
      sentence: [
        ...(changed.length ? ["changing ", ...fieldNames(changed)] : []),
        ...(changed.length && removed.length ? [", "] : []),
        ...(removed.length ? ["removing ", ...fieldNames(removed)] : [])
      ]
    }
  },

  // A note: who it notifies.
  1: evt => {
    const p = tagValues(evt, "p")
    return p.length ? { sentence: ["notifying ", ...peopleList(p)] } : null
  },

  // Follow list: against the current one, the count before and after, who is
  // followed and unfollowed; losing more than a quarter of it is a warning.
  3: (evt, prev) => {
    const now = new Set(tagValues(evt, "p"))
    if (!prev)
      return {
        sentence: [`of ${plural(now.size, "profile")}`],
        warn: "Your current follow list wasn't found: this replaces whatever it is."
      }
    const was = new Set(tagValues(prev, "p"))
    const added = [...now].filter(p => !was.has(p))
    const removed = [...was].filter(p => !now.has(p))
    return {
      sentence: [
        `of ${plural(now.size, "profile")} (was ${was.size})`,
        ...(added.length ? [", following ", ...peopleList(added)] : []),
        ...(removed.length ? [", unfollowing ", ...peopleList(removed)] : [])
      ],
      warn:
        removed.length > was.size / 4
          ? `This drops ${removed.length} of the ${was.size} profiles you follow.`
          : undefined
    }
  },

  // Deletion request: how many events, of which kinds, why.
  5: evt => {
    const kinds = [...new Set(tagValues(evt, "k"))].map(k => kindName(Number(k)) || `kind ${k}`)
    const n = tagValues(evt, "e").length + tagValues(evt, "a").length
    return {
      sentence: [
        `for ${plural(n, "event")}`,
        kinds.length ? ` (${kinds.join(", ")})` : "",
        content(evt) ? `, saying “${content(evt)}”` : ""
      ]
    }
  },

  // Repost: of what, by whom.
  6: evt => repost(evt),
  16: evt => repost(evt),

  // Reaction: which, on what, by whom.
  7: evt => {
    const c = content(evt)
    const [by] = tagValues(evt, "p").filter(p => HEX64.test(p))
    const on = [
      aKind(Number(tagged(evt, "k")) || 1),
      ...(by ? [" by ", author(by, { link: false })] : [])
    ]
    if (c === "+" || c === "") return { sentence: ["liking ", ...on] }
    if (c === "-") return { sentence: ["disliking ", ...on] }
    return { sentence: [`with ${c.replace(/^:|:$/g, "")} on `, ...on] }
  },

  // Gift wrap: who can open it.
  1059: evt => ({ sentence: ["for ", ...peopleList(tagValues(evt, "p"))] }),

  // Comment (NIP-22): on what (the url or other external thing it's about, or
  // the root's kind and author), who it notifies.
  1111: evt => {
    const ext = tagged(evt, "I")
    const [root] = tagValues(evt, "P").filter(p => HEX64.test(p))
    const p = tagValues(evt, "p").filter(k => k !== root)
    return {
      sentence: [
        "on ",
        ...(ext
          ? [code(ext)]
          : [
              aKind(Number(tagged(evt, "K"))),
              ...(root ? [" by ", author(root, { link: false })] : [])
            ]),
        ...(p.length ? [", notifying ", ...peopleList(p)] : [])
      ]
    }
  },

  // Zap request: how much, to whom, for what.
  9734: evt => {
    const msats = Number(tagged(evt, "amount"))
    const [to] = tagValues(evt, "p").filter(p => HEX64.test(p))
    if (!msats && !to) return null
    return {
      sentence: [
        msats ? `for ${plural(Math.round(msats / 1000), "sat")}` : "",
        ...(to ? [msats ? " to " : "to ", author(to, { link: false })] : []),
        tagged(evt, "e") ? ", on a note" : ""
      ]
    }
  },

  10000: (evt, prev) => ({ sentence: ["with ", ...listItems(evt, prev)] }),
  10001: (evt, prev) => ({ sentence: ["with ", ...listItems(evt, prev)] }),
  10003: (evt, prev) => ({ sentence: ["with ", ...listItems(evt, prev)] }),

  // Relay list (NIP-65): each relay, marked when it is only read or write.
  10002: (evt, prev) => ({
    sentence: [
      "with ",
      ...urlList(evt, prev, "r", t => (t[2] === "read" || t[2] === "write" ? t[2] : ""))
    ]
  }),

  // Message relays (NIP-17).
  10050: (evt, prev) => ({ sentence: ["with ", ...urlList(evt, prev, "relay")] }),

  // Blossom servers (BUD-03).
  10063: (evt, prev) => ({ sentence: ["with ", ...urlList(evt, prev, "server")] }),

  // Relay auth (NIP-42): which relay it logs you in to.
  22242: evt => ({ sentence: ["for ", code(host(tagged(evt, "relay") || "?"))] }),

  // Blossom auth (BUD-11): what it allows (t), on how many blobs (x), on which
  // servers (none named: any that takes it). Not its expiration: read beside
  // the prompt's answers, it passes for how long they last.
  24242: evt => {
    const verb = tagged(evt, "t") || "?"
    const blobs = tagValues(evt, "x").length
    const servers = tagValues(evt, "server")
    return {
      sentence: [
        `${verb} ${blobs ? plural(blobs, "blob") : "blobs"}`,
        verb === "upload" || verb === "media" ? " to " : " on ",
        ...(servers.length ? and(servers.map(s => code(host(s)))) : ["any server"])
      ]
    }
  },

  // HTTP auth (NIP-98): the request it signs for.
  27235: evt => ({
    sentence: [`${tagged(evt, "method") || "a request to"} `, code(tagged(evt, "u") || "?")]
  }),

  // Sets: which one, then its items.
  30000: (evt, prev) => set(evt, prev),
  30003: (evt, prev) => set(evt, prev),

  // Article: its title.
  30023: evt => (tagged(evt, "title") ? { sentence: [`“${tagged(evt, "title")}”`] } : null),

  // App data (NIP-78): the key it's stored under, and whether it's readable.
  30078: evt => ({
    sentence: [
      "under ",
      code(tagged(evt, "d") || "?"),
      encrypted(content(evt)) ? ", encrypted" : ""
    ]
  })
}

function repost(evt: any): Facts {
  const [by] = tagValues(evt, "p").filter(p => HEX64.test(p))
  return {
    sentence: [
      `of ${aKind(Number(tagged(evt, "k")) || (evt?.kind === 6 ? 1 : 0))}`,
      ...(by ? [" by ", author(by, { link: false })] : [])
    ]
  }
}

function set(evt: any, prev: any): Facts {
  const title = tagged(evt, "title")
  return {
    sentence: [
      title ? `“${title}”` : code(tagged(evt, "d") || "?"),
      " with ",
      ...listItems(evt, prev)
    ]
  }
}

// The sentence, to go on from the ask (its stop is the caller's), and what
// goes under the ask: the warning.
export function eventFacts(evt: any, prev?: any): { sentence: Words; more: Node[] } | null {
  const facts = FACTS[Number(evt?.kind)]?.(evt, prev)
  if (!facts) return null
  return {
    sentence: facts.sentence,
    more: facts.warn ? [notice(facts.warn, { tone: "danger" })] : []
  }
}
