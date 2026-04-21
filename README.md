# nostrapps

> ⚠️ **Work in progress.** Everything here is early and unfinished. APIs will change, bugs exist, and the security story isn't complete. Not for production use.

A browser-based launcher for **napps** — small Nostr apps served as [nsites](https://github.com/hzrd149/blossom/blob/master/docs/nsite.md) (kind 34128 events + Blossom blobs) or loaded from a local folder. The launcher ("nostrapps") downloads a napp once, caches its files, and runs it in an isolated, resizable window. The napp sees a NIP-07-style `window.nostr` plus a few extensions for shared relay pool, local event store (NIP-DB), and per-instance state.

## What it does today

- **Load a napp** by npub / nprofile / hex pubkey (fetches kind 34128 events, pulls blobs from Blossom), or by picking a local folder.
- **Sandboxing** — each napp runs at its own origin (`<id>.napps.localhost:5173` in dev), so `window.parent` is cross-origin and the iframe can't reach into the launcher.
- **Bridge** — a script injected into every napp exposes `window.nostr`, `window.nostrdb`, `window.nostr.pool`, and `window.nostr.instance` via `postMessage` RPC to the launcher.
- **Multiple instances** — open the same napp more than once; each window gets its own `instanceId`, its own per-instance storage, its own petname. Drag, resize, minimize, maximize.
- **Close vs destroy** — `×` closes a window but keeps the session; `⌫` wipes it (and its per-instance storage). Suggestions list shows closed sessions so you can reopen them with their saved position and state.
- **Persistence** — the launcher remembers open sessions, petnames, and the relay list across reloads. Napps' own per-origin IDB/localStorage is untouched.
- **Permissions** — privileged methods (`signEvent`, `nip04/44.*`, `pool.publish`, `pool.setRelays`) prompt the user on first use per napp and cache the decision.

## Example napps

A few sample napps are kept in a separate repo (coming soon):

- **profile** — trivial example; calls `window.nostr.getPublicKey()` and prints it.
- **notes** — textarea with per-instance auto-draft, a Save button that writes to the napp's own origin IDB, and a Publish button that signs a kind-1 event, stores it in the global nostrdb, and sends it to the pool's relays.
- **relays** — add/remove relays in the launcher's global pool via `window.nostr.pool.setRelays`.

In the meantime, any folder with an `index.html` works — click **Load folder…** in the launcher and pick one.

## Bridge API surface

Exposed inside every napp's iframe:

```js
// NIP-07 signer (forwarded to the user's extension via the launcher)
window.nostr.getPublicKey()
window.nostr.signEvent(evt)
window.nostr.getRelays()
window.nostr.nip04.encrypt|decrypt(pubkey, text)
window.nostr.nip44.encrypt|decrypt(pubkey, text)

// Shared relay pool managed by the launcher
window.nostr.pool.query(filters, opts?)
window.nostr.pool.publish(event, opts?)
window.nostr.pool.relays()
window.nostr.pool.setRelays(urls)

// Per-instance key/value storage (launcher-side IDB, keyed by instanceId)
window.nostr.instance.id              // this window's instance id
window.nostr.instance.get(key)
window.nostr.instance.set(key, value)
window.nostr.instance.delete(key)
window.nostr.instance.keys()

// Global event store, shape from NIP-DB draft
// https://github.com/nostr-protocol/nips/pull/2229
window.nostrdb.add(event)
window.nostrdb.query(filters)
window.nostrdb.count(filters)
window.nostrdb.event(id)
window.nostrdb.replaceable(kind, author, identifier?)
```

For napp-wide state shared across instances, napps can just use native `indexedDB` / `localStorage` at their own origin — no bridge needed.

## Running locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Firefox. Napps load at `*.napps.localhost:5173`, which those browsers resolve to 127.0.0.1 automatically.

**Brave users:** disable Shields for localhost — Brave blocks cross-site iframes (subdomains count as cross-site), which breaks the napp boot flow. Safari doesn't resolve `*.localhost` at all; use Chrome / Firefox / Brave-shields-down for now.

## Architecture notes

- Launcher at `localhost:5173` — no service worker; UI only.
- Each napp at `<nappId>.napps.localhost:5173` — its own SW serves files from that origin's IDB.
- Boot flow: launcher opens a hidden iframe at `<napp-origin>/boot.html`, which registers the SW and writes the napp's files to IDB via `postMessage`. Then the visible iframe loads `<napp-origin>/` and the SW serves the HTML with the bridge script injected.
- `@nostr/gadgets/redstore` (OPFS-backed SQLite via a Web Worker) powers the global event store.

## Status / roadmap

Rough, and much of this is already sketched in but not polished:

- [ ] NIP-46 (bunker) signer
- [ ] `window.nostrdb.subscribe()` streaming API
- [ ] Per-napp permission management UI in the launcher (revoke, review)
- [ ] Real nsite publishing from inside the launcher
- [ ] Desktop packaging
- [ ] Docs, tests, polish

## License

None yet.
