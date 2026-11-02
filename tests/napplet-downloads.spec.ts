import { test, expect } from "@playwright/test"
import { createHash } from "node:crypto"

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex")

test.beforeEach(async ({ page }) => {
  await page.goto("/harness/napplet.html")
})

test("artifact downloads race servers and reject a response with the wrong hash", async ({
  page
}) => {
  const body = "<p>verified artifact</p>"
  let slowStarted = false
  await page.route("https://slow.example/**", async route => {
    slowStarted = true
    await new Promise(r => setTimeout(r, 800))
    await route.fulfill({ body })
  })
  await page.route("https://wrong.example/**", route => route.fulfill({ body: "corrupt" }))
  await page.route("https://fast.example/**", route => route.fulfill({ body }))
  const result = await page.evaluate(async hash => {
    const { fetchBlob } = await import("/src/nsite/download.ts")
    const start = performance.now()
    const blob = await fetchBlob(
      ["https://slow.example", "https://wrong.example", "https://fast.example"],
      hash,
      { concurrency: 3, maxBytes: 1024 }
    )
    return { text: await blob?.text(), elapsed: performance.now() - start }
  }, hashOf(body))
  expect(slowStarted).toBe(true)
  expect(result.text).toBe(body)
  expect(result.elapsed).toBeLessThan(750)
})

test("download size limits work without a Content-Length header", async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const { readBoundedBlob } = await import("/src/nsite/download.ts")
      let cancelled = false
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1025))
        },
        cancel() {
          cancelled = true
        }
      })
      try {
        await readBoundedBlob(new Response(stream), 1024)
        return { rejected: false, cancelled }
      } catch {
        return { rejected: true, cancelled }
      }
    })
  ).toEqual({ rejected: true, cancelled: true })
})

test("aborted artifact requests stop instead of trying another server", async ({ page }) => {
  const result = await page.evaluate(async hash => {
    const { fetchBlob } = await import("/src/nsite/download.ts")
    const controller = new AbortController()
    controller.abort()
    try {
      await fetchBlob(["https://never.example"], hash, { signal: controller.signal })
      return false
    } catch (error) {
      return error instanceof DOMException && error.name === "AbortError"
    }
  }, hashOf("artifact"))
  expect(result).toBe(true)
})

test("a persistent cache entry is hash-checked before it is trusted", async ({ page }) => {
  const hash = hashOf("authentic")
  expect(
    await page.evaluate(async hash => {
      const cache = await caches.open("nostrapps-napplet-artifacts-v1")
      const key = new URL(`/__napplet-artifacts/${hash}`, location.origin).href
      await cache.put(key, new Response("tampered"))
      const { cachedArtifact } = await import("/src/nsite/artifact-cache.ts")
      return {
        result: (await cachedArtifact(hash)) === undefined,
        removed: (await cache.match(key)) === undefined
      }
    }, hash)
  ).toEqual({ result: true, removed: true })
})

test("verified artifacts remain available after a page reload", async ({ page }) => {
  const body = "<p>offline artifact</p>"
  const hash = hashOf(body)
  await page.evaluate(
    async ({ hash, body }) => {
      const { cacheArtifact } = await import("/src/nsite/artifact-cache.ts")
      cacheArtifact(hash, new Blob([body]))
    },
    { hash, body }
  )
  await expect
    .poll(() =>
      page.evaluate(
        async hash =>
          !!(await (
            await caches.open("nostrapps-napplet-artifacts-v1")
          ).match(new URL(`/__napplet-artifacts/${hash}`, location.origin).href)),
        hash
      )
    )
    .toBe(true)
  await page.reload()
  expect(
    await page.evaluate(async hash => {
      const { cachedArtifact } = await import("/src/nsite/artifact-cache.ts")
      return (await cachedArtifact(hash))?.text()
    }, hash)
  ).toBe(body)
})
