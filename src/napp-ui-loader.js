// napp-ui-loader.js: the kit outside the launcher. The build makes it one line,
// `just kit` copies it into a napp's kit/, and the nostrapps ui kit napp shows
// the line for a napp's head: this function called with window.napp, the
// Blossom servers to try and the sha256 of napp-ui.css, napp-ui.js and,
// optionally, napp-fonts.css. Pinned: a newer kit is a newer line.
// A kit already there with every helper of this one (the launcher's) is left
// alone, its fonts asked for if the line has them; otherwise, no kit or
// another launcher's, every server is asked at once and this kit takes
// napp.ui. Either way window.napp.ready is a promise to await before the
// first helper.
;(napp, servers, css, js, fonts) => {
  // KIT, the helpers' names, is filled in by the build.
  if (napp.ui && KIT.split(" ").every(name => name in napp.ui)) {
    napp.ready = Promise.resolve()
    if (fonts && napp.ui.fonts) napp.ui.fonts().catch(() => {})
    return
  }
  // A Blossom hash is a sha256, what an integrity check takes: the browser
  // refuses bytes that don't match.
  const integrity = hash =>
    "sha256-" + btoa(String.fromCharCode(...hash.match(/../g).map(h => parseInt(h, 16))))
  // The first server to bring the right bytes wins and the rest are called
  // off. The tag then takes its url, out of the browser's cache.
  const load = (hash, ext, make) => {
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), 15000)
    return Promise.any(
      servers.map(server => {
        const url = server.replace(/\/+$/, "") + "/" + hash + ext
        return fetch(url, { integrity: integrity(hash), signal: stop.signal }).then(r => {
          if (!r.ok) throw new Error(r.status)
          return url
        })
      })
    )
      .finally(() => {
        clearTimeout(timer)
        stop.abort()
      })
      .then(
        url =>
          new Promise((resolve, reject) => {
            const el = make(url)
            el.integrity = integrity(hash)
            el.crossOrigin = "anonymous"
            el.onload = () => resolve()
            el.onerror = () => reject(new Error("napp-ui: " + url))
            // At the top of the head: the stylesheet lands before the napp's own.
            document.head.prepend(el)
          }),
        () => {
          throw new Error("napp-ui: " + hash + ext + " on no server")
        }
      )
  }
  const link = url => Object.assign(document.createElement("link"), { rel: "stylesheet", href: url })
  // The faces fill the kit's slots, so they can land in any order; without
  // them the text stays in the system's fonts.
  if (fonts) load(fonts, ".css", link).catch(() => {})
  napp.ready = Promise.all([
    load(css, ".css", link),
    load(js, ".js", url => Object.assign(document.createElement("script"), { src: url }))
  ]).then(() => {})
}
