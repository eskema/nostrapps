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

test("settings edits synced default and private intent override chains", async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const w = window as any
    const { loginLocalKey } = await import("/src/signers/local.ts")
    w.account.setAccount(loginLocalKey("1".repeat(64)), "local")
    w.published = []
    w.relayPool.publish = (_relays: string[], event: any) => {
      w.published.push(event)
      return [Promise.resolve("accepted")]
    }
    w.relayPool.subscribeMap = (requests: any[], params: any) => {
      queueMicrotask(() => {
        if (requests[0].filter.kinds?.includes(31129))
          w.published.forEach((event: any) => params.onevent?.(event))
        params.oneose?.()
      })
      return { close() {} }
    }
    const reference = [...w.manager.intentCatalog().keys()][0]
    await w.manager.editIntentPreference("note", { action: "add", reference })
    await w.manager.editIntentPreference("note", {
      action: "add", reference, identity: "napplet:note/open", hidden: true
    })
    // Reload the saved state so private handlers begin locked, as on a fresh session.
    const pk = w.account.getPubkey()
    w.account.setAccount(null, null)
    w.account.setAccount(pk, "local")
    const { intentSettings } = await import("/src/system-napps/intent-settings.ts")
    w.settings = intentSettings()
    document.body.append(w.settings.section)
    w.settings.section.open = true
  })
  await expect(page.getByRole("button", { name: "Refresh handlers" })).toBeEnabled()
  await page.locator(".intent-archetype > summary").filter({ hasText: /^note$/ }).click()
  const defaults = page.getByRole("region", { name: "note default handlers", exact: true })
  await expect(defaults.getByText("Intent Reader", { exact: true })).toBeVisible()
  await expect(defaults.getByRole("button", { name: "Prefer", exact: true })).toBeDisabled()
  await expect(page.getByRole("combobox", { name: "Add preference", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Unlock private preferences", exact: true }).click()
  const override = page.getByRole("region", {
    name: "note napplet:note/open handlers",
    exact: true
  })
  await expect(override.getByRole("button", { name: "Make public", exact: true })).toBeEnabled()
  const events = await page.evaluate(() => (window as any).published)
  expect(events).toHaveLength(2)
  expect(events[1].kind).toBe(31129)
  expect(events[1].tags).toEqual([
    ["d", "note"],
    ["a", `35129:${manifest.pubkey}:intent-reader`]
  ])
  expect(events[1].content.length).toBeGreaterThan(0)
  await override.getByRole("button", { name: "Reset override" }).click()
  await expect(override).toHaveCount(0)
  await expect(defaults).toBeVisible()
  await page.getByRole("searchbox", { name: "Filter intents" }).fill("missing")
  await expect(page.getByText("No matching intents.")).toBeVisible()
  await page.getByRole("searchbox", { name: "Filter intents" }).fill("")
  await defaults.getByRole("button", { name: "Remove handler", exact: true }).click()
  await expect(page.locator(".intent-archetype")).toHaveCount(0)
  await expect(page.getByText("No saved intent handlers.", { exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).account.setAccount(null, null))
  await expect(page.getByText("Connect an account to sync handler preferences.")).toBeVisible()
  await expect(page.getByText("Intent Reader", { exact: true })).toHaveCount(0)
})

test("intent picker shows clickable app rows with icons and authors without technical data", async ({
  page
}) => {
  await setup(page)
  await invoke(page)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Choose an app to open note.")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Intent Reader", exact: true })).toBeVisible()
  const row = dialog.getByRole("button", { name: "Intent Reader", exact: true })
  await expect(row.locator(".ui-app-icon")).toBeVisible()
  await expect(row.locator(".intent-handler-title")).toHaveText("Intent Reader")
  await expect(row.locator(".intent-handler-author .ui-author")).toBeVisible()
  await expect(dialog.locator("code, details")).toHaveCount(0)
  await expect(dialog).not.toContainText(`35129:${manifest.pubkey}:intent-reader`)
  await expect(dialog.getByText("Keep handler preference private", { exact: true })).toBeHidden()
  const titleBox = await row.locator(".intent-handler-title").boundingBox()
  const authorBox = await row.locator(".intent-handler-author").boundingBox()
  const iconBox = await row.locator(".ui-app-icon").boundingBox()
  expect(authorBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height)
  expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(titleBox!.x)
  await row.locator(".intent-handler-author").click()
  await expect(page.locator("iframe")).toHaveCount(2)
})

test("slow discovery gives immediate feedback and can be cancelled without a later picker", async ({
  page
}) => {
  await setup(page)
  await page.evaluate(() => {
    ;(window as any).relayPool.subscribeMap = (_requests: unknown, params: any) => {
      const timer = setTimeout(() => params.oneose?.(), 1500)
      return {
        close() {
          clearTimeout(timer)
        }
      }
    }
  })
  await invoke(page)
  await expect(page.getByText("Finding apps for your request…")).toBeVisible({ timeout: 700 })
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.frames()[1]!.locator("#result")).toContainText('"ok":false')
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.locator("iframe")).toHaveCount(1)
})

test("loads the logged-in user's newest verified preferences from write relays and caches them", async ({
  page
}) => {
  await setup(page)
  const secret = generateSecretKey()
  const sign = (created_at: number, tags: string[][]) =>
    finalizeEvent({ kind: 31129, created_at, tags, content: "" }, secret)
  const older = sign(10, [
    ["d", "note"],
    ["e", "1".repeat(64)]
  ])
  const newest = sign(20, [
    ["d", "note"],
    ["e", "2".repeat(64)]
  ])
  const other = finalizeEvent(
    { kind: 31129, created_at: 30, tags: [["d", "note"]], content: "" },
    generateSecretKey()
  )
  const malformed = sign(40, [
    ["d", "note"],
    ["d", "article"]
  ])
  const forged = { ...newest, created_at: 50 }
  const relayList = finalizeEvent(
    {
      kind: 10002,
      created_at: 1,
      content: "",
      tags: [
        ["r", "wss://read.example", "read"],
        ["r", "wss://write.example", "write"]
      ]
    },
    secret
  )
  const result = await page.evaluate(
    async ({ secret, relayList, batch }) => {
      const w = window as any
      const { loginLocalKey } = await import("/src/signers/local.ts")
      const { getStore, safeQueryEvents } = await import("/src/store.ts")
      await getStore().saveEvent(relayList)
      w.account.setAccount(loginLocalKey(secret), "local")
      const requestsSeen: any[] = []
      w.relayPool.subscribeMap = (requests: any[], params: any) => {
        requestsSeen.push(...requests)
        queueMicrotask(() => {
          if (requests.some(r => r.url === "wss://write.example/"))
            batch.forEach((e: any) => params.onevent?.(e))
          params.oneose?.()
        })
        return { close() {} }
      }
      await w.manager.refreshIntentPreferences()
      const loaded = w.manager.intentPreferences().get("note")?.event.id
      const cached = await safeQueryEvents({ kinds: [31129], authors: [relayList.pubkey] })
      return { loaded, cached: cached.map(e => e.id), requestsSeen }
    },
    {
      secret: Buffer.from(secret).toString("hex"),
      relayList,
      batch: [newest, older, other, malformed, forged]
    }
  )
  expect(result.loaded).toBe(newest.id)
  expect(result.cached).toContain(newest.id)
  const requests = result.requestsSeen.filter(r => r.filter.kinds?.includes(31129))
  expect(requests.map(r => r.url)).toContain("wss://write.example/")
  expect(
    requests.every(r => JSON.stringify(r.filter.authors) === JSON.stringify([newest.pubkey]))
  ).toBe(true)
})

test("late preference responses from a previous account cannot populate the current account", async ({
  page
}) => {
  await setup(page)
  const preference = finalizeEvent(
    {
      kind: 31129,
      created_at: 1,
      tags: [
        ["d", "note"],
        ["e", "1".repeat(64)]
      ],
      content: ""
    },
    generateSecretKey()
  )
  await page.evaluate(async preference => {
    const w = window as any
    w.account.setAccount(preference.pubkey, "nip07")
    w.relayPool.subscribeMap = (requests: any[], params: any) => {
      if (requests[0].filter.kinds?.includes(31129)) {
        w.finishPreferences = () => {
          params.onevent?.(preference)
          params.oneose?.()
        }
      } else queueMicrotask(() => params.oneose?.())
      return { close() {} }
    }
    w.pendingPreferences = w.manager.refreshIntentPreferences()
  }, preference)
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishPreferences))
    .toBe("function")
  const loaded = await page.evaluate(async () => {
    const w = window as any
    w.account.setAccount("a".repeat(64), "nip07")
    w.finishPreferences()
    await w.pendingPreferences
    return [...w.manager.intentPreferences().keys()]
  })
  expect(loaded).toEqual([])
})

test("intent manager can initialize before the sandbox host", async ({ page }) => {
  await page.goto("/harness/napplet.html")
  const result = await page.evaluate(async () => {
    const manager = await import("/src/intents/manager.ts")
    const stop = manager.subscribeIntents(() => {})
    stop()
    const host = await import("/src/sandbox/host.ts")
    return typeof host.launchNapplet
  })
  expect(result).toBe("function")
})
