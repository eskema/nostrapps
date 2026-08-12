# nostrapps

Nostrapps is a small browser launcher for Nostr apps. Each app is a static site published as an [nsite](https://nips.nostr.com/5A), or just a folder you point at locally. The launcher fetches it once, caches it, and runs it in its own sandboxed window with a set of utilities for seamless Nostr integration.

## For developers

The idea is that each napp is a very small, specialized app. It should do one (or few) things and do them well. It should call `window.napp.registerAction()` in order to receive the parameters it will use (for example, an app that displays any information related to a profile should call that to register the `"profile"` action) and it should call `window.napp.action()` for anything it doesn't handle internally (for example, an app that displays a list of notes but doesn't handle threads or an expanded view of such notes should call out to other apps with the `view:1` action).

A napp is any folder with an `index.html`. Inside the iframe you get:

```js
// NIP-07 signer, mediated by the launcher. Present only when `identity` is
// granted (see Permissions below). getPublicKey() answers from the cached
// account key and never prompts.
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

// Batched by-id fetching: one REQ over the id union; non-64-hex ids dropped.
window.napp.utils.loadEvents(ids)

// Verify an event's id + signature on the host (nostr-tools verifyEvent).
window.napp.utils.verifyEvent(event)

// Saving a file to disk (the sandbox blocks <a download>; prompts the user)
window.napp.utils.saveFile(name, data, type?)
//   data: Blob | ArrayBuffer | ArrayBufferView — prefer Blob (clones by reference)
//   returns { name, size } — name reduced to a basename

// Copying text to the clipboard (navigator.clipboard rejects in the sandbox;
// prompts the user with a preview of the text)
window.napp.utils.copyText(text)
//   text: string, max 100k chars
//   returns { length }

// Publishing
window.napp.utils.publish(event, relays?)
//   event: NostrEvent (must be signed)
//   relays?: string[] — if omitted, publishes to the author's write relays
//     (for kind 10002 also publishes to fallback + indexer relays)
//   returns { relays: {[url]: { ok, error? }}, published, failed }
//   for kinds handled by load* methods, also updates the local cache so
//     subsequent load* calls reflect the change immediately

// Sync helpers (no rpc round-trip)
window.napp.nip19.decode(bech) // npub/note/nsec/nprofile/nevent/naddr
window.napp.nip19.npubEncode|noteEncode|neventEncode|naddrEncode(...)
window.napp.fx.isHex64(s)
window.napp.fx.parseCoordinate("kind:pubkey:d") // → { kind, pubkey, identifier } | null
window.napp.fx.formatCoordinate({ kind, pubkey, identifier })
window.napp.fx.satsFromBolt11(invoice)
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

- **`napp-theme-change`**: sets `data-theme` (`"light"`/`"dark"`) on `<html>` and the launcher's `--surface`/`--text` tokens on `:root`, so napps using them track the theme automatically.

### Shared UI (opt-in)

A napp can adopt the launcher's design system (buttons, inputs, disclosures, checkboxes, icons) by declaring the `ui` capability in its `requires`:

```json
{ "requires": ["ui"] }
```

`ui` is auto-granted (never a permission toggle) and implies `theme`. The service worker injects `<link rel="stylesheet" href="/napp-ui.css">` before your own styles, so you can override anything. It provides `.btn` (+ `-primary`/`-outline`/`-danger`/`-warning`/`-ghost`/`-link`), `.ui-input`, `.ui-details`, `.ui-check`, and `.ui-icon-*`, with fonts and icons inlined and `--surface`/`--text` tracking the theme. Napps that don't declare `ui` are unaffected. (`"ui": "wrapper"` in `metadata.json` still works as back-compat.)

### `window.napplet` (NIP-5D, experimental)

The launcher is a partial [NAP](https://github.com/napplet/naps) runtime. An app opts in by declaring the capability domains it needs, either as `["requires", "<domain>"]` manifest tags or as a `requires` array in `metadata.json`:

```json
{ "requires": ["identity", "theme", "storage"] }
```

`window.napplet` contains only the granted domains, so to know if you have one, check that it exists:

```js
if (window.napplet?.identity) {
  const pk = await window.napplet.identity.getPublicKey() // cached key, never prompts
}
```

Domains implemented: `identity`, `theme`, `storage`, `resource`, `relay`, `outbox`. Shapes follow [`@napplet/nap`](https://github.com/napplet/web); the exact surface is in [`env.d.ts`](./env.d.ts).

nsites get `window.napplet` alongside `window.napp` and can mix both. True napplets (kind 35129) are single-file apps loaded as a sealed `srcdoc` iframe, with no origin and no `window.nostr`. They publish unsigned templates through `relay`/`outbox` and the host signs behind a prompt.

### Permissions

Before an app first runs, the launcher shows what it declared; the grants are stored and enforced per call. Two launcher-local capabilities join the NAP domains:

- `identity`: `window.nostr`. When denied the signer is gone, pinned so an extension can't re-inject it.
- `network`: the app's own direct connections, on by default for nsites. Not relay access: nostr always flows through the bridge, which works sealed. When denied the app is served under a locked CSP (`default-src 'self'`, and `worker-src 'none'` since workers have their own network) and any service worker it registered is unregistered.

Declared domains the launcher doesn't implement are shown as non-grantable, so it's visible what won't work. Sensitive calls (`signEvent`, `nip04`/`nip44`, `saveFile`, `copyText`) still prompt per call. App data is only cleared on uninstall.

### Origin sandboxing

Each napp runs at its own origin (a unique `<nappId>` subdomain). From the iframe, `window.parent` is cross-origin, so the napp can't reach into the launcher. The bridge is the only channel. True napplets don't get an origin at all; their only persistence is the `storage` domain.

### Boot flow

1. The launcher opens a hidden iframe at `<napp-origin>/boot.html`.
2. That iframe registers a service worker and writes the napp's files to its origin's IndexedDB via `postMessage`.
3. The launcher creates the visible iframe at `<napp-origin>/`. The service worker serves the HTML and assets out of IDB.
4. The bridge picks up its `instanceId` from `window.name` (set by the parent before the iframe loads) and starts forwarding RPC.

`window.name` survives same-origin navigations, so reloading an iframe (during an update, for example) keeps the same instance id and per-instance state.
