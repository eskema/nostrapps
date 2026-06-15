// Reusable floating card anchored at a point (e.g. the cursor) — a non-modal,
// light-dismissing popover for context-menu-style UI. Built on the Popover API
// (top layer + Esc / click-outside dismiss). Parallels openDialog() (modal) in
// dialog.ts — pick whichever fits the interaction.

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
