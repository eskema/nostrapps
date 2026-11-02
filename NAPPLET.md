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
const value = await window.napplet.storage.getItem("counter")
```

Domains are granted individually from the declared `R` and `O` domains. Available domains include `identity`, `theme`, `storage`, `resource`, `relay`, `outbox`, `common`, `inc`, `link`, and `config`.

TypeScript declarations: [`napplet-env.d.ts`](./napplet-env.d.ts).

## Permissions

The install screen controls which declared domains are available. Enabling a
napplet domain does not approve every operation in it. HTTPS, HTTP, and Blossom
resource reads, relay reads, outbox reads, publishing, social writes, and opening
links have separate approvals.

Each approval can allow one operation, allow that operation for the launcher
session, or remember an allow/deny decision on this device. Napplet decisions
are scoped to the connected account and app identity, so an approval for one
account never authorizes another account. Session approvals end when the page
reloads or the account changes; they are excluded from backups. Updates to the
same installed app retain remembered decisions. Older global napplet decisions
are not reused: those operations ask again after upgrading.

Settings → permissions lists the current account's remembered and session
approvals. Forgetting an approval cancels the app's pending operations and live
relay subscriptions; its next operation asks again. Removing a domain takes
effect immediately and rebuilds open napplet windows with the updated bridge.
Closing or reloading a window cancels its pending requests and prompts, including
when another window of the same app remains open. Account changes invalidate
pending approvals and prevent an event signed for the previous account from
being published.

Napp and nsite row-level permission controls retain their existing behavior.

## Downloads and offline reuse

Napplet HTML and resource downloads have an 8 MiB limit, enforced while reading
the response as well as through Content-Length. Napplet artifact loading races
up to four Blossom servers and cancels the remaining requests after obtaining
verified bytes. Requests omit credentials and referrers and reject redirects.
Host-created blob URLs are unavailable as resource inputs; napplets can create
local object URLs from returned Blobs.

Verified HTML artifacts use a 32 MiB memory cache and a bounded persistent cache.
Persistent cache entries are hash-checked before use, and the manifest signature
is checked on every load. A cached artifact can reopen without network access;
storage failures fall back to normal downloads.

## Validation

Run `bun run check`, `bun run test`, and `bun run build`. The Playwright suite
covers account isolation, session grants, revocation, consent cancellation,
iframe permissions and reloads, signer account checks, download limits, and
verified artifact caching.
