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

All four come from the module named `env`.

| name                 | signature                          |                                      |
| -------------------- | ---------------------------------- | ------------------------------------ |
| `napp_canvas_width`  | `() -> i32`                        | canvas width, in device pixels       |
| `napp_canvas_height` | `() -> i32`                        | canvas height, in device pixels      |
| `napp_now_ms`        | `() -> f64`                        | milliseconds since the window opened |
| `napp_log`           | `(offset: i32, length: i32) -> ()` | write one line to the launcher's log |

A napp asks for the size every frame rather than caching it, which is how a
window resize is something it notices on its own.

### Exports — the napp calling out

| name              | signature                           |                                                                       |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `napp_frame`      | `(dt_ms: f64) -> i32`               | paint one frame; non-zero means "call me again without being told to" |
| `napp_canvas_ptr` | `() -> i32`                         | byte offset of the canvas in the module's own memory                  |
| `napp_event`      | `(kind, x, y, buttons, a, b) -> ()` | optional: one input event                                             |

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

## What a wasm napp does not have

**No WASI.** There is no `wasi_snapshot_preview1` module, no filesystem, no
socket, no clock of its own. A module that imports anything beyond the four
above is refused, with what it asked for in the message — a launcher cannot
half-support a napp, because the parts it does support are the parts nobody
had to think about.

Also not there yet: `window.nostr`, `window.nostrdb`, `window.napp`, actions,
permissions and local storage. **The canvas is the whole surface for now.**
Those all belong to a web napp's bridge, and a bridge needs a page.

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
