// State-preserving DOM move. `moveBefore` (Chromium 133+) relocates a node
// WITHOUT the remove + re-insert that `insertBefore` performs — so an <iframe>
// inside the moved node keeps running instead of reloading (and CSS transitions,
// focus, scroll position, etc. survive). Falls back to insertBefore where the
// API isn't available. `before === null` moves the node to the end.
export function moveBefore(parent: Node, node: Node, before: Node | null) {
  const p = parent as Node & { moveBefore?: (n: Node, b: Node | null) => void }
  if (typeof p.moveBefore === "function") {
    try {
      p.moveBefore(node, before)
      return
    } catch {
      // e.g. node not connected — fall back (will reload an iframe, but works)
    }
  }
  parent.insertBefore(node, before)
}
