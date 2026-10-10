import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, transformWithEsbuild, type Plugin } from "vite"
import * as kit from "./src/system-napps/ui.ts"

const { iconInk, icons } = kit

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const CSS_HEAD = `/* napp-ui.css: the nostrapps kit, for napps that declare \`requires: ["ui"]\`.
   Generated from the launcher's src/ui.css by its build; the launcher wears
   the same rules. Injected at the top of the napp's <head>, before its own
   styles, with /napp-ui.js (window.napp.ui, the helpers that build these
   elements). --surface and --text follow the launcher's theme live. The text
   is in the system's fonts; /napp-fonts.css brings the launcher's. */

`

const FONTS_HEAD = `/* napp-fonts.css: the nostrapps launcher's faces in the kit's font slots,
   napp-sans, napp-serif and napp-mono, for a napp that asks with
   napp.ui.fonts(). The latin subset, inlined: a separate font request is
   fetched in CORS mode, which the napp-origin passthrough can't serve. */

`

const JS_HEAD = `// napp-ui.js: the nostrapps kit's helpers as window.napp.ui, for napps that
// declare \`requires: ["ui"]\`. Generated from the launcher's
// src/system-napps/ui.ts by its build. Types: napp-env.d.ts. Outside the
// launcher there is no bridge, so the script makes window.napp itself.
`

// The kit's font slots and the faces the launcher fills them with.
const FONTS = [
  { slot: "napp-sans", pkg: "source-sans-3", family: "Source Sans 3 Variable" },
  { slot: "napp-serif", pkg: "source-serif-4", family: "Source Serif 4 Variable" },
  { slot: "napp-mono", pkg: "source-code-pro", family: "Source Code Pro Variable" }
]

// fonts(): the faces next to a kit served by name, a launcher's /napp-ui.js or
// a napp's own kit/napp-ui.js. One from Blossom by hash has nothing next to
// it, and no fonts().
const FONTS_JS = `const src = document.currentScript?.src
if (src && new URL(src).pathname.endsWith("/napp-ui.js")) {
  let loading
  __nappUi.fonts = () =>
    (loading ||= new Promise((resolve, reject) => {
      const link = Object.assign(document.createElement("link"), {
        rel: "stylesheet",
        href: new URL("napp-fonts.css", src).href
      })
      // Called from the head, the first paint waits for it (Chromium).
      link.setAttribute("blocking", "render")
      link.onload = () => resolve()
      link.onerror = () => {
        link.remove()
        loading = undefined
        reject(new Error("napp-fonts.css did not load"))
      }
      document.head.append(link)
    }))
}
`

// author() finds its profiles, npubs and the profile action through the
// bridge, looked up when used: the bridge may land after this script.
const AUTHORS = `__nappUi.authors.use({
  load: pubkey => window.napp.utils.loadNostrUser(pubkey),
  npub: pubkey => window.napp.nip19.npubEncode(pubkey),
  open: pubkey => void window.napp.action?.("profile", pubkey)?.catch(() => {})
})
`

// The kit as napps get it: src/ui.css as /napp-ui.css, the icon glyphs as
// classes, and src/system-napps/ui.ts as /napp-ui.js, its exports on
// window.napp.ui. The service worker injects both into a napp that declares
// `requires: ["ui"]`. Beside them /napp-fonts.css, the launcher's faces, and
// /napp-ui-loader.js, the line that brings the kit from Blossom elsewhere.
// Served in dev, written to dist/ by the build.
function nappUi(): Plugin {
  const font = (family: string, pkg: string, style: "normal" | "italic" = "normal") => {
    // The latin subset, variable weight, as the launcher loads it. Upright and
    // italic both, so italic text is the real face, never slanted by the browser.
    const file = here(
      `node_modules/@fontsource-variable/${pkg}/files/${pkg}-latin-wght-${style}.woff2`
    )
    const data = readFileSync(file).toString("base64")
    return `@font-face {
  font-family: "${family}";
  font-style: ${style};
  font-display: swap;
  font-weight: 200 900;
  src: url("data:font/woff2;base64,${data}") format("woff2");
}
`
  }
  const glyph = (body: string) =>
    "data:image/svg+xml;base64," +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    ).toString("base64")
  const css = () => {
    const names = Object.keys(icons)
    return (
      CSS_HEAD +
      readFileSync(here("src/ui.css"), "utf8") +
      `
/* The glyphs as masks, for markup without icon():
     <span class="ui-icon ui-icon-plus"></span> */
${names.map(n => `.ui-icon-${n}`).join(",\n")} {
  display: inline-block;
  width: 1em;
  height: 1em;
  background-color: currentColor;
  -webkit-mask: center / contain no-repeat;
  mask: center / contain no-repeat;
}
` +
      names
        .map(n => {
          const url = glyph(icons[n])
          const ink = iconInk[n]
          const inset = ink ? `  --ink-start: ${ink[0]}em;\n  --ink-end: ${ink[1]}em;\n` : ""
          return `.ui-icon-${n} {\n${inset}  -webkit-mask-image: url("${url}");\n  mask-image: url("${url}");\n}\n`
        })
        .join("")
    )
  }
  const js = async () => {
    const path = here("src/system-napps/ui.ts")
    const { code } = await transformWithEsbuild(readFileSync(path, "utf8"), path, {
      format: "iife",
      globalName: "__nappUi",
      sourcemap: false
    })
    return `${JS_HEAD}(() => {\n${code}(window.napp ||= {}).ui = __nappUi\n${FONTS_JS}${AUTHORS}})()\n`
  }
  const fonts = () =>
    FONTS_HEAD + FONTS.map(f => font(f.slot, f.pkg) + font(f.slot, f.pkg, "italic")).join("")
  // One line, the function the line calls: comments and whitespace go, and
  // the statement's semicolons, so the line can wrap it in parens. KIT is the
  // kit's helpers, what the line checks a launcher's napp.ui for.
  const loader = async () => {
    const path = here("src/napp-ui-loader.js")
    const { code } = await transformWithEsbuild(readFileSync(path, "utf8"), path, {
      minifyWhitespace: true,
      define: { KIT: JSON.stringify(Object.keys(kit).join(" ")) },
      sourcemap: false
    })
    return code.trim().replace(/^;|;$/g, "")
  }
  const files: Record<string, () => string | Promise<string>> = {
    "napp-ui.css": css,
    "napp-ui.js": js,
    "napp-fonts.css": fonts,
    "napp-ui-loader.js": loader
  }
  return {
    name: "napp-ui",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = (req.url || "").split("?")[0].slice(1)
        if (!Object.hasOwn(files, name)) return next()
        res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript")
        res.setHeader("Cache-Control", "no-store")
        res.end(await files[name]())
      })
    },
    async generateBundle() {
      for (const [fileName, make] of Object.entries(files))
        this.emitFile({ type: "asset", fileName, source: await make() })
    }
  }
}

// The launcher's own faces: fontsource's, every script of them, renamed into
// the kit's slots as main.ts imports them.
function fontSlots(): Plugin {
  return {
    name: "font-slots",
    enforce: "pre",
    transform(code, id) {
      if (!/\.css($|\?)/.test(id)) return
      const f = FONTS.find(f => id.includes(`/@fontsource-variable/${f.pkg}/`))
      if (f) return code.replaceAll(`'${f.family}'`, `"${f.slot}"`)
    }
  }
}

// Avatars and icons come from arbitrary nostr events: the build upgrades
// http:// loads so one stale picture URL can't flag the whole origin as
// insecure. Not in dev: the server has no TLS, and Safari upgrades localhost
// too, the launcher's own scripts included.
function upgradeInsecureRequests(): Plugin {
  return {
    name: "upgrade-insecure-requests",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: "upgrade-insecure-requests" },
        injectTo: "head"
      }
    ]
  }
}

export default defineConfig({
  plugins: [nappUi(), fontSlots(), upgradeInsecureRequests()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    cors: true,
    // Vite 5.4+ blocks unknown Host headers in dev to mitigate DNS rebinding.
    // Our per-napp origins land at `<id>.napps.localhost:5173`, which isn't
    // in the implicit allow-list. The leading dot makes this a wildcard.
    allowedHosts: [".localhost"],
    // @nostr/gadgets is symlinked to a sibling checkout outside the root
    // (node_modules/@nostr/gadgets -> ../nostr-gadgets), and redstore's
    // worker is served from there via /@fs in dev. Without this the worker
    // request 403s (or falls back to index.html → a text/html MIME error).
    fs: {
      allow: [here("."), here("../nostr-gadgets")]
    }
  },
  preview: {
    allowedHosts: [".localhost"]
  },
  optimizeDeps: {
    exclude: ["@nostr/gadgets/redstore"]
  }
})
