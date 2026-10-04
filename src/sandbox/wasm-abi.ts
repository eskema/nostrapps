// The contract between a wasm napp and whatever is hosting it.
//
// A napp declared with the "wasm" mode ships one WebAssembly module instead of
// a page, and is handed a window with a canvas buffer to paint into. There is
// no DOM, no iframe and no JavaScript in the picture.
//
// The contract is deliberately tiny, because two launchers implement it: this
// one, against the browser's WebAssembly, and verdana's against wazero in a
// window of its own. A module that runs in one runs in the other. WASM.md
// documents it for napp authors; this file is the single place the names come
// from, so the two cannot drift.

/** The import module the launcher provides. */
export const NAPP_IMPORT_MODULE = "env"

/** Imports: the host calling into the napp. */
export const NAPP_IMPORTS = {
  /** How wide the canvas is, in device pixels. */
  canvasWidth: "napp_canvas_width",
  /** How tall the canvas is, in device pixels. */
  canvasHeight: "napp_canvas_height",
  /** Milliseconds since the window opened. */
  nowMs: "napp_now_ms",
  /** Write one line to the launcher's log: `length` bytes at `offset`. */
  log: "napp_log"
} as const

/** Exports: the napp calling out to the host. */
export const NAPP_EXPORTS = {
  /** Paint a frame; non-zero means "call me again without being told to". */
  frame: "napp_frame",
  /** Where the canvas is, as a byte offset into the module's own memory. */
  canvasPtr: "napp_canvas_ptr",
  /** Optional: hand the napp one input event. */
  event: "napp_event"
} as const

/** The input events a launcher reports. Pointer coordinates are canvas pixels. */
export const NAPP_EVENT = {
  pointerMove: 0,
  pointerDown: 1,
  pointerUp: 2,
  scroll: 3
} as const

/** Pointer buttons, as the bit mask sent alongside a position. */
export const NAPP_BUTTON = {
  primary: 1,
  secondary: 2,
  middle: 4
} as const

/**
 * The module a wasm napp gets when its manifest does not name one: /app.wasm.
 * Otherwise the napp's only .wasm file is used.
 */
export const WASM_DEFAULT_ENTRY = "app.wasm"

/**
 * Bytes per canvas pixel: RGBA8888, alpha premultiplied, rows top-down, no
 * padding — so the stride is exactly width*4. That is egui's Color32 byte
 * for byte, which is where most napp toolkits already live, and it is what
 * a GPU wants to be handed.
 */
export const WASM_BYTES_PER_PIXEL = 4

/** The window a wasm napp opens at when its metadata says nothing. */
export const WASM_DEFAULT_WIDTH = 640
export const WASM_DEFAULT_HEIGHT = 480
