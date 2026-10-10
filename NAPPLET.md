# Napplets

A napplet is a NIP-5D app published as its own event kind. Napplet kinds are:

| Kind    | Role             |
| ------- | ---------------- |
| `5129`  | Snapshot napplet |
| `15129` | Root napplet     |
| `35129` | Named napplet    |

Napplet kind, not manifest tags, identifies the app as a napplet.

## Format

A napplet is one self-contained `/index.html`. Its metadata is read from the HTML head rather than `metadata.json`:

```html
<title>Counter</title>
<meta name="description" content="Counts things" />
<meta name="napplet-id" content="counter" />
<meta name="napplet-requires" content="identity storage" />
<meta name="napplet-optional" content="theme" />
<link rel="icon" href="data:image/png;base64,..." type="image/png" />
```

The description is required and becomes the event content. `napplet-requires` and `napplet-optional` become `R` and `O` tags. The icon must be an inline png, jpeg or webp, uploaded as its own blob. `napplet-archetype`, `napplet-intent`, `napplet-source` and `napplet-server` are read too.

The manifest carries one `x` tag, the sha256 of `/index.html`. The launcher verifies the manifest signature, fetches `/index.html` from Blossom by that hash, verifies it, and runs it only after verification. Manifests in the old shape (`path` tags) don't load.

## Runtime

Napplet windows run as sealed `srcdoc` iframes with no origin and no `window.nostr`. They communicate through the NIP-5D `window.napplet` bridge.

```js
const pubkey = await window.napplet.identity.getPublicKey()
const value = await window.napplet.storage.get("counter")
```

Domains are granted individually from the declared `R` and `O` domains. Available domains include `identity`, `theme`, `storage`, `resource`, `relay`, `outbox`, `common`, `inc`, `link`, and `config`.

TypeScript declarations: [`napplet-env.d.ts`](./napplet-env.d.ts).
