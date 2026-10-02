import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig, transformWithEsbuild, type Plugin } from "vite"
import { iconInk, icons } from "./src/system-napps/ui.ts"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const CSS_HEAD = `/* napp-ui.css: the nostrapps kit, for napps that declare \`requires: ["ui"]\`.
   Generated from the launcher's src/ui.css by its build; the launcher wears
   the same rules. Injected at the top of the napp's <head>, before its own
   styles, with /napp-ui.js (window.napp.ui, the helpers that build these
   elements). --surface and --text follow the launcher's theme live. The fonts
   are inlined: a separate font request is fetched in CORS mode, which the
   napp-origin passthrough can't serve. */

`

const JS_HEAD = `// napp-ui.js: the nostrapps kit's helpers as window.napp.ui, for napps that
// declare \`requires: ["ui"]\`. Generated from the launcher's
// src/system-napps/ui.ts by its build. Types: napp-env.d.ts. Outside the
// launcher there is no bridge, so the script makes window.napp itself.
`

// author() finds its profiles, npubs and the profile action through the
// bridge, looked up when used: the bridge may land after this script.
const AUTHORS = `__nappUi.authors.use({
  load: pubkey => window.napp.utils.loadNostrUser(pubkey),
  npub: pubkey => window.napp.nip19.npubEncode(pubkey),
  open: pubkey => window.napp.action("profile", pubkey).catch(() => {})
})
`

// The kit as napps get it: src/ui.css as /napp-ui.css, the launcher's fonts
// inlined and the icon glyphs as classes, and src/system-napps/ui.ts as
// /napp-ui.js, its exports on window.napp.ui. The service worker injects both
// into a napp that declares `requires: ["ui"]`. Served in dev, written to
// dist/ by the build.
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
      font("Source Sans 3 Variable", "source-sans-3") +
      font("Source Sans 3 Variable", "source-sans-3", "italic") +
      font("Source Serif 4 Variable", "source-serif-4") +
      font("Source Serif 4 Variable", "source-serif-4", "italic") +
      font("Source Code Pro Variable", "source-code-pro") +
      font("Source Code Pro Variable", "source-code-pro", "italic") +
      "\n" +
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
    return `${JS_HEAD}(() => {\n${code}(window.napp ||= {}).ui = __nappUi\n${AUTHORS}})()\n`
  }
  return {
    name: "napp-ui",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || "").split("?")[0]
        if (path !== "/napp-ui.css" && path !== "/napp-ui.js") return next()
        res.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript")
        res.setHeader("Cache-Control", "no-store")
        res.end(path.endsWith(".css") ? css() : await js())
      })
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "napp-ui.css", source: css() })
      this.emitFile({ type: "asset", fileName: "napp-ui.js", source: await js() })
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
  plugins: [nappUi(), upgradeInsecureRequests()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    cors: true,
    // Vite 5.4+ blocks unknown Host headers in dev to mitigate DNS rebinding.
    // Our per-napp origins land at `<id>.napps.localhost:5173`, which isn't
    // in the implicit allow-list. The leading dot makes this a wildcard.
    allowedHosts: [".localhost"]
  },
  preview: {
    allowedHosts: [".localhost"]
  },
  optimizeDeps: {
    exclude: ["@nostr/gadgets/redstore"]
  }
})
