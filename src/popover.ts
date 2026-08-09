// Reusable floating card anchored at a point (e.g. the cursor) — a non-modal,
// light-dismissing popover for context-menu-style UI. Built on the Popover API
// (top layer + Esc / click-outside dismiss). Parallels openDialog() (modal) in
// dialog.ts — pick whichever fits the interaction.

// A click inside a napp can't light-dismiss these. A napp iframe is cross-origin
// but same-SITE — nappOriginFor puts every napp on `<slug>.<launcher host>` — so
// it shares the launcher's renderer process and its pointerdown is dispatched
// only in the napp's own document — the launcher never sees it and the Popover API's
// light-dismiss never runs, leaving the popover stuck until Esc. (Cross-site
// iframes get their own process and do dismiss the parent, which is a misleading
// thing to test with — napps are not that.) A maximized napp makes it
// unavoidable: its iframe is everything but the window toolbar.
//
// So while any popover is open, take napp iframes out of the hit-test path (the
// same trick window dragging uses). The click then lands on the launcher and
// dismisses normally — and stops there rather than also reaching the napp, which
// could dispatch a fresh action and open a replacement popover in the same spot,
// looking like one that never closed. Context-menu semantics.
//
// Read off the live DOM rather than tracked in a Set: a popover removed while
// open never reports `closed` to a document listener (`toggle` is async, and by
// the time it fires the element is detached and has no path down to us), and a
// missed close would strand the class on — freezing every napp iframe until a
// full page reload. Stateless can't drift.
function syncPopoverState() {
  let anyOpen = false
  try {
    anyOpen = !!document.querySelector(":popover-open")
  } catch {} // engine without the selector: leave iframes alone
  document.body.classList.toggle("popover-open", anyOpen)
}

// `toggle` doesn't bubble, but capture still sees it on the way down, so this
// covers declaratively-triggered popovers (popovertarget, e.g. the apps card
// menu) as well as openPopover()'s. openPopover() calls syncPopoverState()
// itself after removing, for the detached case above. `toggle` is async, so the
// class lands a task after showPopover() — far ahead of any real click.
document.addEventListener(
  "toggle",
  e => {
    if ((e.target as HTMLElement | null)?.popover) syncPopoverState()
  },
  true
)

// Belt and braces: any other code that drops an open popover from the DOM (the
// apps card menu goes with its card) would strand the class on, and the
// failure mode is nasty — every napp frozen until a full page reload. Re-syncing
// on pointerdown bounds that to a single click: with the class stuck, a click
// over a napp lands on the launcher, so this still runs. Recomputed from the
// DOM, so a genuinely open popover keeps the class.
document.addEventListener("pointerdown", syncPopoverState, { capture: true, passive: true })

export interface PopoverOptions<T> {
  // Builds the popover content; `resolve` settles the returned promise (e.g. a
  // menu item calls it with its value).
  build: (resolve: (value: T) => void) => Node
  // Returned when light-dismissed (click outside / Esc).
  dismissValue: T
  // Viewport coordinates to anchor the top-left at (clamped to stay on screen).
  x: number
  y: number
  class?: string
}

export function openPopover<T = string>(opts: PopoverOptions<T>): Promise<T> {
  return new Promise<T>(resolve => {
    const el = document.createElement("div")
    el.className = `app-popover${opts.class ? ` ${opts.class}` : ""}`
    el.popover = "auto" // top layer + light dismiss

    let settled = false
    const finish = (value: T) => {
      if (settled) return
      settled = true
      try {
        el.hidePopover()
      } catch {}
      el.remove()
      syncPopoverState() // removal won't reach the document toggle listener
      resolve(value)
    }

    // Light-dismiss (click outside / Esc) closes the popover → dismiss value.
    el.addEventListener("toggle", (e: Event) => {
      if ((e as ToggleEvent).newState === "closed") finish(opts.dismissValue)
    })

    el.appendChild(opts.build(finish))
    document.body.appendChild(el)

    el.style.left = `${opts.x}px`
    el.style.top = `${opts.y}px`
    el.showPopover()

    // Clamp into the viewport now that it has a measured size.
    const r = el.getBoundingClientRect()
    const pad = 8
    el.style.left = `${Math.max(pad, Math.min(opts.x, window.innerWidth - r.width - pad))}px`
    el.style.top = `${Math.max(pad, Math.min(opts.y, window.innerHeight - r.height - pad))}px`
  })
}
