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

// NIP-51 list loaders
window.napp.utils.loadRelayList(
  pubkey: string,
  hints?: string[],
  refreshStyle?: boolean | NostrEvent | null,
  defaultItems?: RelayItem[]
): Promise<ListResult<RelayItem>>
window.napp.utils.loadFollowsList(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadMuteList(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadBookmarks(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadPins(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadBlossomServers(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadEmojis(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadFavoriteRelays(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadFavoriteScrolls(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadWikiAuthors(pubkey, hints?, refreshStyle?, defaultItems?)
window.napp.utils.loadWikiRelays(pubkey, hints?, refreshStyle?, defaultItems?)

// Addressable sets
window.napp.utils.loadFollowSets(pubkey, hints?, forceUpdate?)
window.napp.utils.loadFollowPacks(pubkey, hints?, forceUpdate?)
window.napp.utils.loadRelaySets(pubkey, hints?, forceUpdate?)
window.napp.utils.loadEmojiSets(pubkey, hints?, forceUpdate?)

// Relay metadata
window.napp.utils.loadRelayInfo(url, refreshStyle?)

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

### Origin sandboxing

Each napp runs at its own origin (a unique `<nappId>` subdomain). From the iframe, `window.parent` is cross-origin, so the napp can't reach into the launcher. The bridge is the only channel.

### Boot flow

1. The launcher opens a hidden iframe at `<napp-origin>/boot.html`.
2. That iframe registers a service worker and writes the napp's files to its origin's IndexedDB via `postMessage`.
3. The launcher creates the visible iframe at `<napp-origin>/`. The service worker serves the HTML and assets out of IDB.
4. The bridge picks up its `instanceId` from `window.name` (set by the parent before the iframe loads) and starts forwarding RPC.

`window.name` survives same-origin navigations, so reloading an iframe (during an update, for example) keeps the same instance id and per-instance state.
