# nostrapps

Nostrapps is a browser launcher for Nostr apps. Apps are static sites published as [nsites](https://nips.nostr.com/5A), or folders opened locally. The launcher fetches apps, caches them, and runs each in its own sandboxed window.

## App kinds

Published manifests use event kind to identify app type:

| App type | Event kinds              | Documentation                         |
| -------- | ------------------------ | ------------------------------------- |
| nsite    | `35128`                  | Static multi-file site.               |
| napp     | `35130`                  | [Napp documentation](./NAPP.md)       |
| napplet  | `5129`, `15129`, `35129` | [Napplet documentation](./NAPPLET.md) |

Kind determines classification. Manifest tags do not change it.

## Sharing a space

Share links carry apps as naddrs and actions as `<name>~<payload>`:

```
https://<launcher>/#space=my-space&app=naddr1…&action=profile~npub1…&app=naddr1…
```

Links open apps in an ephemeral space. **Keep** installs apps and preserves the space; reload discards unkept state.

## Hosting

The launcher is static files. Napps run on wildcard subdomains: serve the same files for `<launcher>` and `*.<launcher>` with a wildcard certificate, and no SPA catch-all — napp origins must get `/sw.js`, `/boot.html` and `/assets/*` as real files. Runtime files must never be cached or a napp origin keeps a stale kit silently: serve `/sw.js /boot.html /bridge.js /nostr-crypto.js /napp*` with `Cache-Control: public, max-age=0, must-revalidate`.

## Napp development

Read [Napp development](./NAPP.md) and use [`napp-env.d.ts`](./napp-env.d.ts) for TypeScript declarations. Napps use `window.napp` as well as `window.nostr` and `window.nostrdb`.

## Wasm napps

A napp can be one WebAssembly module instead of a page. The launcher runs the
module itself and gives it a canvas to paint into — no DOM, no iframe, no
JavaScript. Read [wasm napps](./WASM.md). The same modules run in
[verdana](https://github.com/fiatjaf/verdana), in a window of its own.

## Napplet compatibility

Read [Napplet compatibility](./NAPPLET.md) and use [`napplet-env.d.ts`](./napplet-env.d.ts) for TypeScript declarations. Napplets use NIP-5D `window.napplet`.
