# Napps

A napp is an app published as kind `35130`. It is a static site with launcher capabilities such as actions, permissions, and declared requirements. Kind identifies it as a napp; `action` and `requires` tags declare capabilities but do not classify the event.

## Local metadata

Local and uploaded napps use `metadata.json` next to `index.html`:

```json
{
  "id": "relays",
  "title": "Relays",
  "icon": "/icon.svg",
  "description": "Edit your relay lists",
  "requires": ["ui"],
  "actions": ["profile", "view:0"]
}
```

`id` becomes the `d` tag. `requires` becomes `requires` tags. `actions` becomes `action` tags.

| Field         | Published as  | Meaning                                  |
| ------------- | ------------- | ---------------------------------------- |
| `id`          | `d`           | Required identifier and origin basis.    |
| `title`       | `title`       | Display name.                            |
| `icon`        | `icon`        | Icon URL or path.                        |
| `description` | `description` | One-line card description.               |
| `requires`    | `requires`    | Capability domains requested by the app. |
| `actions`     | `action`      | Action patterns handled by the app.      |

## Launcher bridge

Inside a napp iframe:

```js
window.nostr.getPublicKey()
window.nostr.signEvent(event)
window.nostrdb.query(filters)
window.napp.registerAction("profile", handler)
window.napp.action("view", payload)
window.napp.utils.loadRelayList(pubkey)
window.napp.utils.publish(event, relays)
window.napp.link(url)
window.napp.log(message)
```

Complete bridge method list:

```js
// NIP-07 signer
window.nostr.getPublicKey()
window.nostr.signEvent(evt)
window.nostr.nip04.encrypt(pubkey, text)
window.nostr.nip04.decrypt(pubkey, text)
window.nostr.nip44.encrypt(pubkey, text)
window.nostr.nip44.decrypt(pubkey, text)

// NIP-DB event store
window.nostrdb.add(event)
window.nostrdb.query(filters)
window.nostrdb.count(filters)
window.nostrdb.event(id)
window.nostrdb.remove(ids)
window.nostrdb.replaceable(kind, author, identifier?)

// Access to metadata for a given pubkey.
// These are saved on local store and LRU-cached in memory, with automatic cache invalidation.
// And when a request has to be made it will be sent to the correct outbox relays and batched.
window.napp.utils.loadNostrUser(request)
window.napp.utils.loadRelayList(pubkey)
window.napp.utils.loadFollowsList(pubkey)
window.napp.utils.loadMuteList(pubkey)
window.napp.utils.loadBookmarks(pubkey)
window.napp.utils.loadPins(pubkey)
window.napp.utils.loadBlossomServers(pubkey)
window.napp.utils.loadEmojis(pubkey)
window.napp.utils.loadFavoriteRelays(pubkey)
window.napp.utils.loadBlockedRelays(pubkey) // kind 10006
window.napp.utils.loadSearchRelays(pubkey) // kind 10007
window.napp.utils.loadDmRelays(pubkey) // kind 10050, NIP-17
window.napp.utils.loadWikiAuthors(pubkey)
window.napp.utils.loadWikiRelays(pubkey)
window.napp.utils.loadFavoriteFollowSets(pubkey) // kind 10021
window.napp.utils.loadFavoriteScrolls(pubkey) // kind 10027
window.napp.utils.loadProfileBadges(pubkey) // kind 10008
window.napp.utils.loadSimpleGroups(pubkey) // kind 10009
window.napp.utils.loadGitAuthors(pubkey) // kind 10017
window.napp.utils.loadGitRepositories(pubkey) // kind 10018
window.napp.utils.loadMediaFollows(pubkey) // kind 10020
window.napp.utils.loadFavoritePodcasts(pubkey) // kind 10054
window.napp.utils.loadAuthoredPodcasts(pubkey) // kind 10064
window.napp.utils.fetchFavoriteRelaysWithSets(pubkey)
window.napp.utils.fetchEmojisWithSets(pubkey)
window.napp.utils.fetchFavoriteFollowSetsWithSets(pubkey)
window.napp.utils.loadFollowSets(pubkey)
window.napp.utils.loadRelaySets(pubkey)
window.napp.utils.loadEmojiSets(pubkey)

// Search, publishing and other utils.
window.napp.utils.loadRelayInfo(url)
window.napp.utils.searchUserLocal(term)
window.napp.utils.searchUser(term)
window.napp.utils.loadEvent(code, relays?, author?)
window.napp.utils.loadEvents(ids)
window.napp.utils.verifyEvent(event)
window.napp.utils.generateKey()
window.napp.utils.signWithKey(event, sk)
window.napp.utils.saveFile(name, data, type?)
window.napp.utils.copyText(text)
window.napp.utils.publish(event, relays?)

// Synchronous helpers
window.napp.nip19.decode(bech)
window.napp.nip19.npubEncode(hex)
window.napp.nip19.noteEncode(hex)
window.napp.nip19.neventEncode(pointer)
window.napp.nip19.naddrEncode(pointer)
window.napp.fx.isHex64(value)
window.napp.fx.parseCoordinate("kind:pubkey:d")
window.napp.fx.formatCoordinate(pointer)
window.napp.fx.satsFromBolt11(invoice)

// Relay health (NIP-66)
window.napp.relays.health(urls)

// UI kit, with `requires: ["ui"]`: the launcher's controls as elements
window.napp.ui.button({ label, variant, icon, onClick })
window.napp.ui.chip({ label, active, icon, onClick })
window.napp.ui.tabs({ items, active, onChange }) // .select(value), .value
window.napp.ui.tab({ label, active, onClick })
window.napp.ui.icon(name)
window.napp.ui.icons // the glyphs, by name; add your own
window.napp.ui.details({ summary, open })
window.napp.ui.input({ placeholder, value })
window.napp.ui.field({ label, control, note })
window.napp.ui.check({ label, note, checked, onChange })
window.napp.ui.radio({ name, label, checked, onChange })
window.napp.ui.radios({ name, options, value, onChange }) // .value
window.napp.ui.overline(text)
window.napp.ui.ring(word)
window.napp.ui.list({ items, label, controls, add, empty }) // .add(item), .delete(item), .items
window.napp.ui.itemList()
window.napp.ui.item({ label }, ...controls)
window.napp.ui.rowList()
window.napp.ui.row(list, ...summary)
window.napp.ui.addControl({ label, placeholder, onAdd })
window.napp.ui.el(tag, class, ...children)
window.napp.ui.stack(...children)
window.napp.ui.bar(...children)

window.napp.close()
window.napp.link(url)
window.napp.log(message)
```

`window.napp.relays.health(urls)` answers, per relay, what the NIP-66 monitors
say: `status` (`online` if checked in the last 2 hours, `offline` if checked
this week but not since, `unknown` otherwise), `checkedAt`, `rtt` (ms),
`nips`, `requires` (`auth`, `payment`, …) and `rank`, the relay's place across
the user's follows (null if unranked). Waits up to 6 s for relays the launcher
hasn't asked about yet; up to 200 urls per call.

`window.napp.log(message)` appends a line to the launcher's logs window,
prefixed with the napp's id — for reports (a publish and what each relay
answered, say), not prompts. One printable line of up to 400 characters, at
most 60 lines per 10 seconds per napp; anything beyond is dropped.

TypeScript declarations: [`napp-env.d.ts`](./napp-env.d.ts).

Napps can use the feed helpers for live event streams:

```js
window.napp.feeds.profile(pubkey, kinds, callback, { since, until, limit })
window.napp.feeds.following(source, kinds, callback, options)
window.napp.feeds.inbox(pubkey, kinds, callback, options)
window.napp.feeds.outbox(pubkeys, kinds, callback, options)
window.napp.feeds.relay(relays, kinds, callback, options)
```

Each returns a handle with `close()`. `relay` reads only the relays given, up
to 20, and nothing from the launcher's cache.

## Actions

Register handlers for actions other apps or share links send to the napp:

```js
window.napp.registerAction("profile", (name, pubkey) => {
  // render profile
})
```

Use `window.napp.action()` to delegate work to another app.

There is no restriction on what actions are allowed, but these are some of the common ones:

| Action               | Payload                             | Returns                         |
| -------------------- | ----------------------------------- | ------------------------------- |
| `view`               | `nevent`/`naddr` **or** full event  |                                 |
| `view:<kind-number>` | full event object (always resolved) |                                 |
| `profile`            | `pubkey` as hex                    |                                 |
| `feed`               | list of pubkey strings              |                                 |
| `relay`              | list of relay URLs                  |                                 |
| `wiki-term`          | a `d`-tag NIP-54 normalized string  | the resolved `kind:30818` event |

`view` may receive an `nevent`, `naddr`, or resolved event. A specific
`view:<kind-number>` always receives a resolved event: the launcher resolves
`nevent`/`naddr`/`nostr:` references (or the event as JSON) to the full event
before delivery, and drops the dispatch when the event can't be fetched. A
generic `view` is resolved the same way when possible; an unresolvable
reference is delivered as-is, so generic handlers must still accept strings.
Pass `{ instance: "..." }` as the third argument to target one running window, or
`{ auxiliary: true }` to use auxiliary handlers.

The app can also receive action state through `popstate`:

```js
addEventListener("popstate", event => {
  const action = event.state?.action
  if (action) render(action.name, action.payload)
})
history.pushState({ action: { name: "profile", payload: pubkey } }, "")
```

## Permissions

Declare required domains in `requires`. The launcher asks for permission on first launch and stores the grant. Sensitive operations such as signing, clipboard access, and file saving prompt separately.

The `ui` domain injects `/napp-ui.css` and `/napp-ui.js`: the launcher's
buttons, inputs, disclosures, checks, icons, fonts and `--surface`/`--text`
theme variables, and the helpers that build them as `window.napp.ui`. The
stylesheet lands before the napp's own, so the napp can override it; its
classes (`btn btn-primary`, `ui-input`, `ui-details`, …) are documented in it
for markup that doesn't go through the helpers, and `/styles/` on the launcher
shows every element with its call and its markup. Napps without `ui` are
unaffected. `network` controls direct connections from the app's own origin;
Nostr bridge calls do not require direct relay access.

## Runtime

Each napp runs at its own origin in a sandboxed iframe. The bridge is its only channel to the launcher. The launcher serves published files through a service worker backed by local storage.

The launcher first opens a hidden `/boot.html` iframe. That iframe registers
the service worker and writes app files to origin storage. The visible iframe
then loads from that origin. `window.name` carries the instance id across
same-origin navigations, so per-instance state survives reloads.
