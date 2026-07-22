# nostrapps

Nostrapps is a small browser launcher for Nostr apps. Each app is a static site published as an [nsite](https://nips.nostr.com/5A), or just a folder you point at locally. The launcher fetches it once, caches it, and runs it in its own sandboxed window with a set of utilities for seamless Nostr integration.

## For developers

The idea is that each napp is a very small, specialized app. It should do one (or few) things and do them well. It should call `window.napp.registerAction()` in order to receive the parameters it will use (for example, an app that displays any information related to a profile should call that to register the `"profile"` action) and it should call `window.napp.action()` for anything it doesn't handle internally (for example, an app that displays a list of notes but doesn't handle threads or an expanded view of such notes should call out to other apps with the `view:1` action).

A napp is any folder with an `index.html`. Inside the iframe you get:

```js
// NIP-07 signer, forwarded to your extension via the launcher
window.nostr.getPublicKey()
window.nostr.signEvent(evt)
window.nostr.nip04.encrypt|decrypt(pubkey, text)
window.nostr.nip44.encrypt|decrypt(pubkey, text)

// Global event store (NIP-DB draft)
window.nostrdb.add(event)
window.nostrdb.query(filters)
window.nostrdb.count(filters)
window.nostrdb.event(id)
window.nostrdb.replaceable(kind, author, identifier?)
window.nostrdb.supports() // returns []

// NIP-51 list loaders — accepts hex pubkey, npub, or nprofile
window.napp.utils.loadRelayList(pubkey: string): Promise<ListResult<RelayItem>>
window.napp.utils.loadFollowsList(pubkey)
window.napp.utils.loadMuteList(pubkey)
window.napp.utils.loadBookmarks(pubkey)
window.napp.utils.loadPins(pubkey)
window.napp.utils.loadBlossomServers(pubkey)
window.napp.utils.loadEmojis(pubkey)
window.napp.utils.loadFavoriteRelays(pubkey)
window.napp.utils.loadWikiAuthors(pubkey)
window.napp.utils.loadWikiRelays(pubkey)

// Addressable sets
window.napp.utils.loadFollowSets(pubkey)
window.napp.utils.loadRelaySets(pubkey)
window.napp.utils.loadEmojiSets(pubkey)

// Relay metadata
window.napp.utils.loadRelayInfo(url)

// Profile metadata
window.napp.utils.loadNostrUser(request) // NostrUserRequest | string → NostrUser

// Arbitrary event fetching
window.napp.utils.loadEvent(code, relays?, author?)

// Publishing
window.napp.utils.publish(event, relays?)
//   event: NostrEvent (must be signed)
//   relays?: string[] — if omitted, publishes to the author's write relays
//     (for kind 10002 also publishes to fallback + indexer relays)
//   returns { relays: {[url]: { ok, error? }}, published, failed }
//
// For kinds handled by load* methods (NIP-51 lists, addressable sets, contacts),
// publish() also updates the local cache with the published event so subsequent
// load* calls reflect the change immediately without re-fetching from relays.
```

### Streaming feeds

Napps can subscribe to live event streams. Each returns a handle with `.close()`:

```js
window.napp.feeds.profile(pubkey, kinds, callback, { since?, until?, limit? })
window.napp.feeds.following(source, kinds, callback, { since?, until?, limit? })
window.napp.feeds.inbox(pubkey, kinds, callback, { since?, until?, limit? })
```

`callback` will be called with `callback(events: NostrEvent[], synced: boolean)`.

### Registering action handlers

Napps can expose handlers for other windows to call:

```js
window.napp.registerAction(pattern, handler?)
// handler(name, payload) -> result
```

`pattern` is an exact match, with one special case: `"view"` matches all `"view:<any-number>"` actions.

The napp can omit the `handler` and opt into only handling actions via the `popstate` event. The host pushes history entries with `state: { action: { name, payload } }` — listen for `popstate` and read `event.state.action`. This lets actions participate in browser back/forward navigation.

There is no policing of what actions are allowed, but these are some of the common ones that can be used:

| Action               | Payload                                    |
| ---                  | ---                                        |
| `view`               | `nevent/naddr code` **or** full event      |
| `view:<kind-number>` | `full event object` (always resolved)      |
| `profile`            | `pubkey as hex`                            |
| `feed`               | `list of pubkey strings`                   |
| `relay_feed`         | `list of relay URLs`                       |

Apps registering `"view"` (generic, no number) may receive either a nip19 code string or a resolved event object and must handle both. Apps registering a specific `"view:<kind-number>"` always receive a resolved event object.

Optionally `{ instance: "<instanceId>" }` as the third argument to route the action directly to a specific running instance instead of launching a new one.

Each napp also gets its instance id at `window.napp.instance` (a string, unique per window).

TypeScript types for everything above live in [`env.d.ts`](./env.d.ts). Reference it in your napp's `tsconfig.json` or copy it as a starting point.

The host also pushes runtime signals to every napp via `postMessage`. bridge.js relays them:

- **`napp-theme-change`**: sets `document.documentElement.dataset.theme` to `"light"` or `"dark"` and injects the launcher's resolved color tokens as `--surface`, `--text`, etc. on `:root`. Sent when the launcher's theme changes, so napps using `var(--surface)` / `var(--text)` track automatically.

### Shared UI (opt-in)

A napp can adopt the launcher's design system — matching buttons, inputs, disclosures, checkboxes, and icons — by declaring `"ui": "wrapper"` in its `metadata.json`:

```json
{ "ui": "wrapper" }
```

When set, the launcher's service worker injects `<link rel="stylesheet" href="/napp-ui.css">` at the top of the napp's `<head>` (before your own styles, so you can still override anything). The stylesheet provides `.btn` (+ `.btn-primary` / `.btn-outline` / `.btn-danger` / `.btn-warning` / `.btn-ghost` / `.btn-link`), `.ui-input`, `.ui-details`, `.ui-check`, and `.ui-icon-*` classes, with the launcher's fonts and icons inlined as data URIs. Its `--surface` / `--text` tokens track the theme via `napp-theme-change`, so opted-in napps match the launcher in both light and dark mode. Napps that don't set the flag are unaffected and render entirely in their own styles.

### Origin sandboxing

Each napp runs at its own origin (a unique `<nappId>` subdomain). From the iframe, `window.parent` is cross-origin, so the napp can't reach into the launcher. The bridge is the only channel.

### Boot flow

1. The launcher opens a hidden iframe at `<napp-origin>/boot.html`.
2. That iframe registers a service worker and writes the napp's files to its origin's IndexedDB via `postMessage`.
3. The launcher creates the visible iframe at `<napp-origin>/`. The service worker serves the HTML and assets out of IDB.
4. The bridge picks up its `instanceId` from `window.name` (set by the parent before the iframe loads) and starts forwarding RPC.

`window.name` survives same-origin navigations, so reloading an iframe (during an update, for example) keeps the same instance id and per-instance state.
