import { test, expect, type Page } from "@playwright/test"
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure"
import { createHash } from "node:crypto"

const targetHtml = `<p id="delivery">waiting</p><script>window.deliveries=[];window.listen=()=>napplet.intent.onDelivery(d=>{deliveries.push(d);document.querySelector('#delivery').textContent=JSON.stringify(deliveries)});setTimeout(listen,80)</script>`
const manifest = finalizeEvent(
  {
    kind: 35129,
    created_at: 1,
    content: "Intent reader",
    tags: [
      ["d", "intent-reader"],
      ["title", "Intent Reader"],
      ["x", createHash("sha256").update(targetHtml).digest("hex")],
      ["R", "intent"],
      ["z", "note"],
      ["i", "napplet:note/open", "id"]
    ]
  },
  generateSecretKey()
)
const sourceId = "napplet~local~intent-source"
const sourceHtml = `<p id="result">ready</p><a id="link" href="napplet:note/open?id=from-link">Open note</a><script>window.invoke=async(options)=>{try{const r=await napplet.intent.invoke('napplet:note/open',options);document.querySelector('#result').textContent=JSON.stringify(r);return r}catch(e){document.querySelector('#result').textContent=e.message}}</script>`
async function setup(page: Page, granted = true) {
  await page.goto("/harness/napplet.html")
  await page.evaluate(
    async ({ manifest, targetHtml, sourceHtml, sourceId, granted }) => {
      const host = await import("/src/sandbox/host.ts")
      const manager = await import("/src/intents/manager.ts")
      const persistence = await import("/src/persistence.ts")
      const { cacheArtifact } = await import("/src/nsite/artifact-cache.ts")
      const { loadNappletFromManifest } = await import("/src/nsite/napplet.ts")
      const account = await import("/src/account.ts")
      account.setAccount(null, null)
      ;(window as any).relayPool.subscribeMap = (_requests: unknown, params: any) => {
        queueMicrotask(() => params.oneose?.())
        return { close() {} }
      }
      persistence.storeInstalledEvent(manifest)
      const targetId = persistence.computeNappId(manifest)
      persistence.setPolicy(targetId, { domains: ["intent"] })
      persistence.storeInstalledLocalApp({
        nappId: sourceId,
        html: sourceHtml,
        requires: ["intent"]
      })
      persistence.setPolicy(sourceId, { domains: granted ? ["intent"] : [] })
      cacheArtifact(manifest.tags.find(t => t[0] === "x")![1], new Blob([targetHtml]))
      manager.configureIntents({
        action: async () => ({ ok: true }),
        loadEvent: async () => null,
        async deliver(event, request, delivery, context) {
          context.check()
          const resolved = await loadNappletFromManifest(event, undefined, {
            signal: context.signal
          })
          context.check()
          let win = request.behavior?.reuse === false ? null : host.findOpenWindowByNappId(targetId)
          win ??= host.launchNapplet(document.querySelector("#stage")!, targetId, resolved.html)
          return host.deliverNappletIntent(win, delivery, context.check, context.signal)
        }
      })
      const source = host.launchNapplet(document.querySelector("#stage")!, sourceId, sourceHtml, {
        instanceId: "intent-source"
      })
      Object.assign(window, { host, manager, persistence, account, source, targetId })
    },
    { manifest, targetHtml, sourceHtml, sourceId, granted }
  )
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("ready")
}
async function invoke(page: Page, options = { payload: { id: "note-1" } }) {
  await page
    .frames()
    .find(f => f !== page.mainFrame())!
    .evaluate(options => {
      void (window as any).invoke(options)
    }, options)
}

test("selects, verifies and delivers once with an attested sender, buffers for late listeners, and reuses the target", async ({
  page
}) => {
  await setup(page)
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  const source = page.frames()[1]!
  await expect.poll(() => source.locator("#result").textContent()).toContain('"ok":true')
  const target = page.frames()[2]!
  await expect(target.locator("#delivery")).toContainText('"id":"note-1"')
  const deliveries = await target.evaluate(() => (window as any).deliveries)
  expect(deliveries).toEqual([
    {
      sender: `nostrapps:local:${sourceId}`,
      archetype: "note",
      action: "open",
      convention: "napplet:note/open",
      payload: { id: "note-1" }
    }
  ])
  await invoke(page)
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  await expect.poll(() => target.evaluate(() => (window as any).deliveries.length)).toBe(2)
  await expect(page.locator("iframe")).toHaveCount(2)
  expect(await target.evaluate(() => typeof (window as any).nostr)).toBe("undefined")
  await page.evaluate(() => {
    const w = window as any
    w.host.reloadNappletWindows(
      w.targetId,
      `<p id="after">reloaded</p><script>window.deliveries=[];napplet.intent.onDelivery(d=>deliveries.push(d))</script>`
    )
  })
  await expect(target.locator("#after")).toHaveText("reloaded")
  expect(await target.evaluate(() => (window as any).deliveries)).toEqual([])
})

test("napplet anchors open another napplet with URI query payloads", async ({ page }) => {
  await setup(page)
  await page.frames()[1]!.locator("#link").click()
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  await expect(page.locator("iframe")).toHaveCount(2)
  await expect(page.frames()[2]!.locator("#delivery")).toContainText('"id":"from-link"')
})

test("cancel, permission denial, forged sender and unknown explicit handler fail without launching a target", async ({
  page
}) => {
  await setup(page)
  await invoke(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.frames()[1]!.locator("#result")).toContainText('"ok":false')
  await page.frames()[1]!.evaluate(() => {
    void (window as any).invoke({ handler: "invented" })
  })
  await expect(page.frames()[1]!.locator("#result")).toContainText(
    "Unknown or incompatible handler"
  )
  await page.frames()[1]!.evaluate(() =>
    parent.postMessage(
      {
        type: "intent.invoke",
        id: "forged",
        request: {
          archetype: "note",
          action: "open",
          convention: "napplet:note/open",
          sender: "victim"
        }
      },
      "*"
    )
  )
  await expect(page.locator("iframe")).toHaveCount(1)
  await page.evaluate(
    sourceId => (window as any).persistence.setPolicy(sourceId, { domains: [] }),
    sourceId
  )
  await invoke(page)
  await expect(page.frames()[1]!.locator("#result")).toContainText('"ok":false')
  await expect(page.frames()[1]!.locator("#result")).toContainText("Permission denied")
  await expect(page.locator("iframe")).toHaveCount(1)
})

test("closing the source or switching account cancels a pending chooser", async ({ page }) => {
  await setup(page)
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(() => (window as any).account.setAccount("b".repeat(64), "local"))
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(1)
  await page.evaluate(() => (window as any).account.setAccount(null, null))
  await invoke(page)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(() => (window as any).source.destroy())
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(0)
})

test("public and private handler preferences publish, fall back in order, and keep private references out of discovery", async ({
  page
}) => {
  await setup(page)
  const secret = generateSecretKey()
  const { getPublicKey } = await import("@nostr/tools/pure")
  const pk = getPublicKey(secret)
  const privateManifest = finalizeEvent(
    {
      kind: 35129,
      created_at: 2,
      content: "Private reader",
      tags: [
        ["d", "private-reader"],
        ["title", "Private Reader"],
        ["x", createHash("sha256").update(targetHtml).digest("hex")],
        ["R", "intent"],
        ["z", "note"],
        ["i", "napplet:note/open"]
      ]
    },
    generateSecretKey()
  )
  const reference = `35129:${privateManifest.pubkey}:private-reader`
  await page.evaluate(
    async ({ secret, pk, privateManifest }) => {
      const w = window as any
      const { loginLocalKey } = await import("/src/signers/local.ts")
      loginLocalKey(secret)
      w.account.setAccount(pk, "local")
      w.published = []
      w.relayPool.publish = (_relays: string[], event: any) => {
        w.published.push(event)
        return [Promise.resolve("accepted")]
      }
      w.relayPool.subscribeMap = (requests: any[], params: any) => {
        const filter = requests[0].filter
        const events = filter.authors?.includes(privateManifest.pubkey)
          ? [privateManifest]
          : filter.kinds?.includes(31129)
            ? w.published
            : []
        queueMicrotask(() => {
          events.forEach((event: any) => params.onevent?.(event))
          params.oneose?.()
        })
        return { close() {} }
      }
    },
    { secret: Buffer.from(secret).toString("hex"), pk, privateManifest }
  )
  await page.evaluate(async reference => {
    const w = window as any
    await w.manager.editIntentPreference("note", { action: "add", reference: "0".repeat(64) })
    await w.manager.editIntentPreference("note", {
      action: "prefer",
      identity: "napplet:note/open",
      reference,
      hidden: true
    })
  }, reference)
  const published = await page.evaluate(() => (window as any).published)
  expect(published).toHaveLength(2)
  expect(published[1].tags).toEqual([
    ["d", "note"],
    ["e", "0".repeat(64)]
  ])
  expect(published[1].content).not.toContain(reference)
  expect(published[1].content.length).toBeGreaterThan(0)
  // Reload private preferences from their signed, encrypted event and invoke.
  await page.evaluate(async () => {
    const w = window as any
    w.account.setAccount(null, null)
    w.account.setAccount(w.published[1].pubkey, "local")
    await w.manager.refreshIntentPreferences()
    const routesKey = `nostrapps:intent-routes:${w.published[1].pubkey}`
    localStorage.setItem(routesKey, JSON.stringify({ "napplet:note/open": "napplet" }))
  })
  await invoke(page)
  await expect(page.locator("iframe")).toHaveCount(2)
  await expect(page.frames()[1]!.locator("#result")).toContainText('"ok":true')
  await expect(page.frames()[2]!.locator("#delivery")).toContainText('"id":"note-1"')
  const availability = await page.evaluate(() => (window as any).manager.intentAvailability())
  expect(JSON.stringify(availability)).not.toContain("Private Reader")
  expect(JSON.stringify(availability)).not.toContain(reference)
  await expect(page.getByRole("dialog")).not.toBeVisible()
})

test("catalog changes withdraw incompatible revisions and explicit handlers do not bypass exact convention matching", async ({
  page
}) => {
  await setup(page)
  const secret = generateSecretKey()
  const original = finalizeEvent(
    {
      kind: 35129,
      created_at: 10,
      content: "Changing handler",
      tags: [
        ["d", "changing"],
        ["x", "1".repeat(64)],
        ["R", "intent"],
        ["z", "article"],
        ["i", "napplet:article/open"]
      ]
    },
    secret
  )
  const withdrawn = finalizeEvent(
    {
      kind: 35129,
      created_at: 11,
      content: "Withdrawn handler",
      tags: [
        ["d", "changing"],
        ["x", "1".repeat(64)]
      ]
    },
    secret
  )
  const results = await page.evaluate(
    async ({ original, withdrawn }) => {
      const manager = (window as any).manager
      manager.observeIntentManifest(original)
      const before = manager.intentAvailability()
      manager.observeIntentManifest(withdrawn)
      manager.observeIntentManifest(original)
      const after = manager.intentAvailability()
      const candidate = before.find((a: any) => a.archetype === "article").candidates[0]
      const result = await manager.invokeIntent(
        {
          archetype: "note",
          action: "open",
          convention: "napplet:note/open",
          handler: candidate.id
        },
        { sender: "test", check() {} }
      )
      return { before, after, result }
    },
    { original, withdrawn }
  )
  expect(results.before.some((a: any) => a.archetype === "article")).toBe(true)
  expect(results.after.some((a: any) => a.archetype === "article")).toBe(false)
  expect(results.result.ok).toBe(false)
  await expect(page.locator("iframe")).toHaveCount(1)
})

test("a manifest withdrawn during target startup cannot receive the payload", async ({ page }) => {
  await setup(page)
  const secret = generateSecretKey()
  const tags = [
    ["d", "race"],
    ["x", "2".repeat(64)],
    ["R", "intent"],
    ["z", "note"],
    ["i", "napplet:note/open"]
  ]
  const original = finalizeEvent(
    { kind: 35129, created_at: 1, content: "Race target", tags },
    secret
  )
  const withdrawn = finalizeEvent(
    { kind: 35129, created_at: 2, content: "Withdrawn", tags: tags.filter(t => t[0] !== "i") },
    secret
  )
  await page.evaluate(
    ({ original }) => {
      const w = window as any
      w.manager.observeIntentManifest(original)
      const candidate = w.manager
        .intentAvailability()
        .find((a: any) => a.archetype === "note")
        .candidates.find((c: any) => c.title === "Napplet")
      w.attempts = 0
      w.manager.configureIntents({
        action: async () => {},
        loadEvent: async () => null,
        async deliver(_event: any, _request: any, _delivery: any, context: any) {
          w.started = true
          await new Promise(resolve => {
            w.finish = resolve
          })
          context.check()
          w.attempts++
          return true
        }
      })
      w.result = w.manager.invokeIntent(
        {
          archetype: "note",
          action: "open",
          convention: "napplet:note/open",
          handler: candidate.id,
          payload: { secret: "payload" }
        },
        { sender: "test", check() {} }
      )
    },
    { original }
  )
  await expect.poll(() => page.evaluate(() => (window as any).started)).toBe(true)
  const result = await page.evaluate(async withdrawn => {
    const w = window as any
    w.manager.observeIntentManifest(withdrawn)
    w.finish()
    return { result: await w.result, attempts: w.attempts }
  }, withdrawn)
  expect(result.result.ok).toBe(false)
  expect(result.attempts).toBe(0)
})

test("incomplete preference synchronization cannot overwrite handler settings", async ({
  page
}) => {
  await setup(page)
  const result = await page.evaluate(async () => {
    const w = window as any
    const { loginLocalKey } = await import("/src/signers/local.ts")
    const pk = loginLocalKey("1".repeat(64))
    w.account.setAccount(pk, "local")
    w.relayPool.subscribeMap = (_requests: unknown, params: any) => {
      queueMicrotask(() => params.onclose?.([]))
      return { close() {} }
    }
    let error = ""
    try {
      await w.manager.editIntentPreference("note", { action: "add", reference: "0".repeat(64) })
    } catch (e) {
      error = (e as Error).message
    }
    return error
  })
  expect(result).toContain("could not be synced")
})

test("sender identity remains bound to the running document when its installed record changes", async ({
  page
}) => {
  await setup(page)
  const secret = generateSecretKey()
  const tags = [
    ["x", createHash("sha256").update(sourceHtml).digest("hex")],
    ["R", "intent"]
  ]
  const original = finalizeEvent(
    { kind: 5129, created_at: 1, content: "Source snapshot", tags },
    secret
  )
  const replacement = finalizeEvent(
    { kind: 5129, created_at: 2, content: "Another snapshot", tags },
    secret
  )
  await page.evaluate(
    ({ original, replacement, sourceHtml }) => {
      const w = window as any
      w.source.destroy()
      w.persistence.storeInstalledEvent(original)
      const id = w.persistence.computeNappId(original)
      w.persistence.setPolicy(id, { domains: ["intent"] })
      w.source = w.host.launchNapplet(document.querySelector("#stage")!, id, sourceHtml)
      w.persistence.storeInstalledEvent(replacement)
    },
    { original, replacement, sourceHtml }
  )
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("ready")
  await invoke(page)
  await page.getByRole("button", { name: "Intent Reader", exact: true }).click()
  await expect(page.locator("iframe")).toHaveCount(2)
  await expect(page.frames()[2]!.locator("#delivery")).toContainText(original.id)
  expect((await page.frames()[2]!.evaluate(() => (window as any).deliveries))[0].sender).toBe(
    original.id
  )
})
