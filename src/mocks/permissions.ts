// Every permission prompt at once, with fake data: the real builders, laid out
// as cards instead of one modal at a time. Dev only, at /mocks/permissions.html.
import "@fontsource-variable/source-sans-3"
import "@fontsource-variable/source-sans-3/wght-italic.css"
import "@fontsource-variable/source-serif-4"
import "@fontsource-variable/source-serif-4/wght-italic.css"
import "@fontsource-variable/source-code-pro"
import "@fontsource-variable/source-code-pro/wght-italic.css"
import {
  describeCipher,
  describeCopyText,
  eventDetail,
  publishDetail
} from "../approval-details.js"
import { peopleList } from "../event-facts.js"
import { PERMISSION_ACTIONS, permissionBody, type ApprovalDetail } from "../permissions.js"
import { appIcon, author, authors, button, code, el } from "../system-napps/ui.js"

const pk = (n: number) => n.toString(16).padStart(64, "0")
const hex = (c: string) => c.repeat(64)
const ME = pk(99)
authors.set(ME, { name: "<you>" })
for (let i = 1; i <= 13; i++) authors.set(pk(i), { name: `<person-${i}>` })
// The napp asking: its icon, and who published it.
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#6b5bd6"/><text x="24" y="31" font-size="22" text-anchor="middle" fill="#fff" font-family="sans-serif">m</text></svg>'
  )
const PUBLISHER = pk(50)
authors.set(PUBLISHER, { name: "<publisher>" })
const NAPP = { title: "my-napp", type: "napp", author: PUBLISHER, authorLabel: null }

const now = Math.floor(Date.now() / 1000)
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."
const LONG = Array(8).fill(LOREM).join(" ")
const event = (kind: number, tags: string[][], content = "") => ({
  kind,
  created_at: now,
  tags,
  content
})
const p = (...ns: number[]) => ns.map(n => ["p", pk(n)])
const follows = (from: number, to: number) =>
  p(...Array.from({ length: to - from + 1 }, (_, i) => from + i))

const cards: Array<[string, string, () => ApprovalDetail | undefined]> = [
  [
    "blossom upload, 2 servers, 3 blobs",
    "signEvent",
    () =>
      eventDetail(
        event(
          24242,
          [
            ["t", "upload"],
            ["x", hex("a")],
            ["x", hex("b")],
            ["x", hex("c")],
            ["server", "<server-1>"],
            ["server", "<server-2>"],
            ["expiration", String(now + 300)]
          ],
          "Upload Blob"
        )
      )
  ],
  [
    "blossom delete, no server named",
    "signEvent",
    () =>
      eventDetail(
        event(
          24242,
          [
            ["t", "delete"],
            ["x", hex("a")],
            ["expiration", String(now + 2 * 86400)]
          ],
          "Delete Blob"
        )
      )
  ],
  [
    "http auth",
    "signEvent",
    () =>
      eventDetail(
        event(27235, [
          ["u", "https://url.com/api/upload"],
          ["method", "POST"],
          ["payload", hex("d")]
        ])
      )
  ],
  [
    "relay auth",
    "signEvent",
    () =>
      eventDetail(
        event(22242, [
          ["relay", "wss://<relay-1>/"],
          ["challenge", "<challenge>"]
        ])
      )
  ],
  [
    "note, a reply mentioning two people",
    "signEvent",
    () => eventDetail(event(1, [["e", hex("e"), "", "reply"], ...p(1, 2)], LOREM))
  ],
  ["note, new post, long text", "signEvent", () => eventDetail(event(1, [], LONG))],
  [
    "comment on a url",
    "signEvent",
    () =>
      eventDetail(
        event(
          1111,
          [
            ["I", "https://url.com/article"],
            ["K", "web"],
            ["i", "https://url.com/article"],
            ["k", "web"]
          ],
          LOREM
        )
      )
  ],
  [
    "react, the common action",
    "common.react",
    () =>
      eventDetail(
        event(
          7,
          [
            ["e", hex("e")],
            ["p", pk(3)],
            ["k", "1"]
          ],
          "+"
        ),
        { line: ["with + on a note by ", author(pk(3), { link: false }), "."], object: false }
      )
  ],
  [
    "repost",
    "signEvent",
    () =>
      eventDetail(
        event(6, [
          ["e", hex("e")],
          ["p", pk(4)]
        ])
      )
  ],
  [
    "deletion request",
    "signEvent",
    () =>
      eventDetail(
        event(
          5,
          [
            ["e", hex("1")],
            ["e", hex("2")],
            ["e", hex("3")],
            ["k", "1"],
            ["k", "7"]
          ],
          "posted by mistake"
        )
      )
  ],
  [
    "profile, against the current one",
    "signEvent",
    () =>
      eventDetail(
        event(
          0,
          [],
          JSON.stringify({
            name: "<name>",
            about: LOREM,
            picture: "https://url.com/<new-picture>.jpg",
            website: "https://url.com"
          })
        ),
        {
          prev: event(
            0,
            [],
            JSON.stringify({
              name: "<name>",
              about: "<old about>",
              picture: "https://url.com/<picture>.jpg",
              website: "https://url.com",
              lud16: "<name>@url.com"
            })
          )
        }
      )
  ],
  [
    "profile, no current one found",
    "signEvent",
    () =>
      eventDetail(
        event(0, [], JSON.stringify({ name: "<name>", about: LOREM, nip05: "<name>@url.com" }))
      )
  ],
  [
    "follow list, +2 −1",
    "signEvent",
    () => eventDetail(event(3, follows(2, 12)), { prev: event(3, follows(1, 10)) })
  ],
  [
    "follow list, 3 replacing 412",
    "signEvent",
    () =>
      eventDetail(event(3, follows(1, 3)), {
        prev: event(3, [
          ...follows(1, 12),
          ...Array.from({ length: 400 }, (_, i) => ["p", pk(1000 + i)])
        ])
      })
  ],
  ["follow list, no current one found", "signEvent", () => eventDetail(event(3, follows(1, 5)))],
  [
    "relay list, one new, one gone",
    "signEvent",
    () =>
      eventDetail(
        event(10002, [
          ["r", "wss://<relay-1>/"],
          ["r", "wss://<relay-2>/", "read"],
          ["r", "wss://<relay-4>/", "write"]
        ]),
        {
          prev: event(10002, [
            ["r", "wss://<relay-1>/"],
            ["r", "wss://<relay-2>/", "read"],
            ["r", "wss://<relay-3>/"]
          ])
        }
      )
  ],
  [
    "blossom server list",
    "signEvent",
    () =>
      eventDetail(
        event(10063, [
          ["server", "https://<server-1>"],
          ["server", "https://<server-3>"]
        ]),
        { prev: event(10063, [["server", "https://<server-1>"]]) }
      )
  ],
  [
    "mute list with private items",
    "signEvent",
    () =>
      eventDetail(
        event(
          10000,
          [...p(5, 6, 7), ["t", "<hashtag>"], ["word", "<word>"]],
          "<ciphertext>".repeat(8)
        ),
        { prev: event(10000, [...p(5, 6), ["t", "<hashtag>"]]) }
      )
  ],
  [
    "bookmark set",
    "signEvent",
    () =>
      eventDetail(
        event(30003, [
          ["d", "<set>"],
          ["title", "<set title>"],
          ["e", hex("1")],
          ["e", hex("2")],
          ["a", `30023:${pk(1)}:<article>`]
        ])
      )
  ],
  [
    "zap request",
    "signEvent",
    () =>
      eventDetail(
        event(
          9734,
          [
            ["amount", "21000"],
            ["p", pk(4)],
            ["e", hex("e")],
            ["relays", "wss://<relay-1>/"]
          ],
          "<zap message>"
        )
      )
  ],
  [
    "article",
    "signEvent",
    () =>
      eventDetail(
        event(
          30023,
          [
            ["d", "<article>"],
            ["title", "<article title>"],
            ["summary", LOREM]
          ],
          LONG
        )
      )
  ],
  [
    "app data, encrypted",
    "signEvent",
    () => eventDetail(event(30078, [["d", "<napp>/settings"]], "QmFzZTY0Y2lwaGVydGV4dA".repeat(4)))
  ],
  ["gift wrap", "signEvent", () => eventDetail(event(1059, p(6), "<ciphertext>".repeat(8)))],
  [
    "a kind we can't read",
    "signEvent",
    () => eventDetail(event(4242, [["d", "<something>"]], LOREM))
  ],
  [
    "publish a signed note",
    "napp.publish",
    () =>
      publishDetail({ ...event(1, [], LOREM), pubkey: ME, id: hex("f"), sig: "<sig>" }, [
        "wss://<relay-1>/",
        "wss://<relay-2>/",
        "wss://<relay-3>/"
      ])
  ],
  [
    "napplet, publish encrypted",
    "relay.publishEncrypted",
    () =>
      eventDetail(event(14, p(7), LOREM), {
        line: ["encrypted with NIP-44, for ", author(pk(7), { link: false }), "."]
      })
  ],
  [
    "follow, the common action",
    "common.follow",
    () =>
      eventDetail(event(3, follows(1, 13)), {
        line: [...peopleList([pk(11), pk(12), pk(13)]), ", rewriting your follow list."],
        object: false,
        prev: event(3, follows(1, 10))
      })
  ],
  ["copy", "napp.copyText", () => describeCopyText({ text: `npub1<rest of the key>\n${LOREM}` })],
  [
    "encrypt for someone",
    "nip44.encrypt",
    () => describeCipher("nip44.encrypt", { pubkey: pk(8), plaintext: LOREM }, ME)
  ],
  [
    "encrypt for yourself",
    "nip44.encrypt",
    () => describeCipher("nip44.encrypt", { pubkey: ME, plaintext: '["p","<pubkey>"]' }, ME)
  ],
  [
    "decrypt",
    "nip04.decrypt",
    () =>
      describeCipher(
        "nip04.decrypt",
        { pubkey: pk(8), ciphertext: `${"QmFzZTY0Y2lwaGVydGV4dA".repeat(4)}?iv=SW5pdFZlY3Rvcg==` },
        ME
      )
  ],
  ["save a file", "napp.saveFile", () => "“<file>.png” (1.2 MiB) to your downloads folder."],
  [
    "open a link",
    "link.open",
    () => ({ object: "a link", line: el("p", "", code("https://url.com/page"), " in a new tab.") })
  ],
  ["a method with no verb", "napp.someMethod", () => undefined]
]

// The prompt's card as openDialog builds it, without the modal around it.
function card(method: string, detail: ApprovalDetail | undefined): HTMLElement {
  const actions = el("menu", "app-dialog-actions")
  for (const a of PERMISSION_ACTIONS)
    actions.append(button({ label: a.label, variant: a.variant || "outline" }))
  return el(
    "div",
    "app-dialog-permission",
    el(
      "div",
      "app-dialog-cards",
      el(
        "div",
        "app-dialog-body",
        el("h3", "app-dialog-title", "Permission request"),
        el(
          "div",
          "app-dialog-content",
          permissionBody(NAPP, method, detail, appIcon({ src: ICON, size: "s" }))
        ),
        actions
      )
    )
  )
}

const grid = document.getElementById("grid")!
cards.forEach(([label, method, detail], i) => {
  grid.append(
    el(
      "div",
      "mock-card",
      el("div", "mock-label", el("b", "", String(i + 1)), `${method} · ${label}`),
      card(method, detail())
    )
  )
})

const root = document.documentElement
document.getElementById("theme")!.append(
  button({
    label: "theme",
    variant: "outline",
    onClick: () => (root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light")
  })
)
