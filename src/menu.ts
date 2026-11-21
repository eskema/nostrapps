// A menu under its trigger: a popover, so it renders in the top layer (never
// clipped or mis-stacked under its host), light-dismisses on outside click and
// Esc, napp iframes included (popover.ts). Any scroll closes it, as a native
// menu does, and so does an item as it runs, so what the item asks shows on its
// own. `items` runs as it opens: the menu shows the state of that moment. The
// menu lives in `host` so it goes with it.

let serial = 0

export function attachMenu(
  trigger: HTMLButtonElement,
  host: HTMLElement,
  items: () => HTMLElement[],
  cls?: string
): HTMLElement {
  const menu = document.createElement("div")
  menu.className = cls ? `launcher-menu ${cls}` : "launcher-menu"
  menu.popover = "auto"
  menu.addEventListener(
    "click",
    e => {
      if ((e.target as Element).closest("button")) menu.hidePopover()
    },
    true
  )
  // A click in it is not a click on its host.
  menu.addEventListener("click", e => e.stopPropagation())
  let scrollOff: AbortController | null = null
  menu.addEventListener("beforetoggle", ev => {
    if ((ev as ToggleEvent).newState === "open") menu.replaceChildren(...items())
  })
  menu.addEventListener("toggle", ev => {
    scrollOff?.abort()
    scrollOff = null
    if ((ev as ToggleEvent).newState !== "open") return
    scrollOff = new AbortController()
    document.addEventListener(
      "scroll",
      () => {
        if (menu.matches(":popover-open")) menu.hidePopover()
      },
      { capture: true, passive: true, once: true, signal: scrollOff.signal }
    )
  })
  host.appendChild(menu)

  trigger.popoverTargetElement = menu
  // Anchored to the trigger (launcher.css). An engine without anchor
  // positioning places it under the trigger as it opens.
  if (CSS.supports("anchor-name: --a")) {
    const name = `--launcher-menu-${++serial}`
    trigger.style.setProperty("anchor-name", name)
    menu.style.setProperty("position-anchor", name)
  } else {
    menu.addEventListener("beforetoggle", ev => {
      if ((ev as ToggleEvent).newState !== "open") return
      const r = trigger.getBoundingClientRect()
      menu.style.top = `${Math.round(r.bottom + 4)}px`
      menu.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`
    })
  }
  return menu
}
