import { test, expect } from "@playwright/test"
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure"
import { createHash } from "node:crypto"

const html = "<!doctype html><p>Verified napplet</p>"
const hash = createHash("sha256").update(html).digest("hex")
const sign = (
  kind: number,
  tags = [
    ["d", "verified"],
    ["x", hash]
  ]
) =>
  finalizeEvent(
    {
      kind,
      tags,
      created_at: 1,
      content: "Verification fixture"
    },
    generateSecretKey()
  )

test.beforeEach(async ({ page }) => {
  await page.goto("/harness/napplet.html")
  await page.evaluate(async () => {
    await import("/src/persistence.ts")
  })
})

test("a cached artifact loads offline only after its manifest signature is verified", async ({
  page
}) => {
  const manifest = sign(35129)
  const result = await page.evaluate(
    async ({ manifest, html, hash }) => {
      const { cacheArtifact } = await import("/src/nsite/artifact-cache.ts")
      const { loadNappletFromManifest } = await import("/src/nsite/napplet.ts")
      cacheArtifact(hash, new Blob([html]))
      const valid = await loadNappletFromManifest(manifest)
      let rejected = false
      try {
        await loadNappletFromManifest({ ...manifest, content: "tampered" })
      } catch {
        rejected = true
      }
      return { html: valid.html, rejected }
    },
    { manifest, html, hash }
  )
  expect(result).toEqual({ html, rejected: true })
})

test("signed manifests of another kind and legacy multi-file manifests are rejected", async ({
  page
}) => {
  const result = await page.evaluate(
    async manifests => {
      const { loadNappletFromManifest } = await import("/src/nsite/napplet.ts")
      return Promise.all(
        manifests.map(async manifest => {
          try {
            await loadNappletFromManifest(manifest)
            return false
          } catch {
            return true
          }
        })
      )
    },
    [
      sign(35128),
      sign(35129, [
        ["d", "legacy"],
        ["x", hash],
        ["path", "/index.html", hash]
      ])
    ]
  )
  expect(result).toEqual([true, true])
})

test("a pre-cancelled load cannot use a verified cached artifact", async ({ page }) => {
  expect(
    await page.evaluate(async manifest => {
      const { loadNappletFromManifest } = await import("/src/nsite/napplet.ts")
      try {
        await loadNappletFromManifest(manifest, undefined, { signal: AbortSignal.abort() })
        return false
      } catch (error) {
        return error instanceof DOMException && error.name === "AbortError"
      }
    }, sign(35129))
  ).toBe(true)
})
