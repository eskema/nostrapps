import { test, expect, type Page } from "@playwright/test"
import { finalizeEvent, generateSecretKey } from "@nostr/tools/pure"

const secret = generateSecretKey()
const napplet = finalizeEvent(
  {
    kind: 35129,
    created_at: 1,
    content: "Profile napplet",
    tags: [
      ["d", "profiles"],
      ["title", "Profile Napplet"],
      ["x", "1".repeat(64)],
      ["R", "intent"],
      ["z", "profile"],
      ["i", "napplet:profile/open", "pubkey"]
    ]
  },
  secret
)
const profileEvent = finalizeEvent({ kind: 0, created_at: 1, content: "{}", tags: [] }, secret)

async function setup(page: Page, main = false) {
  await page.goto(main ? "/" : "/harness/napplet.html")
  await page.evaluate(
    async ({ napplet, main }) => {
      const manager = await import("/src/intents/manager.ts")
      const handlers = await import("/src/handlers.ts")
      const persistence = await import("/src/persistence.ts")
      const account = await import("/src/account.ts")
      const pool = main
        ? (
            await import(
              performance
                .getEntriesByType("resource")
                .find(entry => entry.name.includes("/@nostr_gadgets_global.js"))!.name
            )
          ).pool
        : (window as any).relayPool
      ;(window as any).relayPool = pool
      account.setAccount(null, null)
      pool.subscribeMap = (_requests: unknown, params: any) => {
        queueMicrotask(() => params.oneose?.())
        return { close() {} }
      }
      persistence.storeInstalledEvent(napplet)
      manager.observeIntentManifest(napplet)
      const nappId = "dev~profile-reader"
      persistence.storeInstalledLocalApp({
        nappId,
        title: "Profile Napp",
        actions: ["profile", "view"]
      })
      handlers.addApp(nappId, ["profile", "view"])
      const w = window as any
      Object.assign(w, {
        manager,
        handlers,
        persistence,
        account,
        nappId,
        deliveries: [],
        actions: []
      })
      if (!main) {
        manager.configureIntents({
          loadEvent: async () => null,
          deliver: async (_event: any, request: any) => {
            w.deliveries.push(request)
            return true
          },
          action: async (name: string, payload: unknown, target: unknown) => {
            w.actions.push({ name, payload, target })
            return { originalResult: "from-napp" }
          }
        })
      } else {
        const host = await import("/src/sandbox/host.ts")
        // An in-process window lets the actual action dispatcher exercise delivery and results.
        const win = host.launchSystem(
          document.querySelector("#stage")!,
          "test-reader",
          {
            id: "test-reader",
            title: "Profile Napp",
            mount: () => ({
              action: (name: string, payload: unknown) => {
                w.actions.push({ name, payload })
                return { originalResult: "from-napp" }
              }
            })
          },
          {} as any
        )
        persistence.updateOpen(win.getState().instanceId, { ...win.getState(), nappId })
      }
    },
    { napplet, main }
  )
}

test("napplet intents show napplets first and deliver a selected NAPP directly", async ({
  page
}) => {
  await setup(page)
  await page.evaluate(pubkey => {
    const w = window as any
    void w.manager
      .invokeIntent(
        {
          archetype: "profile",
          action: "open",
          convention: "napplet:profile/open",
          payload: { pubkey }
        },
        {
          sender: "test-napplet",
          check() {}
        }
      )
      .then((result: any) => (w.result = result))
  }, napplet.pubkey)
  await expect(page.locator(".intent-handler-section > h4")).toHaveText(["Napplets", "Napps"])
  await expect(page.getByRole("button", { name: "Open in another app" })).toHaveCount(0)
  await page.getByRole("button", { name: "Profile Napp", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).result?.ok)).toBe(true)
  expect(await page.evaluate(() => (window as any).actions)).toEqual([
    { name: "profile", payload: napplet.pubkey, target: { nappId: "dev~profile-reader" } }
  ])
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("a compatible intent still uses its napplet preference before a remembered NAPP route", async ({
  page
}) => {
  await setup(page)
  const pref = finalizeEvent(
    {
      kind: 31129,
      created_at: 2,
      content: "",
      tags: [
        ["d", "profile"],
        ["a", `35129:${napplet.pubkey}:profiles`]
      ]
    },
    secret
  )
  await page.evaluate(
    async ({ pref, napplet }) => {
      const w = window as any
      w.account.setAccount(pref.pubkey, "local")
      localStorage.setItem(
        `nostrapps:intent-routes:${pref.pubkey}`,
        JSON.stringify({ "napplet:profile/open": "napp" })
      )
      localStorage.setItem(
        `nostrapps:intent-routes:${pref.pubkey}:targets`,
        JSON.stringify({ "napplet:profile/open": { nappId: w.nappId } })
      )
      const pool = w.relayPool
      pool.subscribeMap = (requests: any[], params: any) => {
        const filter = requests[0].filter
        queueMicrotask(() => {
          if (filter.kinds?.includes(31129)) params.onevent?.(pref)
          if (filter.authors?.includes(napplet.pubkey) && filter.kinds?.includes(35129))
            params.onevent?.(napplet)
          params.oneose?.()
        })
        return { close() {} }
      }
      w.result = await w.manager.invokeIntent(
        {
          archetype: "profile",
          action: "open",
          convention: "napplet:profile/open",
          payload: { pubkey: napplet.pubkey }
        },
        {
          sender: "test-napplet",
          check() {}
        }
      )
    },
    { pref, napplet }
  )
  expect(await page.evaluate(() => (window as any).result.ok)).toBe(true)
  expect(await page.evaluate(() => (window as any).deliveries.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).actions.length)).toBe(0)
})

test("NAPP actions show NAPPs first and preserve their original action, payload, and result", async ({
  page
}) => {
  await setup(page, true)
  await page.evaluate(event => {
    const w = window as any
    // A saved intent route must not route or reshape this NAPP action.
    localStorage.setItem(
      "nostrapps:intent-routes:guest",
      JSON.stringify({ "napplet:profile/open": "napplet" })
    )
    void w.handlers
      .dispatchAction("launcher", "view:0", event)
      .then((result: any) => (w.result = result))
  }, profileEvent)
  await expect(page.locator(".intent-handler-section > h4")).toHaveText(["Napps", "Napplets"])
  await expect(page.getByRole("button", { name: "Profile Napplet", exact: true })).toBeVisible()
  await expect(page.getByText("Remember this choice", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Profile Napp", exact: true }).first().click()
  await expect
    .poll(() => page.evaluate(() => (window as any).result))
    .toEqual({ originalResult: "from-napp" })
  expect(await page.evaluate(() => (window as any).actions)).toEqual([
    { name: "view:0", payload: JSON.parse(JSON.stringify(profileEvent)) }
  ])
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("custom and incompatible NAPP actions are not converted to napplet intents", async ({
  page
}) => {
  await setup(page)
  expect(
    await page.evaluate(() => {
      const w = window as any
      return [
        w.manager.intentForNappAction("custom-action", { anything: true }),
        w.manager.intentForNappAction("profile", { legacy: true })
      ]
    })
  ).toEqual([undefined, undefined])
})

test("a NAPP action converts only after the user selects a compatible napplet and skips intent defaults", async ({
  page
}) => {
  await setup(page, true)
  const locked = finalizeEvent(
    {
      kind: 31129,
      created_at: 3,
      content: "private-preferences-not-unlocked-for-actions",
      tags: [["d", "profile"]]
    },
    secret
  )
  await page.evaluate(
    ({ locked, pubkey }) => {
      const w = window as any
      w.account.setAccount(locked.pubkey, "local")
      w.preferenceQueries = 0
      w.relayPool.subscribeMap = (requests: any[], params: any) => {
        queueMicrotask(() => {
          if (requests[0].filter.kinds?.includes(31129)) {
            w.preferenceQueries++
            params.onevent?.(locked)
          }
          params.oneose?.()
        })
        return { close() {} }
      }
      w.manager.configureIntents({
        loadEvent: async () => null,
        action: async () => {
          throw new Error("Should deliver to the selected napplet")
        },
        deliver: async (_event: unknown, request: unknown) => {
          w.deliveries.push(request)
          return true
        }
      })
      void w.handlers
        .dispatchAction("launcher", "profile", pubkey)
        .then((result: any) => (w.result = result))
    },
    { locked, pubkey: napplet.pubkey }
  )
  await expect(page.locator(".intent-handler-section > h4")).toHaveText(["Napps", "Napplets"])
  expect(await page.evaluate(() => (window as any).deliveries.length)).toBe(0)
  await page.getByRole("button", { name: "Profile Napplet", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).result?.ok)).toBe(true)
  const delivered = await page.evaluate(() => (window as any).deliveries)
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toMatchObject({
    convention: "napplet:profile/open",
    payload: { pubkey: napplet.pubkey }
  })
  expect(await page.evaluate(() => (window as any).preferenceQueries)).toBe(0)
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("an explicitly targeted NAPP action retains its legacy payload and result without a picker", async ({
  page
}) => {
  await setup(page, true)
  const payload = { legacy: "payload", extra: [1, 2, 3] }
  const result = await page.evaluate(async payload => {
    const w = window as any
    const win = w.persistence.readOpen().find((open: any) => open.nappId === w.nappId)
    return w.handlers.dispatchAction("launcher", "profile", payload, { instance: win.instanceId })
  }, payload)
  expect(result).toEqual({ originalResult: "from-napp" })
  expect(await page.evaluate(() => (window as any).actions)).toEqual([{ name: "profile", payload }])
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("malformed remembered routes cannot break intent selection", async ({ page }) => {
  await setup(page)
  await page.evaluate(pubkey => {
    const w = window as any
    localStorage.setItem("nostrapps:intent-routes:guest", "null")
    localStorage.setItem("nostrapps:intent-routes:guest:targets", '[{"nappId":"stale"}]')
    void w.manager
      .invokeIntent(
        {
          archetype: "profile",
          action: "open",
          convention: "napplet:profile/open",
          payload: { pubkey }
        },
        { sender: "test-napplet", check() {} }
      )
      .then((result: any) => (w.result = result))
  }, napplet.pubkey)
  await page.getByRole("button", { name: "Profile Napplet", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).result?.ok)).toBe(true)
  expect(await page.evaluate(() => (window as any).deliveries.length)).toBe(1)
})

test("a remembered NAPP choice remains successful when saving the route fails", async ({
  page
}) => {
  await setup(page)
  await page.evaluate(pubkey => {
    const w = window as any
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("nostrapps:intent-routes:"))
        throw new DOMException("Storage is full", "QuotaExceededError")
      return setItem.call(this, key, value)
    }
    void w.manager
      .invokeIntent(
        {
          archetype: "profile",
          action: "open",
          convention: "napplet:profile/open",
          payload: { pubkey }
        },
        { sender: "test-napplet", check() {} }
      )
      .then((result: any) => (w.result = result))
  }, napplet.pubkey)
  await page.getByRole("checkbox", { name: "Remember this choice", exact: true }).check()
  await page.getByRole("button", { name: "Profile Napp", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).result?.ok)).toBe(true)
  await expect(
    page.getByText("Opened; preference could not be saved", { exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => (window as any).actions.length)).toBe(1)
  await page.getByRole("button", { name: "OK", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("submitting a multiword launcher search opens the matching app", async ({ page }) => {
  await setup(page, true)
  const input = page.locator("#nsite-input")
  await input.fill("Profile Na")
  await expect(page.locator("#suggestions")).toContainText("Profile Napp")
  // Submit the form directly: an active suggestion's key handler would bypass
  // the search submission path being exercised here.
  await input.evaluate(el => (el.closest("form") as HTMLFormElement).requestSubmit())
  await expect(input).toHaveValue("")
  await expect(
    page.locator(".napp-window").filter({ hasText: "Profile Napp" }).first()
  ).toBeVisible()
})
