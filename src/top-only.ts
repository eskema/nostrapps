// The launcher runs only as the top page. In a frame it is on a napp's origin
// (a request the napp's service worker missed), and what it stores there the
// napp can read. The throw stops every module after this one, main.ts too.
if (window.top !== window) {
  document.documentElement.replaceChildren()
  throw new Error("nostrapps runs only as the top page")
}

export {}
