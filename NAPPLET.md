# Napplets

A napplet is a NIP-5D app published as its own event kind. Napplet kinds are:

| Kind    | Role             |
| ---     | ---              |
| `5129`  | Snapshot napplet |
| `15129` | Root napplet     |
| `35129` | Named napplet    |

Napplet kind, not manifest tags, identifies the app as a napplet.

## Format

A napplet is one self-contained `/index.html`. Its metadata is read from HTML rather than `metadata.json`:

```html
<meta name="napplet-id" content="counter">
<meta name="napplet-requires" content="identity,storage">
<title>Counter</title>
```

The manifest uses `path` tags and content hashes. The launcher verifies the manifest signature, fetches `/index.html` from Blossom, verifies its hash, and runs it only after verification.

## Runtime

Napplet windows run as sealed `srcdoc` iframes with no origin and no `window.nostr`. They communicate through the NIP-5D `window.napplet` bridge.

```js
const pubkey = await window.napplet.identity.getPublicKey()
const value = await window.napplet.storage.get("counter")
```

Domains are granted individually through `requires` declarations. Available domains include `identity`, `theme`, `storage`, `resource`, `relay`, `outbox`, `common`, `inc`, `link`, and `config`.

TypeScript declarations: [`napplet-env.d.ts`](./napplet-env.d.ts).
