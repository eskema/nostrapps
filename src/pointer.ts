// Shared pointer position for cursor-anchored UI (e.g. the action-handler
// popover). Updated by the launcher's own pointermove AND by napp dispatches:
// pointer events inside a napp iframe never reach the launcher, so the bridge
// forwards the in-iframe pointer with each action and host.ts converts it to
// screen coordinates via that napp's iframe rect.
let pointer = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) }

export function setPointer(x: number, y: number) {
  pointer = { x, y }
}

export function getPointer() {
  return pointer
}
