const DB_NAME = `files-${self.location.origin.split("://")[1]}`
const DB_VERSION = 1
const STORE = "files"

const pendingFileReads = new Map()

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()))

self.addEventListener("message", event => {
  const data = event.data
  if (!data) return

  if (data.__nostrapps === "sw-file-result") {
    const pending = pendingFileReads.get(data.requestId)
    if (pending) {
      pendingFileReads.delete(data.requestId)
      clearTimeout(pending.timer)
      if (data.error) {
        pending.reject(new Error(data.error))
      } else {
        pending.resolve(data)
      }
    }
    return
  }
})

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(handleFetch(event.request, url))
})

async function handleFetch(req, url) {
  let path = url.pathname
  if (path.endsWith("/")) path += "index.html"

  // The policy record is internal — it's how the launcher tells this worker the
  // napp's network grant. Never serve it back to the napp as a file.
  if (path === "/__policy__") return new Response("not found", { status: 404 })

  if (path === "/boot.html") return fetch(req)
  if (path === "/sw.js") return fetch(req)
  if (path === "/bridge.js") return fetch(req)
  if (path === "/napplet-bridge.js") return fetch(req)
  // Signing companion lazy-imported by bridge.js (napp.utils.signWithKey /
  // generateKey) — generated from @nostr/tools/pure, served like bridge.js.
  if (path === "/nostr-crypto.js") return fetch(req)
  // Launcher-owned shared stylesheet (opt-in via metadata `ui: "wrapper"`),
  // served from the launcher origin for every napp subdomain like bridge.js.
  // Its fonts are inlined as data URIs inside it (a separate /fonts/ request is
  // fetched in CORS mode, which fails the napp-subdomain passthrough).
  if (path === "/napp-ui.css") return fetch(req)

  if (url.host.startsWith("dev-") || url.host.startsWith("temp-")) {
    try {
      const devFile = await requestFileFromHost(path)
      if (devFile) {
        const mime = devFile.mime || "application/octet-stream"
        if (mime.startsWith("text/html")) {
          const text =
            typeof devFile.body === "string" ? devFile.body : await new Blob([devFile.body]).text()
          const policy = await readDevPolicy()
          const grants = grantsFor(policy)
          const wrapperUi = grants.includes("ui") || (await devWantsWrapper())
          return new Response(injectBridge(text, { wrapperUi, domains: grants }), {
            status: 200,
            headers: htmlHeaders(mime, policy)
          })
        }
        return new Response(devFile.body, {
          status: 200,
          headers: { "Content-Type": mime }
        })
      }
    } catch {
      // file not in dev handle, fall through to network fetch
    }
  } else {
    const db = await openDB()
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      const req = tx.objectStore(STORE).get(path)
      req.onsuccess = () => {
        const result = req.result ?? null
        try {
          db.close()
        } catch {}
        resolve(result)
      }
      req.onerror = () => {
        try {
          db.close()
        } catch {}
        reject(req.error)
      }
    })
    if (record) {
      const mime = record.mime || "application/octet-stream"
      if (mime.startsWith("text/html")) {
        const text = typeof record.body === "string" ? record.body : await record.body.text()
        const policy = await readInstalledPolicy()
        const grants = grantsFor(policy)
        const wrapperUi = grants.includes("ui") || (await installedWantsWrapper())
        return new Response(injectBridge(text, { wrapperUi, domains: grants }), {
          status: 200,
          headers: htmlHeaders(mime, policy)
        })
      }
      return new Response(record.body, {
        status: 200,
        headers: { "Content-Type": mime }
      })
    }
  }

  return new Response(`file ${url} not found`, {
    status: 404
  })
}

let serial = 1
async function requestFileFromHost(path) {
  return new Promise((resolve, reject) => {
    const requestId = `${serial++}`
    const timer = setTimeout(() => {
      pendingFileReads.delete(requestId)
      reject(new Error("Timeout requesting " + path))
    }, 25000)

    pendingFileReads.set(requestId, { resolve, reject, timer })

    self.clients.matchAll().then(clients => {
      for (const client of clients) {
        client.postMessage({
          __nostrapps: "sw-read-file",
          requestId,
          path
        })
      }
    })
  })
}

// The Content-Security-Policy that SEALS a locked napp to its own origin. It's
// not enough to pin connect-src: a napp — especially a full-website nsite —
// reaches the network through resource tags connect-src never sees (<script
// src>, <img>, <link>, nested <iframe>, <form>), and a cross-origin child frame
// would then have its own unrestricted network. So the lock is default-src
// 'self' with only LOCAL escape hatches (blob:/data:, both same-document), which
// blocks every off-origin load and connection at once. 'unsafe-inline' stays for
// script/style because inline code is ubiquitous in real napps and can't defeat
// the seal — it still can't fetch, open a socket, pull an external script/image,
// or embed an external frame. A napp's only route off-origin is then the
// bridge's postMessage rpc (not CSP-governed) — the launcher's mediated
// capabilities, which is the point. Granting network drops the CSP entirely.
//
// worker-src 'none' is load-bearing, not decorative: a document's connect-src
// does NOT govern a service/web worker's network — a worker's connections are
// bounded only by the CSP on its OWN script response, which we don't set. So a
// same-origin worker (worker-src otherwise falls back to child-src 'self') could
// open a wss:// to any relay, entirely outside this connect-src. Denying worker
// creation while locked closes that bypass (matches napplets' NAPPLET_CSP).
const LOCKED_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "frame-src 'self'",
  "child-src 'self' blob:",
  "worker-src 'none'",
  "form-action 'self'",
  "base-uri 'self'"
].join("; ")

// The granted domains, with version-aware back-fills applied so an upgrade
// doesn't silently strip access that older policy records couldn't have named.
// The SW only ever serves nsites/napps (napplets are srcdoc, never served), so
// pre-v2 records — written before `identity` gated window.nostr — are treated
// as identity-granted. New records (v>=2) are honored exactly, so unchecking
// identity or network in the permission screen takes effect.
function grantsFor(policy) {
  if (!policy) return []
  const domains = Array.isArray(policy.domains) ? [...policy.domains] : []
  if (policy.network === true && !domains.includes("network")) domains.push("network")
  if ((policy.v || 0) < 2 && !domains.includes("identity")) domains.push("identity")
  return domains
}

function htmlHeaders(mime, policy) {
  const headers = { "Content-Type": mime }
  // Locked unless the user granted the `network` capability. Network-granted
  // napps still get http:// loads upgraded — one stale image URL would
  // otherwise flag the whole page as insecure (CSP is per-document, so the
  // launcher's own upgrade meta doesn't reach napp frames).
  headers["Content-Security-Policy"] = grantsFor(policy).includes("network")
    ? "upgrade-insecure-requests"
    : LOCKED_CSP + "; upgrade-insecure-requests"
  return headers
}

function parsePolicy(text) {
  try {
    const p = JSON.parse(text)
    return p && typeof p === "object" ? p : null
  } catch {
    return null
  }
}

async function readInstalledPolicy() {
  try {
    const db = await openDB()
    const rec = await new Promise(resolve => {
      const tx = db.transaction(STORE, "readonly")
      const r = tx.objectStore(STORE).get("/__policy__")
      r.onsuccess = () => resolve(r.result ?? null)
      r.onerror = () => resolve(null)
    })
    try {
      db.close()
    } catch {}
    if (!rec) return null // no record = locked
    const text = typeof rec.body === "string" ? rec.body : await rec.body.text()
    return parsePolicy(text)
  } catch {
    return null
  }
}

async function readDevPolicy() {
  try {
    const rec = await requestFileFromHost("/__policy__")
    if (!rec || rec.error) return null
    const text = typeof rec.body === "string" ? rec.body : await new Blob([rec.body]).text()
    return parsePolicy(text)
  } catch {
    return null
  }
}

function injectBridge(html, { wrapperUi = false, domains = [] } = {}) {
  // NIP-5D presence model: the shell declares the granted capability domains as
  // window.__nappletDomains BEFORE bridge.js runs; bridge.js then builds
  // window.napplet with exactly those domain objects. `<` is escaped so a domain
  // string can never break out of the inline <script>.
  const domainList = Array.isArray(domains) ? domains : []
  const domainsScript =
    "<script>window.__nappletDomains=" +
    JSON.stringify(domainList).replace(/</g, "\\u003c") +
    "</script>"
  // Injected at the top of <head>, so the shared stylesheet lands BEFORE the
  // napp's own styles and the napp can still override it. __nappletDomains must
  // precede napplet-bridge.js (which reads it). bridge.js owns window.nostr /
  // window.napp; napplet-bridge.js owns window.napplet.
  const headInject =
    domainsScript +
    '<script src="/napplet-bridge.js"></script>' +
    '<script src="/bridge.js"></script>' +
    (wrapperUi ? '<link rel="stylesheet" href="/napp-ui.css">' : "")
  const readyTag =
    '<script>window.parent.postMessage({ __nostrapps: "napp-ready", instanceId: window.name }, "*")</script>'

  let result = html
  const headMatch = result.match(/<head[^>]*>/i)
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length
    result = result.slice(0, idx) + headInject + result.slice(idx)
  } else {
    result = headInject + result
  }

  const endIdx = result.indexOf("</html>")
  if (endIdx >= 0) {
    result = result.slice(0, endIdx) + readyTag + result.slice(endIdx)
  } else {
    result = result + readyTag
  }

  return result
}

// The wrapper design system is a granted capability (`ui`) read from the
// per-napp policy — see grantsFor() at the serve sites. TEMPORARY back-compat:
// existing apps still declare `ui: "wrapper"` in metadata.json rather than
// `requires: ["ui"]`, so we also detect that flag and apply the wrapper. Remove
// once apps have migrated to the requires declaration.
function wrapperFromMetaText(text) {
  try {
    const m = JSON.parse(text)
    return !!m && m.ui === "wrapper"
  } catch {
    return false
  }
}

async function installedWantsWrapper() {
  try {
    const db = await openDB()
    const rec = await new Promise(resolve => {
      const tx = db.transaction(STORE, "readonly")
      const r = tx.objectStore(STORE).get("/metadata.json")
      r.onsuccess = () => resolve(r.result ?? null)
      r.onerror = () => resolve(null)
    })
    try {
      db.close()
    } catch {}
    if (!rec) return false
    const text = typeof rec.body === "string" ? rec.body : await rec.body.text()
    return wrapperFromMetaText(text)
  } catch {
    return false
  }
}

async function devWantsWrapper() {
  try {
    const meta = await requestFileFromHost("/metadata.json")
    if (!meta || meta.error) return false
    const text = typeof meta.body === "string" ? meta.body : await new Blob([meta.body]).text()
    return wrapperFromMetaText(text)
  } catch {
    return false
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "path" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
