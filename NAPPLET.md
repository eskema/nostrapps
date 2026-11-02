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

Every napplet receives all implemented APIs, regardless of its `R` and `O` declarations or permissions. Implemented domains include `identity`, `theme`, `storage`, `resource`, `relay`, `outbox`, `common`, `inc`, `intent`, `link`, and `config`.

TypeScript declarations: [`napplet-env.d.ts`](./napplet-env.d.ts).

## Permissions

The install screen grants permission to use the requested APIs; it does not
control API availability. A checked permission authorizes use without an
additional prompt. Selecting “ask” requires approval before use, with separate
remembered decisions for HTTPS, HTTP, and Blossom resource reads, relay reads,
outbox reads, publishing, social writes, and opening links. An unchecked
permission denies calls; its API remains present and returns an error.

Each approval can allow one operation, allow that operation for the launcher
session, or remember an allow/deny decision on this device. Napplet decisions
are scoped to the connected account and app identity. These saved decisions
are separate from the app's install-screen grants. Session approvals end when the page
reloads or the account changes; they are excluded from backups. Updates to the
same installed app retain remembered decisions. Older global napplet decisions
are not reused.

Settings → permissions lists the current account's remembered and session
approvals. Forgetting an approval cancels the app's pending operations and live
relay subscriptions; operations configured to ask request approval again.
Revoking a permission takes effect immediately; all APIs remain present.
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

## Linking napplets with NAP-INTENT

Declare the `intent` domain to send or receive intents. A receiver advertises
its archetype and exact supported conventions:

```html
<meta name="napplet-requires" content="intent" />
<meta name="napplet-archetype" content="note" />
<meta name="napplet-intent" content="napplet:note/open id" />
```

These become `R intent`, `z note`, and `i napplet:note/open id` manifest tags.
Parameter names describe the contract; the host preserves the payload without
coercing it. An INC-only manifest is not an intent delivery target.

```js
// Receiver: delivery is buffered until a listener is registered.
const subscription = napplet.intent.onDelivery(({ sender, convention, payload }) => {
  showNote(payload.id)
})
// subscription.close() removes the listener.

// Sender: resolve a compatible receiver and open it.
const result = await napplet.intent.open("napplet:note/open", {
  payload: { id: "note-id" },
  behavior: { focus: true, reuse: true }
})
if (!result.ok) console.log(result.error)
```

Napplets can also use ordinary anchors or `napplet.link.open()`:

```html
<a href="napplet:note/open?id=note-id">Open note</a>
```

URI query values are percent-decoded strings. Query payloads cannot accompany
`options.payload`; duplicate decoded query keys and malformed escapes are rejected.
An optional `#naddr1…` fragment recommends a named napplet for discovery; it never
bypasses verification, compatibility checks, permission grants, or selection.

`intent.handlers()` returns availability grouped by archetype;
`intent.available("note")` returns one group. Candidates include opaque runtime
IDs, supported actions, conventions, and parameter contracts. Pass a candidate's
`id` as `options.handler` to select that exact candidate. IDs last for the current
account session; bare manifest identifiers are not accepted. `intent.onChanged()`
subscribes to catalog changes and returns a closeable subscription. Private
preference references never appear in this public catalog.

The chooser offers compatible verified napplets and, for supported payloads,
existing NAPP actions. Settings → intent handlers manages ordered defaults and
per-convention overrides, including public/private visibility. Preferences use
kind `31129` events keyed by archetype: `a`/`e` tags supply ordered fallback
handlers, `i` tags supply convention overrides, and NIP-44 self-encrypted content
holds private tags. Private convention overrides precede public overrides, then
private and public archetype defaults. Unavailable handlers fall through to the
next compatible handler or the chooser. Device-local route choices select
napplets or NAPP actions and can be forgotten separately.

The fixed NAPP compatibility mappings from napplet-frame are supported for
profiles, feeds, relays, groups, hashtrees, and supported `view:<kind>` actions.
NAPP callers can use `napp.action("nap-intent", { uri, payload? })` or an exact
queryless convention as an action name.

Successful invocation means the host accepted delivery responsibility, not that
the receiver finished its task. The host assigns `sender` from the authenticated
source window. Closing/reloading the source, changing accounts, or revoking its
permission cancels pending work. Targets are signature/hash verified before
execution and remain opaque sandboxed iframes without a signer. Deliveries are
one-shot and are never stored in window history, restore state, or share links.
