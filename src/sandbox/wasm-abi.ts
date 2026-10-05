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
  log: "napp_log",
  /**
   * napp_call(method_ptr, method_len, params_ptr, params_len) -> id: the wasm
   * side of everything bridge.js gives a web napp (window.nostr,
   * window.nostrdb, window.napp). method is one of the bridge's rpc names and
   * params its JSON, both utf-8 in the napp's own memory. It never blocks: it
   * returns a call id at once (always above zero, 0 meaning there is no host
   * to call) and the answer comes later through napp_receive under that id.
   */
  call: "napp_call"
} as const

/** Exports: the napp calling out to the host. */
export const NAPP_EXPORTS = {
  /** Paint a frame; non-zero means "call me again without being told to". */
  frame: "napp_frame",
  /** Where the canvas is, as a byte offset into the module's own memory. */
  canvasPtr: "napp_canvas_ptr",
  /** Optional: hand the napp one input event. */
  event: "napp_event",
  /**
   * napp_alloc(len) -> ptr: room for a message the host is about to hand
   * over. Ownership passes to the napp with the message. Required with
   * napp_call.
   */
  alloc: "napp_alloc",
  /**
   * napp_receive(kind, id, ptr, len): one message from the host, len bytes at
   * ptr (0 and 0 for an empty one). Only ever called between two frames, and
   * the frame after it always runs. Required with napp_call.
   */
  receive: "napp_receive"
} as const

/** The messages a host hands over through napp_receive. */
export const NAPP_MSG = {
  /** The napp_call with this id answered: its JSON result. */
  result: 0,
  /** The napp_call with this id failed: the reason, as plain text. */
  error: 1,
  /** One batch from the feed this call id started: {"events", "synced"}. */
  feed: 2,
  /** An action dispatched to this window: {"name", "payload", "idx"}. */
  action: 3,
  /** Another window of this napp changed its storage: {"op", "key", "value"}. */
  storage: 4,
  /** The user switched the launcher's theme: {"name", "vars"}. */
  theme: 5,
  /** News from the napp.subscribe call with this id: {"type", ...}. */
  subscription: 6
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
