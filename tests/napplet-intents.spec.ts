import { test, expect, type Page } from "@playwright/test"
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure"
import { createHash } from "node:crypto"

const targetHtml = `<p id="delivery">waiting</p><script>window.deliveries=[];window.listen=()=>napplet.intent.onDelivery(d=>{deliveries.push(d);document.querySelector('#delivery').textContent=JSON.stringify(deliveries)});setTimeout(listen,80)</script>`
const manifest = finalizeEvent({ kind: 35129, created_at: 1, content: "Intent reader", tags: [["d", "intent-reader"], ["title", "Intent Reader"], ["x", createHash("sha256").update(targetHtml).digest("hex")], ["R", "intent"], ["z", "note"], ["i", "napplet:note/open", "id"]] }, generateSecretKey())
const sourceId = "napplet~local~intent-source"
const sourceHtml = `<p id="result">ready</p><a id="link" href="napplet:note/open?id=from-link">Open note</a><script>window.invoke=async(options)=>{try{const r=await napplet.intent.invoke('napplet:note/open',options);document.querySelector('#result').textContent=JSON.stringify(r);return r}catch(e){document.querySelector('#result').textContent=e.message}}</script>`
async function setup(page: Page, granted = true) {
  await page.goto("/harness/napplet.html")
  await page.evaluate(async ({ manifest, targetHtml, sourceHtml, sourceId, granted }) => {
    const host = await import("/src/sandbox/host.ts")
    const manager = await import("/src/intents/manager.ts")
    const persistence = await import("/src/persistence.ts")
    const { cacheArtifact } = await import("/src/nsite/artifact-cache.ts")
    const { loadNappletFromManifest } = await import("/src/nsite/napplet.ts")
    const account = await import("/src/account.ts")
    account.setAccount(null, null)
    ;(window as any).relayPool.querySync = async () => []
    persistence.storeInstalledEvent(manifest)
    const targetId = persistence.computeNappId(manifest)
    persistence.setPolicy(targetId, { domains: ["intent"] })
    persistence.storeInstalledLocalApp({ nappId: sourceId, html: sourceHtml, requires: ["intent"] })
    persistence.setPolicy(sourceId, { domains: granted ? ["intent"] : [] })
    cacheArtifact(manifest.tags.find(t => t[0] === "x")![1], new Blob([targetHtml]))
    manager.configureIntents({
      action: async () => ({ ok: true }), loadEvent: async () => null,
      async deliver(event, request, delivery, context) {
        context.check()
        const resolved = await loadNappletFromManifest(event, undefined, { signal: context.signal })
        context.check()
        let win = request.behavior?.reuse === false ? null : host.findOpenWindowByNappId(targetId)
        win ??= host.launchNapplet(document.querySelector("#stage")!, targetId, resolved.html)
        return host.deliverNappletIntent(win, delivery, context.check, context.signal)
      }
    })
    const source = host.launchNapplet(document.querySelector("#stage")!, sourceId, sourceHtml, { instanceId: "intent-source" })
    Object.assign(window, { host, manager, persistence, account, source, targetId })
  }, { manifest, targetHtml, sourceHtml, sourceId, granted })
  await expect(page.frameLocator('iframe').locator('#result')).toHaveText("ready")
}
async function invoke(page: Page, options = { payload: { id: "note-1" } }) {
  await page.frames().find(f => f !== page.mainFrame())!.evaluate(options => { void (window as any).invoke(options) }, options)
}

test("selects, verifies and delivers once with an attested sender, buffers for late listeners, and reuses the target", async ({ page }) => {
  await setup(page)
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  const source = page.frames()[1]!
  await expect.poll(() => source.locator('#result').textContent()).toContain('"ok":true')
  const target = page.frames()[2]!
  await expect(target.locator('#delivery')).toContainText('"id":"note-1"')
  const deliveries = await target.evaluate(() => (window as any).deliveries)
  expect(deliveries).toEqual([{ sender: `nostrapps:local:${sourceId}`, archetype: "note", action: "open", convention: "napplet:note/open", payload: { id: "note-1" } }])
  await invoke(page)
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  await expect.poll(() => target.evaluate(() => (window as any).deliveries.length)).toBe(2)
  await expect(page.locator('iframe')).toHaveCount(2)
  expect(await target.evaluate(() => typeof (window as any).nostr)).toBe("undefined")
  await page.evaluate(() => { const w = window as any; w.host.reloadNappletWindows(w.targetId, `<p id="after">reloaded</p><script>window.deliveries=[];napplet.intent.onDelivery(d=>deliveries.push(d))</script>`) })
  await expect(target.locator('#after')).toHaveText("reloaded")
  expect(await target.evaluate(() => (window as any).deliveries)).toEqual([])
})

test("napplet anchors open another napplet with URI query payloads", async ({ page }) => {
  await setup(page)
  await page.frames()[1]!.locator('#link').click()
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  await expect(page.locator("iframe")).toHaveCount(2)
  await expect(page.frames()[2]!.locator('#delivery')).toContainText('"id":"from-link"')
})

test("cancel, permission denial, forged sender and unknown explicit handler fail without launching a target", async ({ page }) => {
  await setup(page)
  await invoke(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.frames()[1]!.locator('#result')).toContainText('"ok":false')
  await page.frames()[1]!.evaluate(() => { void (window as any).invoke({ handler: "invented" }) })
  await expect(page.frames()[1]!.locator('#result')).toContainText('Unknown or incompatible handler')
  await page.frames()[1]!.evaluate(() => parent.postMessage({ type: "intent.invoke", id: "forged", request: { archetype: "note", action: "open", convention: "napplet:note/open", sender: "victim" } }, "*"))
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.evaluate(sourceId => (window as any).persistence.setPolicy(sourceId, { domains: [] }), sourceId)
  await invoke(page)
  await expect(page.frames()[1]!.locator('#result')).toContainText('"ok":false')
  await expect(page.frames()[1]!.locator('#result')).toContainText('Permission denied')
  await expect(page.locator('iframe')).toHaveCount(1)
})

test("closing the source or switching account cancels a pending chooser", async ({ page }) => {
  await setup(page)
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(() => (window as any).account.setAccount("b".repeat(64), "local"))
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.evaluate(() => (window as any).account.setAccount(null, null))
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(() => (window as any).source.destroy())
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
})
