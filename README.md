# nostrapps

> Heads up: still rough around the edges. APIs will move, things will break.

Nostrapps is a small browser launcher for Nostr apps. Each app is a static site published as an [nsite](https://nips.nostr.com/5A), or just a folder you point at locally. The launcher fetches it once, caches it, and runs it in its own sandboxed window with a `window.nostr` bridge wired to your NIP-07 extension.

## How to use it

The whole UI is one input. Type something and press enter:

- An npub, nprofile, hex pubkey, or naddr to fetch and run that nsite.
- A NIP-5A hostname like `eskema.nsite-host.com`.
- A slash command for one of the built-in tools.
- Anything you've launched before, picked from the suggestions dropdown.

Click the input and you'll see a dropdown grouped into three sections: slash commands first, your last 5 opened sessions next, then everything else alphabetically. `OPEN` and `CLOSED` rows reopen that exact session at its saved position. `NAPP` rows launch a fresh instance.

### Slash commands

Four built-in panels open the first time you load the launcher and remember whether you closed them after that.

- `/store` — discover and install nsites your relays know about. Search, filter, update.
- `/settings` — theme picker (light, dark, auto), connect or disconnect your account, load a local folder.
- `/logs` — what the launcher is doing right now, with timestamps.
- `/permissions` — every grant or denial you've made, per app. Forget any of them.

There's also `/folder` as a shortcut to the folder picker.

### Window controls

| Button | Does                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------- |
| `–`    | Minimize. Header only, body collapses.                                                               |
| `▢`    | Maximize, or restore.                                                                                |
| `•`    | Pin on top. Fills in (`●`) when active. Stays above everything, even after you click somewhere else. |
| `×`    | Close. The session is remembered, type the name back to reopen at its saved position.                |
| `⌫`    | Destroy. Wipes the app and all its data. There's a confirm prompt.                                   |

Drag the header to move. Drag any edge or corner to resize. Double-click the title to rename it.

### Snap zones

Drag a window near an edge or corner of the stage and stop moving for about 300ms. A preview lights up showing the half or quadrant it'll fill. Drop on it to snap.

### Mobile gestures

On a narrow screen the layout switches to a vertical stack and the snap zones go away. To reorder, press and hold a window's header for about a quarter second, then drag up or down.

### Installing and updating from the store

`/store` queries your relays for nsite manifests the first time you open it, then caches the results so subsequent opens are instant. Hit `↻` to check for updates, `⚙` to override the relay list.

Each card shows what the manifest provides: title, description, author, file count, date. The button on the right has three states:

- **install**: not installed yet.
- **uninstall**: currently installed and up to date.
- **update**: currently installed, but the relay has a newer manifest. Click to fetch the new files and reload any open windows of the app in place. Per-instance state survives the update.

The `installed` filter shows what you have right now at the top, then a "Previously installed" section below for apps you've uninstalled.

### Working without an account

The store works without connecting. It falls back to a small default set of relays for discovery, and you can override that anytime. Connecting just lets it use your kind 10002 list instead.

You can also browse and run nsites that don't need a signer, like a static blog. The moment an app calls `signEvent` or anything else privileged, you'll get a permission prompt. Your answer is remembered per app, per method.

---

## For developers

### Building a napp

A napp is any folder with an `index.html`. Inside the iframe you get:

```js
// NIP-07 signer, forwarded to your extension via the launcher
window.nostr.getPublicKey()
window.nostr.signEvent(evt)
window.nostr.nip04.encrypt|decrypt(pubkey, text)
window.nostr.nip44.encrypt|decrypt(pubkey, text)

// Shared relay pool, managed by the launcher
window.nostr.pool.query(filters, opts?)
window.nostr.pool.publish(event, opts?)

// Per-window state. Each window has its own bucket, keyed by instanceId.
window.nostr.instance.id
window.nostr.instance.get(key)
window.nostr.instance.set(key, value)
window.nostr.instance.delete(key)
window.nostr.instance.keys()

// Global event store (NIP-DB draft)
window.nostrdb.add(event)
window.nostrdb.query(filters)
window.nostrdb.count(filters)
window.nostrdb.event(id)
window.nostrdb.replaceable(kind, author, identifier?)
```

You also get data-loading helpers executed on the host via `@nostr/gadgets`:

```js
// NIP-51 lists
window.napp.utils.loadRelayList(pubkey, hints?, refreshStyle?, defaultItems?)
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

// Profile metadata
window.napp.utils.loadNostrUser(request) // NostrUserRequest | string → NostrUser
```

Each function's signature matches `@nostr/gadgets` exactly. The call is forwarded to the host, which runs the real query against the shared relay pool and caches the result.

The host also pushes runtime signals to every napp via `postMessage`. Bridge.js relays them:

- **`napp-theme-change`**: sets `document.documentElement.dataset.theme` to `"light"` or `"dark"`. Sent when the launcher's theme changes, so the napp can adjust its own styles.

For data tied to the app rather than a specific window, use the napp's own `localStorage` or `indexedDB`. Each napp lives at its own origin so everything is naturally isolated.

### Origin sandboxing

Each napp runs at its own origin (a unique `<nappId>` subdomain). From the iframe, `window.parent` is cross-origin, so the napp can't reach into the launcher. The bridge is the only channel.

The `nappId` is derived from the manifest: for a root manifest (kind 15128) it's the first 40 hex chars of the publisher's pubkey, and for a named manifest (kind 35128) it's that plus `-<dTag>`.

### Boot flow

1. The launcher opens a hidden iframe at `<napp-origin>/boot.html`.
2. That iframe registers a service worker and writes the napp's files to its origin's IndexedDB via `postMessage`.
3. The launcher creates the visible iframe at `<napp-origin>/`. The service worker serves the HTML and assets out of IDB.
4. The bridge picks up its `instanceId` from `window.name` (set by the parent before the iframe loads) and starts forwarding RPC.

`window.name` survives same-origin navigations, so reloading an iframe (during an update, for example) keeps the same instance id and per-instance state.

### How updates work

When the launcher installs a napp it stores the full manifest event keyed by its event `id`. The store compares the stored event's `created_at` against the latest manifest from your relays. Newer `created_at` means an update is available.

Clicking update re-fetches the manifest and blobs, reuses the boot iframe to swap the files store atomically (the install handler clears the store before writing), writes the new manifest event, and then reassigns `iframe.src` on every open window of that napp so the new files take effect right away.

### How destroy works

Close keeps the session and its per-instance state. Destroy is the full nuke. The launcher forgets the session, all its petnames, the install log entry, and any cached permission decisions. Then a hidden boot iframe at the napp's origin clears every IndexedDB on that origin, plus `localStorage`, `sessionStorage`, every CacheStorage entry, and every service worker registration. Reinstalling later starts from a clean slate.

There's a confirm prompt before all that happens.

### Permissions

These RPC methods prompt on first use per napp:

- `signEvent`
- `nip04.encrypt`, `nip04.decrypt`
- `nip44.encrypt`, `nip44.decrypt`
- `pool.publish`

The dialog gives you Allow once, Allow always, Deny once, Deny always. The "always" answers are cached. `/permissions` shows the full list and lets you revoke any of them.

### Running locally

```bash
npm install
npm run dev
```

### Persistence keys

All in `localStorage`, prefixed with `nostrapps:`:

- `open` — array of session entries (open and closed)
- `known` — recently launched nappIds
- `petnames` — petname to nappId map
- `installLog` — every nappId ever installed (kept across destroy, used for the store's "previously installed" section)
- `installed` — full manifest events keyed by event id, used for update detection
- `handlerPrefs` — per-caller scoped action handler preferences
- `history` — recent raw inputs typed into the launch box
- `permissions` — per-nappId per-method allow/deny decisions
- `theme` — `light`, `dark`, or absent (= auto)
- `bootstrapped` — set after the first launcher load auto-opens the system napps
- `pubkey` — the connected pubkey
- `store:relays` — custom relay list for the store, if any

Per-instance KV (`window.nostr.instance.*`) lives in the launcher's IndexedDB instead, keyed by instanceId.

### Stack

Vanilla JS with Vite. `@nostr/tools` and `@nostr/gadgets` for the protocol bits. `@nostr/gadgets/redstore` (OPFS-backed SQLite via a Web Worker) powers the global event store. No framework.

## Roadmap

- NIP-46 (bunker) signer
- Streaming `nostrdb.subscribe()`
- Publishing nsites from inside the launcher
- Desktop wrapper

## License

[Unlicense](LICENSE) — released into the public domain. Do whatever you want with it.
