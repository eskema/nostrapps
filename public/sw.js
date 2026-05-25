const DB_NAME = `files-${self.location.origin.split("://")[1]}`
const DB_VERSION = 1
const STORE = "files"

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()))

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(handleFetch(event.request, url))
})

async function handleFetch(_request, url) {
  let path = url.pathname
  if (path.endsWith("/")) path += "index.html"

  const record = await getFile(path)
  if (!record) {
    // Can't pass a navigation-mode Request to fetch(); refetch by URL.
    return fetch(url.href)
  }

  const mime = record.mime || "application/octet-stream"
  if (mime.startsWith("text/html")) {
    const text = typeof record.body === "string" ? record.body : await record.body.text()
    return new Response(injectBridge(text), {
      status: 200,
      headers: { "Content-Type": mime }
    })
  }
  return new Response(record.body, {
    status: 200,
    headers: { "Content-Type": mime }
  })
}

function injectBridge(html) {
  const bridgeTag = '<script src="/bridge.js"></script>'
  const readyTag =
    '<script>window.parent.postMessage({ __nostrapps: "napp-ready", instanceId: (window.name||"") }, "*")</script>'

  let result = html
  const headMatch = result.match(/<head[^>]*>/i)
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length
    result = result.slice(0, idx) + bridgeTag + result.slice(idx)
  } else {
    result = bridgeTag + result
  }

  const endIdx = result.indexOf("</html>")
  if (endIdx >= 0) {
    result = result.slice(0, endIdx) + readyTag + result.slice(endIdx)
  } else {
    result = result + readyTag
  }

  return result
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

async function getFile(path) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
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
}
