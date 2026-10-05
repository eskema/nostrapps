# WASM napps

A napp is usually a folder of HTML, CSS and JavaScript that the launcher puts
in a sandboxed iframe. A **wasm napp** is not: it ships one WebAssembly module
and the launcher runs that module itself, handing it a canvas to paint into.
There is no DOM, no iframe, no service worker and no JavaScript in the running
app. The module draws pixels and the launcher shows them.

The same module runs in [verdana](https://github.com/fiatjaf/verdana), which
runs it in a window of its own with no browser involved at all. The contract
below is the same in both.

## Declaring one

A wasm napp is a directory with a `metadata.json` and an `app.wasm` beside
it, and no `index.html`:

```json
{
  "id": "wasm-egui",
  "title": "egui Canvas",
  "initial_size": { "width": 520, "height": 420 }
}
```

The module's name is fixed: always `/app.wasm`, in the folder, in the
manifest's `path` tags, and on disk after install. There is nothing to name
and no field for it. A folder with both an `index.html` and an `app.wasm` is
a page that happens to ship a wasm file, not a module that happens to ship a
page.

Published, the folder becomes a kind `35131` event: same manifest shape as a
napp (`path` tags, `title`, `icon`, `action`, `requires`, `initial_size`), no
extra tags. Kind decides what the app is; tags only describe it.

## The contract

### Imports — the host calling in

All five come from the module named `env`. A module imports only the ones it
uses.

| name                 | signature                                                      |                                                                            |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `napp_canvas_width`  | `() -> i32`                                                    | canvas width, in device pixels                                             |
| `napp_canvas_height` | `() -> i32`                                                    | canvas height, in device pixels                                            |
| `napp_now_ms`        | `() -> f64`                                                    | milliseconds since the window opened                                       |
| `napp_log`           | `(offset: i32, length: i32) -> ()`                             | write one line to the launcher's log                                       |
| `napp_call`          | `(method_ptr, method_len, params_ptr, params_len: i32) -> i32` | call the launcher; see [Talking to the launcher](#talking-to-the-launcher) |

A napp asks for the size every frame rather than caching it, which is how a
window resize is something it notices on its own.

### Exports — the napp calling out

| name              | signature                           |                                                                              |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `napp_frame`      | `(dt_ms: f64) -> i32`               | paint one frame; non-zero means "call me again without being told to"        |
| `napp_canvas_ptr` | `() -> i32`                         | byte offset of the canvas in the module's own memory                         |
| `napp_event`      | `(kind, x, y, buttons, a, b) -> ()` | optional: one input event                                                    |
| `napp_alloc`      | `(len: i32) -> i32`                 | room for a message the host is about to hand over; required with `napp_call` |
| `napp_receive`    | `(kind, id, ptr, len: i32) -> ()`   | one message from the host; required with `napp_call`                         |

`napp_frame` returning non-zero is how an animation keeps running and how a
click gets drawn on the frame after it. Returning zero parks the window until
something happens, so an idle window costs nothing.

`napp_event` kinds, with `x` and `y` in canvas pixels and `buttons` a mask of
`1` primary, `2` secondary, `4` middle:

| kind |                        |
| ---- | ---------------------- |
| 0    | pointer moved          |
| 1    | pointer pressed        |
| 2    | pointer released       |
| 3    | scroll, in `a` and `b` |

A module may leave `napp_event` out entirely if it only draws.

## The canvas

`napp_canvas_ptr()` is a byte offset into the module's own linear memory.
`width * height * 4` bytes live there:

- **RGBA8888**, four bytes per pixel: R, G, B, A.
- **Alpha premultiplied.** R, G and B are already multiplied by A.
- Rows **top-down**, and the stride is exactly `width * 4`: no padding.

That is egui's `Color32` byte for byte, which is where most napp toolkits
most napp toolkits already live, and it is what a GPU wants to be handed.

The napp owns the pixels and the launcher reads them. That direction is not a
choice: a launcher cannot hand a wasm module a pointer to memory the module
cannot address, so "give the napp a canvas" is in practice "the napp keeps a
canvas and the launcher reads it".

## Talking to the launcher

Everything a web napp gets from `window.nostr`, `window.nostrdb` and
`window.napp` a wasm napp gets through one import:

```
id = napp_call(method_ptr, method_len, params_ptr, params_len)
```

`method` is a name from the table below and `params` its JSON, both utf-8 in
the module's own memory (empty params read as `null`). The launcher copies
them before returning, so the buffers are free again at once. It never
blocks: it returns a call id (always above zero; `0` means there was no host
to call) and the answer comes later, through `napp_receive`, under that id.

### Messages — `napp_receive(kind, id, ptr, len)`

The launcher asks `napp_alloc(len)` for room, writes the message there, and
hands it over; from then on the bytes are the napp's to free. An empty
message comes with `ptr` and `len` both `0` and no allocation. Messages are
only ever delivered between frames — never from inside `napp_call` or
`napp_frame` — and the frame after one always runs, so a napp parked on an
idle canvas still sees its answer at once.

| kind | `id`                 | bytes                               |                                                   |
| ---- | -------------------- | ----------------------------------- | ------------------------------------------------- |
| 0    | the call's           | JSON                                | result: what the call returned                    |
| 1    | the call's           | text                                | error: why the call failed (including a denial)   |
| 2    | the feed call's      | `{"events": [...], "synced": bool}` | feed: one batch from a feed                       |
| 3    | the dispatch's       | `{"name", "payload", "idx"}`        | action: dispatched to this window                 |
| 4    | 0                    | `{"op", "key", "value"}`            | storage: another window of this napp changed it   |
| 5    | 0                    | `{"name", "vars"}`                  | theme: the user switched the launcher's theme     |
| 6    | the subscribe call's | `{"type", ...}`                     | subscription: see [Subscriptions](#subscriptions) |

### Methods

These are bridge.js's own rpc names, with the params bridge.js sends for each
function, behind the same grants and the same prompts: a call that would
prompt a web napp (signing, encrypting, publishing, links, files, clipboard)
prompts a wasm napp too.

| method                                     | params                                      | answers                              | bridge.js                              |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------ | -------------------------------------- |
| `getPublicKey`                             | —                                           | hex pubkey                           | `nostr.getPublicKey()`                 |
| `signEvent`                                | event template                              | signed event                         | `nostr.signEvent(evt)`                 |
| `nip04.encrypt` / `nip44.encrypt`          | `{pubkey, plaintext}`                       | ciphertext                           | `nostr.nip04/nip44.encrypt`            |
| `nip04.decrypt` / `nip44.decrypt`          | `{pubkey, ciphertext}`                      | plaintext                            | `nostr.nip04/nip44.decrypt`            |
| `nostrdb.add`                              | `{event}`                                   | bool                                 | `nostrdb.add`                          |
| `nostrdb.query`                            | `{filters}` (one or an array)               | events                               | `nostrdb.query`                        |
| `nostrdb.count`                            | `{filters}`                                 | number                               | `nostrdb.count`                        |
| `nostrdb.event`                            | `{id}`                                      | event or null                        | `nostrdb.event`                        |
| `nostrdb.remove`                           | `{ids}`                                     | removed ids                          | `nostrdb.remove`                       |
| `nostrdb.replaceable`                      | `{kind, author, identifier?}`               | event or null                        | `nostrdb.replaceable`                  |
| `nostrdb.supports`                         | —                                           | `[]`                                 | `nostrdb.supports`                     |
| `napp.instance`                            | —                                           | instance id                          | `napp.instance`                        |
| `napp.theme`                               | —                                           | `{name, vars}`                       | the theme message bridge.js applies    |
| `napp.action`                              | `{name, payload, options?}`                 | the handler's result                 | `napp.action`                          |
| `napp.registerAction`                      | `{pattern, idx?}`                           | null                                 | `napp.registerAction`                  |
| `napp.dispatchResult`                      | `{id, result}` or `{id, error}`             | null                                 | (answering an action)                  |
| `napp.close`                               | —                                           | null                                 | `napp.close`                           |
| `napp.link`                                | url string                                  | null                                 | `napp.link`                            |
| `napp.log`                                 | `{message}`                                 | bool                                 | `napp.log`                             |
| `napp.relays.health`                       | `{urls}`                                    | health, with rank                    | `napp.relays.health`                   |
| `napp.feeds.profile`                       | `{pubkey, kinds, ...opts}`                  | null, then feed messages             | `napp.feeds.profile`                   |
| `napp.feeds.following`                     | `{source, kinds, ...opts}`                  | 〃                                   | `napp.feeds.following`                 |
| `napp.feeds.inbox`                         | `{pubkey, kinds, ...opts}`                  | 〃                                   | `napp.feeds.inbox`                     |
| `napp.feeds.outbox`                        | `{pubkeys, kinds, ...opts}`                 | 〃                                   | `napp.feeds.outbox`                    |
| `napp.feeds.relay`                         | `{relays, kinds, ...opts}`                  | 〃                                   | `napp.feeds.relay`                     |
| `napp.feeds.cancel`                        | `{callbackId}`                              | bool                                 | `feed.close()`                         |
| `napp.load*`, `napp.fetch*WithSets`        | user (hex, npub, nprofile, nip05)           | the list                             | `napp.utils.load*` / `fetch*`          |
| `napp.loadRelayInfo`                       | url string                                  | NIP-11 info                          | `napp.utils.loadRelayInfo`             |
| `napp.loadNostrUser`                       | user, or `{pubkey, relays}`                 | profile                              | `napp.utils.loadNostrUser`             |
| `napp.searchUser` / `napp.searchUserLocal` | term string                                 | profiles                             | `napp.utils.searchUser*`               |
| `napp.loadEvent`                           | `{code, relays?, author?}`                  | event or null                        | `napp.utils.loadEvent`                 |
| `napp.loadEvents`                          | ids                                         | events                               | `napp.utils.loadEvents`                |
| `napp.verifyEvent`                         | event                                       | bool                                 | `napp.utils.verifyEvent`               |
| `napp.generateKey`                         | —                                           | `{sk, pk}`                           | `napp.utils.generateKey`               |
| `napp.signWithKey`                         | `{event, sk}`                               | signed event                         | `napp.utils.signWithKey`               |
| `napp.saveFile`                            | `{name, data, type}`, data **base64**       | `{name, size}`                       | `napp.utils.saveFile`                  |
| `napp.copyText`                            | `{text}`                                    | `{length}`                           | `napp.utils.copyText`                  |
| `napp.publish`                             | `{event, relays?}`                          | `{relays, published, failed}`        | `napp.utils.publish`                   |
| `napp.subscribe`                           | `{relays, filter, label?, maxEoseTimeout?}` | null, then subscription messages     | `napp.utils.subscribe`                 |
| `napp.unsubscribe`                         | `{callbackId}`                              | null                                 | the closer `subscribe` returns         |
| `napp.storageGet`                          | key string                                  | value or null                        | `localStorage.getItem`                 |
| `napp.storageKeys`                         | —                                           | keys, sorted                         | `localStorage.key` / `length`          |
| `napp.storageSet`                          | `{key, value}`                              | null                                 | `localStorage.setItem`                 |
| `napp.storageRemove`                       | `{key}`                                     | null                                 | `localStorage.removeItem`              |
| `napp.storageClear`                        | —                                           | null                                 | `localStorage.clear`                   |
| `nip19.decode`                             | code string                                 | `{type, data}`                       | `napp.nip19.decode`                    |
| `nip19.npubEncode` / `nip19.noteEncode`    | hex string                                  | bech32                               | `napp.nip19.npubEncode` / `noteEncode` |
| `nip19.neventEncode`                       | `{id, relays?, author?, kind?}`             | bech32                               | `napp.nip19.neventEncode`              |
| `nip19.naddrEncode`                        | `{identifier, pubkey, kind, relays?}`       | bech32                               | `napp.nip19.naddrEncode`               |
| `fx.isHex64`                               | string                                      | bool                                 | `napp.fx.isHex64`                      |
| `fx.parseCoordinate`                       | string                                      | `{kind, pubkey, identifier}` or null | `napp.fx.parseCoordinate`              |
| `fx.formatCoordinate`                      | `{kind, pubkey, identifier}`                | string                               | `napp.fx.formatCoordinate`             |
| `fx.satsFromBolt11`                        | invoice string                              | sats or null                         | `napp.fx.satsFromBolt11`               |

The `napp.storage*`, `nip19.*`, `fx.*`, `napp.generateKey`,
`napp.signWithKey`, `napp.instance`, `napp.theme` and `nostrdb.supports`
calls are answered by the launcher on the spot, the way bridge.js answers
them inside the page, but they still answer through `napp_receive` like
everything else.

A wasm napp has no origin of its own, so its storage lives in the launcher's
storage, shared by all the napp's windows and erased with it on uninstall.
Here that is 1MB per napp, because it shares the launcher's own quota; a
write over it fails with an error message.

### Feeds

A feed call's own id is its `callbackId`. The call answers `null` once the
feed is up; the events then keep arriving as feed messages under that same
id, `synced` turning true once the relays have sent what they had stored.
`napp.feeds.cancel` with `{"callbackId": id}` ends it, and nothing more is
delivered for it after that.

### Actions

A wasm napp handles actions the way a web napp's `registerAction` handler
does:

1. `napp.registerAction` with `{"pattern": "view:1"}` once it is ready, for
   each pattern it declares in its manifest. `idx` is any number the napp
   wants handed back with the action (to tell its handlers apart), `0` if
   left out; `-1` says it wants to hear about the action but will not answer.
2. When another napp, the launcher or a shortcut dispatches the action, it
   arrives as an action message: `id` is the dispatch, and the bytes carry
   the action's `name`, its `payload` and that `idx`.
3. The napp answers with `napp.dispatchResult`, `{"id": <the dispatch id>,
"result": ...}` or `{"id", "error": "..."}`, and whoever dispatched it gets
   the result. An id of `-1` means nobody is waiting, so there is nothing to
   answer.

Calling out is `napp.action`, the same as a web napp: its answer is the
handler's result. A reload starts the module from scratch and replays the
window's actions into it, the way a web napp's reload does.

### Subscriptions

`napp.subscribe` is a plain REQ with `filter` to exactly `relays`. Like a
feed, the call's own id is its `callbackId`: it answers `null` once the
subscription is up, then subscription messages arrive under that id:

1. `{"type": "eose", "events": [...]}` once, with every event that came before
   all the relays sent EOSE — or before `maxEoseTimeout` milliseconds (20000
   if left out), whichever is first.
2. `{"type": "event", "event": {...}}` for each new event after that, one by
   one.
3. `{"type": "closed", "reasons": {"<relay>": "<reason>"}}` if every relay
   ends it on its own (a CLOSED, or no connection to begin with). Nothing
   comes after this.

`label` is what the relays see the subscription id prefixed with,
`<author prefix>-<d tag>` by default. `napp.unsubscribe` with
`{"callbackId": id}` ends it, and nothing more is delivered for it after
that.

## What a wasm napp does not have

**No WASI.** There is no `wasi_snapshot_preview1` module, no filesystem, no
socket, no clock of its own. A module that imports anything beyond the five
above is refused, with what it asked for in the message — a launcher cannot
half-support a napp, because the parts it does support are the parts nobody
had to think about. Whatever a napp needs from the outside comes through
`napp_call`, which is where permissions live.

No history: a web napp's actions also become history entries it can go back
and forward through; a canvas has no history, so an action is only ever the
message.

## Building one

**Rust**, no GPU, anywhere:

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
egui = { version = "0.32", default-features = false, features = ["default_fonts"] }
```

```
cargo build --release --target wasm32-unknown-unknown
```

egui writes itself for a GPU, so its output is textured triangles plus a font
atlas. A canvas napp has to produce bytes, so the triangles get rasterised:
`../napps/wasm-egui/src/raster.rs` is about 200 lines and is worth reading
once.

## Trying one without installing it

`harness/wasm.html` is the window half of a wasm napp with no launcher around
it: the canvas, the runtime, and a sweep that clicks things until one of them
counts. Drop a built module next to it as `app.wasm`, run `npm run dev`, and
open `/harness/wasm.html`.

## Where the names live

`src/sandbox/wasm-abi.ts`. It is the single place both this launcher and
verdana's take the names from, so the two cannot drift.
