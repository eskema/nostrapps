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

  if (path === "/boot.html") return fetch(req)
  if (path === "/sw.js") return fetch(req)
  if (path === "/bridge.js") return fetch(req)

  if (url.host.startsWith("dev-")) {
    try {
      const devFile = await requestFileFromHost(path)
      if (devFile) {
        const mime = devFile.mime || "application/octet-stream"
        if (mime.startsWith("text/html")) {
          const text =
            typeof devFile.body === "string" ? devFile.body : await new Blob([devFile.body]).text()
          return new Response(injectBridge(text), {
            status: 200,
            headers: { "Content-Type": mime }
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
