// A wasm napp's window content.
//
// A web napp is a page in a sandboxed iframe: the launcher hands it a URL and
// bridge.js gives it window.napp. A wasm napp has no page. The launcher hands
// it a canvas and runs its module, and this is the other half of that — the
// module's imports, the frame loop, and the pixels going onto the canvas.
//
// It is the same contract the desktop launcher implements against wazero, so
// a module that runs in one runs in the other. See WASM.md.
//
// The napp owns its pixels: it allocates a canvas buffer in its own memory
// and publishes where it is. That direction is not a choice — a launcher
// cannot hand a wasm module a pointer to memory the module cannot address,
// so "give the napp a canvas" is in practice "the napp keeps a canvas and the
// launcher reads it".

import {
  NAPP_IMPORT_MODULE,
  NAPP_BUTTON,
  NAPP_EVENT,
  NAPP_EXPORTS,
  NAPP_IMPORTS,
  NAPP_KEY,
  NAPP_MOD,
  NAPP_MSG,
  WASM_BYTES_PER_PIXEL
} from "./wasm-abi.js"

/** One running wasm napp: its instance, its module, its canvas. */
export type WasmNapp = {
  /** Stop the frame loop and release the module. */
  stop(): void
  /** Paint another frame right now, rather than waiting for the next rAF. */
  frame(): boolean
  /**
   * Hand the napp one message through napp_receive. It is queued and
   * delivered before the next frame, never from inside a call into the module.
   * A string is sent as its utf-8, null as an empty message.
   */
  deliver(kind: number, id: number, data: string | Uint8Array | null): void
}

/** One napp_call: what the napp asked for, already copied out of its memory. */
export type WasmCall = {
  id: number
  method: string
  /** The parsed JSON params; null when the napp sent none. */
  params: unknown
}

export type WasmNappOptions = {
  /** The module's bytes. */
  module: ArrayBuffer
  /** The canvas to paint on; sized by this class. */
  canvas: HTMLCanvasElement
  /** Where the napp said it was, for the launcher's log. */
  onLog?: (line: string) => void
  /**
   * What napp_call reaches. The answer goes back through napp.deliver, under
   * call.id; without this every napp_call returns 0.
   */
  onCall?: (call: WasmCall, napp: WasmNapp) => void
}

// What a napp may hand napp_call in one go, a saveFile payload being the
// practical limit.
const MAX_CALL_METHOD = 256
const MAX_CALL_PARAMS = 64 << 20

export async function startWasmNapp({
  module,
  canvas,
  onLog,
  onCall
}: WasmNappOptions): Promise<WasmNapp> {
  const ctx = canvas.getContext("2d", { alpha: true })
  if (!ctx) throw new Error("this browser will not give a napp a 2d canvas")

  // A canvas the size the launcher wants, and the running size it has: a
  // window that is not showing (another space) has no layout at all, so the
  // first size is whatever it has and later ones follow the element.
  let width = 1
  let height = 1
  let instance: WebAssembly.Instance
  let exports: WebAssembly.Exports
  let stopped = false
  const started = performance.now()

  // Messages for the module, delivered between frames. napp_call never
  // answers from inside itself, which is what lets a napp call from anywhere
  // — inside a frame, an event, or another message.
  let inbox: Array<{ kind: number; id: number; data: Uint8Array | null }> = []
  let callSerial = 0
  // The handle onCall gets, filled in once the module is up.
  let self: WasmNapp | undefined

  // The host's side of the ABI. Every function here is something a wasm napp
  // can import; there is nothing else, and that is deliberate: a napp that
  // asks for anything more has to ask the launcher, which is where permissions
  // live.
  const env: WebAssembly.ModuleImports = {
    // How big the canvas is. A napp asks every frame rather than caching, so
    // a window resize is something it notices on its own.
    [NAPP_IMPORTS.canvasWidth]: () => width,
    [NAPP_IMPORTS.canvasHeight]: () => height,
    [NAPP_IMPORTS.nowMs]: () => performance.now() - started,
    [NAPP_IMPORTS.log]: (offset: number, length: number) => {
      const line = readString(instance.exports, offset, length)
      if (line) onLog?.(line)
    },
    // Copy both strings out before returning, so the napp can reuse its
    // buffers at once, and answer later through napp_receive.
    [NAPP_IMPORTS.call]: (mPtr: number, mLen: number, pPtr: number, pLen: number) => {
      // Not from a start function, either: there is nowhere for the answer
      // to go until the module is up.
      if (!onCall || stopped || !self) return 0
      if (mLen <= 0 || mLen > MAX_CALL_METHOD || pLen < 0 || pLen > MAX_CALL_PARAMS) return 0
      const method = readBytes(instance.exports, mPtr >>> 0, mLen)
      const raw = pLen > 0 ? readBytes(instance.exports, pPtr >>> 0, pLen) : new Uint8Array()
      if (!method || !raw) return 0

      const id = ++callSerial
      const name = new TextDecoder().decode(method)
      let params: unknown = null
      const text = new TextDecoder().decode(raw).trim()
      if (text) {
        try {
          params = JSON.parse(text)
        } catch {
          self.deliver(NAPP_MSG.error, id, `${name}: params are not valid JSON`)
          return id
        }
      }
      onCall({ id, method: name, params }, self)
      return id
    }
  }

  const compiled = await WebAssembly.compile(module)
  const imports = { env } as unknown as WebAssembly.Imports
  try {
    instance = await WebAssembly.instantiate(compiled, imports)
  } catch (err) {
    throw new Error(missingImports(compiled, imports) || String(err))
  }
  exports = instance.exports

  const frameFn = exports[NAPP_EXPORTS.frame] as CallableFunction | undefined
  const ptrFn = exports[NAPP_EXPORTS.canvasPtr] as CallableFunction | undefined
  const eventFn = exports[NAPP_EXPORTS.event] as CallableFunction | undefined
  const allocFn = exports[NAPP_EXPORTS.alloc] as CallableFunction | undefined
  const receiveFn = exports[NAPP_EXPORTS.receive] as CallableFunction | undefined

  if (typeof frameFn !== "function" || typeof ptrFn !== "function") {
    throw new Error(
      `this module is not a napp: it must export ${NAPP_EXPORTS.frame} and ${NAPP_EXPORTS.canvasPtr}`
    )
  }

  // memory is the module's own linear memory, exported as "memory".
  const memory = exports.memory as WebAssembly.Memory | undefined
  if (!memory) throw new Error("this module has no memory for the launcher to read")

  // A napp that calls out must have somewhere for the answers to land. One
  // that does not call is spared the two exports.
  const callsOut = WebAssembly.Module.imports(compiled).some(
    imp => imp.module === NAPP_IMPORT_MODULE && imp.name === NAPP_IMPORTS.call
  )
  if (callsOut && (typeof allocFn !== "function" || typeof receiveFn !== "function")) {
    throw new Error(
      `this module imports ${NAPP_IMPORTS.call} but does not export both ` +
        `${NAPP_EXPORTS.alloc} and ${NAPP_EXPORTS.receive}, so there is no way to hand it the answers`
    )
  }

  // Pointer input goes in as canvas events: the napp decides what they
  // mean. The module can leave napp_event out entirely if it only draws.
  let pending: Array<[number, number, number, number, number, number]> = []
  if (typeof eventFn === "function") {
    const post = (kind: number, x: number, y: number, buttons: number, a: number, b: number) => {
      pending.push([kind, x, y, buttons, a, b])
      request()
    }
    const rect = () => canvas.getBoundingClientRect()
    canvas.addEventListener("pointermove", e => {
      const r = rect()
      post(NAPP_EVENT.pointerMove, e.clientX - r.left, e.clientY - r.top, buttonsOf(e), 0, 0)
    })
    canvas.addEventListener("pointerdown", e => {
      const r = rect()
      // Queued before the capture: setPointerCapture throws for a pointer the
      // browser is not tracking, and losing the press to that would lose the
      // click with it.
      post(NAPP_EVENT.pointerDown, e.clientX - r.left, e.clientY - r.top, buttonsOf(e), 0, 0)
      // Capture keeps a drag that leaves the canvas coming back to it, which
      // is what a window does with a drag that leaves its frame.
      try {
        canvas.setPointerCapture?.(e.pointerId)
      } catch {}
    })
    const up = (e: PointerEvent) => {
      const r = rect()
      post(NAPP_EVENT.pointerUp, e.clientX - r.left, e.clientY - r.top, buttonsOf(e), 0, 0)
    }
    canvas.addEventListener("pointerup", up)
    canvas.addEventListener("pointercancel", up)
    canvas.addEventListener(
      "wheel",
      e => {
        e.preventDefault()
        const r = rect()
        post(NAPP_EVENT.scroll, e.clientX - r.left, e.clientY - r.top, 0, -e.deltaX, -e.deltaY)
      },
      { passive: false }
    )
    // A napp that never gets to know the pointer left stops reporting a hover,
    // and one that waits for the cursor to come back would never idle.
    canvas.addEventListener("pointerleave", () => post(NAPP_EVENT.pointerMove, -1, -1, 0, 0, 0))

    // Keys go to the canvas once it has been clicked, like to any focused
    // element: a key down and up for every key the ABI can name, and a text
    // event for each character typed, which is what a text field wants.
    canvas.addEventListener("pointerdown", () => canvas.focus({ preventScroll: true }))
    canvas.addEventListener("keydown", e => {
      const key = keyOf(e)
      if (key === null) return
      const mods = modsOf(e)
      post(NAPP_EVENT.keyDown, key, 0, mods, e.repeat ? 1 : 0, 0)
      // A shortcut (ctrl+c, ctrl+v, ctrl+k) stays the browser's and the
      // launcher's too: its default is what makes a paste event at all.
      // AltGr arrives as ctrl+alt on some systems and still types.
      const shortcut = (e.ctrlKey || e.metaKey) && !e.getModifierState("AltGraph")
      if (!shortcut) {
        e.preventDefault()
        if ([...e.key].length === 1) post(NAPP_EVENT.text, e.key.codePointAt(0)!, 0, mods, 0, 0)
      }
    })
    canvas.addEventListener("keyup", e => {
      const key = keyOf(e)
      if (key !== null) post(NAPP_EVENT.keyUp, key, 0, modsOf(e), 0, 0)
    })
    // A paste is text arriving all at once: the same events typing it would
    // have sent.
    canvas.addEventListener("paste", e => {
      const text = e.clipboardData?.getData("text/plain")
      if (!text) return
      e.preventDefault()
      for (const ch of text) post(NAPP_EVENT.text, ch.codePointAt(0)!, 0, 0, 0, 0)
    })
  }

  let queued = false
  function request() {
    if (stopped || queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      paint()
    })
  }

  function paint() {
    if (stopped) return

    // The element's size is the truth, and it is not the canvas's: a window
    // that is not on screen has no layout, so the last size stands.
    const box = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(box.width * dpr()))
    const h = Math.max(1, Math.round(box.height * dpr()))
    if (w !== width || h !== height) {
      width = w
      height = h
      canvas.width = w
      canvas.height = h
    }

    let more = 0
    try {
      // Messages first, so a click that lands with its answer sees it.
      const messages = inbox
      inbox = []
      for (const m of messages) receive(m.kind, m.id, m.data)

      const events = pending
      pending = []
      for (const [kind, x, y, buttons, a, b] of events) {
        if (typeof eventFn === "function") eventFn(kind, x, y, buttons, a, b)
      }

      more = Number(frameFn?.(16.7) ?? 0)
    } catch (err) {
      // A trap is the napp's own crash. Take the window down rather than sit
      // on a half-drawn canvas.
      stopped = true
      onLog?.(`wasm napp trapped: ${err}`)
      throw err
    }

    const ptr = Number(ptrFn?.() ?? 0)
    if (ptr && memory) blit(ctx as CanvasRenderingContext2D, memory, ptr, width, height)

    // A napp that says it wants more frames is animating; anything else waits
    // for an event, which is a lot cheaper than redrawing an unchanged canvas
    // at 60fps for ever.
    if (more) request()
    return more
  }

  /** receive hands one message to the module, in room it allocates. */
  function receive(kind: number, id: number, data: Uint8Array | null) {
    if (typeof receiveFn !== "function") return
    let ptr = 0
    const len = data?.length ?? 0
    if (data && len > 0) {
      ptr = Number(allocFn!(len)) >>> 0
      // napp_alloc may have grown the memory, so the buffer is looked up only
      // now.
      if (!ptr || ptr + len > memory!.buffer.byteLength) {
        throw new Error(`${NAPP_EXPORTS.alloc} gave ${ptr}, which does not fit ${len} bytes`)
      }
      new Uint8Array(memory!.buffer, ptr, len).set(data)
    }
    receiveFn(kind, id, ptr, len)
  }

  const observer = new ResizeObserver(() => request())
  observer.observe(canvas)

  const napp: WasmNapp = {
    stop() {
      stopped = true
      inbox = []
      observer.disconnect()
    },
    frame() {
      paint()
      return true
    },
    deliver(kind, id, data) {
      // A module that never imported napp_call has nothing coming.
      if (stopped || typeof receiveFn !== "function") return
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
      inbox.push({ kind, id, data: bytes && bytes.length ? bytes : null })
      // The frame after a message always runs, so a napp parked on an idle
      // canvas still sees its answer at once.
      request()
    }
  }

  self = napp
  request()

  return napp
}

/**
 * missingImports explains an instantiation failure, because the browser's own
 * message ("module is not an object or function") says nothing about what a
 * napp author has to change. The mistake is nearly always a build that expects
 * WASI: a wasm napp gets a canvas and napp_call, and there is no WASI here.
 */
function missingImports(module: WebAssembly.Module, provided: WebAssembly.Imports): string {
  const absent = new Set<string>()
  for (const imp of WebAssembly.Module.imports(module)) {
    const namespace = provided[imp.module] as WebAssembly.ModuleImports | undefined
    if (imp.kind === "function" && !(namespace && imp.name in namespace)) {
      absent.add(`${imp.module}.${imp.name}`)
    }
  }
  if (absent.size === 0) return ""
  return (
    `this module imports ${[...absent].join(", ")}, which a napp does not get. ` +
    `A wasm napp is handed a canvas and napp_call, and nothing else: no WASI, no filesystem, ` +
    `no network, no clock of its own.`
  )
}

/** blit puts the napp's canvas onto the visible one. */
function blit(
  ctx: CanvasRenderingContext2D,
  memory: WebAssembly.Memory,
  ptr: number,
  width: number,
  height: number
) {
  const need = width * height * WASM_BYTES_PER_PIXEL
  // memory.buffer detaches whenever the module grows, so the view is built
  // fresh every frame rather than kept.
  if (ptr < 0 || ptr + need > memory.buffer.byteLength) return
  const pixels = new Uint8ClampedArray(memory.buffer, ptr, need)
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0)
}

/** buttonsOf is the launcher's button mask, which is three bits. */
function buttonsOf(e: PointerEvent): number {
  let mask = 0
  if (e.buttons & 1) mask |= NAPP_BUTTON.primary
  if (e.buttons & 2) mask |= NAPP_BUTTON.secondary
  if (e.buttons & 4) mask |= NAPP_BUTTON.middle
  return mask
}

/**
 * keyOf is the ABI's number for a key: a named one from NAPP_KEY, or the
 * character it types, lowercased. Null for keys the ABI has no name for
 * (modifiers on their own, function keys), which are not reported.
 */
function keyOf(e: KeyboardEvent): number | null {
  if (Object.hasOwn(NAPP_KEY, e.key)) return NAPP_KEY[e.key as keyof typeof NAPP_KEY]
  const chars = [...e.key]
  if (chars.length !== 1) return null
  return chars[0].toLowerCase().codePointAt(0)!
}

/** modsOf is the launcher's modifier mask, which is four bits. */
function modsOf(e: KeyboardEvent): number {
  let mask = 0
  if (e.shiftKey) mask |= NAPP_MOD.shift
  if (e.ctrlKey) mask |= NAPP_MOD.ctrl
  if (e.altKey) mask |= NAPP_MOD.alt
  if (e.metaKey) mask |= NAPP_MOD.meta
  return mask
}

/** dpr is how many device pixels a CSS pixel is, which the canvas counts in. */
function dpr(): number {
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)))
}

/** readBytes copies n bytes out of the module's memory, or null if they are not there. */
function readBytes(
  exports: WebAssembly.Exports,
  offset: number,
  length: number
): Uint8Array | null {
  const memory = exports.memory as WebAssembly.Memory | undefined
  if (!memory) return null
  if (offset < 0 || offset + length > memory.buffer.byteLength) return null
  return new Uint8Array(memory.buffer, offset, length).slice()
}

/** readString reads n bytes of UTF-8 out of the module's memory. */
function readString(exports: WebAssembly.Exports, offset: number, length: number): string {
  const memory = exports.memory as WebAssembly.Memory | undefined
  if (!memory || length <= 0 || length > 64 << 10) return ""
  if (offset < 0 || offset + length > memory.buffer.byteLength) return ""
  return new TextDecoder().decode(new Uint8Array(memory.buffer, offset, length))
}
