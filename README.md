# nostrapps

Nostrapps is a browser launcher for Nostr apps. Apps are static sites published as [nsites](https://nips.nostr.com/5A), or folders opened locally. The launcher fetches apps, caches them, and runs each in its own sandboxed window.

## App kinds

Published manifests use event kind to identify app type:

| App type | Event kinds              | Documentation                         |
| ---      | ---                      | ---                                   |
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

## Napp development

Read [Napp development](./NAPP.md) and use [`napp-env.d.ts`](./napp-env.d.ts) for TypeScript declarations. Napps use `window.napp` as well as `window.nostr` and `window.nostrdb`.

## Napplet compatibility

Read [Napplet compatibility](./NAPPLET.md) and use [`napplet-env.d.ts`](./napplet-env.d.ts) for TypeScript declarations. Napplets use NIP-5D `window.napplet`.
