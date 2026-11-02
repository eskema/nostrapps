import { test, expect } from "@playwright/test"

const id = "napplet~test-publisher~counter"
const alice = "a".repeat(64)
const bob = "b".repeat(64)

test.beforeEach(async ({ page }) => {
  await page.goto("/harness/napplet.html")
  await page.evaluate(
    async ({ id, alice }) => {
      const permissions = await import("/src/permissions.ts")
      const persistence = await import("/src/persistence.ts")
      const account = await import("/src/account.ts")
      Object.assign(window, { permissions, persistence, account, results: [] })
      account.setAccount(alice, "local")
      persistence.setPolicy(id, {
        domains: ["resource", "relay", "outbox", "common", "link"],
        ask: ["resource", "relay", "outbox", "common", "link"]
      })
    },
    { id, alice }
  )
})

test("remembered approvals are account-scoped and do not grant other operations", async ({
  page
}) => {
  await page.evaluate(id => {
    void (window as any).permissions
      .requireApproval(id, "relay.publish")
      .then((v: boolean) => (window as any).results.push(v))
  }, id)
  await page.getByRole("button", { name: "Allow always", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).results)).toEqual([true])
  expect(
    await page.evaluate(
      id => ({
        own: (window as any).permissions.coveredByGrant(id, "relay.publish"),
        encrypted: (window as any).permissions.coveredByGrant(id, "relay.publishEncrypted"),
        reads: (window as any).permissions.coveredByGrant(id, "relay.read"),
        asks: (window as any).persistence.getPolicy(id).ask
      }),
      id
    )
  ).toMatchObject({
    own: true,
    encrypted: false,
    reads: false,
    asks: ["resource", "relay", "outbox", "common", "link"]
  })
  await page.evaluate(bob => (window as any).account.setAccount(bob, "local"), bob)
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "relay.publish"), id)
  ).toBe(false)
  expect(await page.evaluate(() => (window as any).permissions.listDecisions())).toEqual({})
  await page.evaluate(alice => (window as any).account.setAccount(alice, "local"), alice)
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "relay.publish"), id)
  ).toBe(true)
})

test("session approvals settle waiting reads and can be revoked without reloading", async ({
  page
}) => {
  await page.evaluate(id => {
    const w = window as any
    for (let i = 0; i < 3; i++)
      void w.permissions
        .requireApproval(id, "resource.https")
        .then((v: boolean) => w.results.push(v))
  }, id)
  await page.getByRole("button", { name: "Allow for this session", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).results)).toEqual([true, true, true])
  expect(await page.evaluate(id => (window as any).permissions.listDecisions()[id], id)).toEqual({
    "resource.https": "session"
  })
  expect(await page.evaluate(() => (window as any).permissions.listDecisions(false))).toEqual({})
  await page.evaluate(id => (window as any).permissions.forgetDecision(id, "resource.https"), id)
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "resource.https"), id)
  ).toBe(false)
  await page.reload()
  expect(
    await page.evaluate(async () => (await import("/src/permissions.ts")).listDecisions())
  ).toEqual({})
})

test("closing an app cancels the visible approval and every waiting request", async ({ page }) => {
  await page.evaluate(id => {
    const w = window as any
    for (let i = 0; i < 3; i++)
      void w.permissions
        .requireApproval(id, "resource.https")
        .then((v: boolean) => w.results.push(v))
  }, id)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(id => (window as any).permissions.cancelApprovals(id), id)
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as any).results))
    .toEqual([false, false, false])
  expect(await page.evaluate(() => (window as any).permissions.listDecisions())).toEqual({})
})

test("switching accounts cancels a pending remember request", async ({ page }) => {
  await page.evaluate(id => {
    void (window as any).permissions
      .requireApproval(id, "resource.https")
      .then((v: boolean) => (window as any).results.push(v))
  }, id)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(bob => (window as any).account.setAccount(bob, "local"), bob)
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).results)).toEqual([false])
  expect(await page.evaluate(() => (window as any).permissions.listDecisions())).toEqual({})
})

test("revoking a domain cancels its approval and remembered decisions cannot restore it", async ({
  page
}) => {
  await page.evaluate(id => {
    void (window as any).permissions
      .requireApproval(id, "resource.https")
      .then((v: boolean) => (window as any).results.push(v))
  }, id)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(id => (window as any).persistence.setPolicy(id, { domains: [] }), id)
  await expect.poll(() => page.evaluate(() => (window as any).results)).toEqual([false])
  await page.evaluate(
    id => (window as any).permissions.setDecision(id, "resource.https", "allow"),
    id
  )
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "resource.https"), id)
  ).toBe(false)
})

test("aborting a request removes it from the shared dialog queue", async ({ page }) => {
  await page.evaluate(async id => {
    const w = window as any
    const { openDialog } = await import("/src/dialog.ts")
    void openDialog({
      title: "Another request",
      dismissValue: false,
      actions: [{ label: "Done", value: true }]
    })
    w.controller = new AbortController()
    void w.permissions
      .requireApproval(id, "resource.https", undefined, { signal: w.controller.signal })
      .then((v: boolean) => w.results.push(v))
  }, id)
  await expect(page.locator(".app-dialog-queue-count")).toHaveText("1 waiting")
  await page.evaluate(() => (window as any).controller.abort())
  await expect(page.locator(".app-dialog-queue-count")).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).results)).toEqual([false])
  await expect(page.getByText("Another request", { exact: true })).toBeVisible()
})

test("legacy global napplet approvals are not reused for a new account", async ({ page }) => {
  await page.evaluate(
    id =>
      localStorage.setItem(
        "nostrapps:permissions",
        JSON.stringify({ [id]: { "resource.https": "allow" } })
      ),
    id
  )
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "resource.https"), id)
  ).toBe(false)
})

test("a checked permission allows publishing without another prompt", async ({ page }) => {
  await page.evaluate(id => (window as any).persistence.setPolicy(id, { domains: ["relay"] }), id)
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "relay.publish"), id)
  ).toBe(true)
})

test("forget all keeps another account's remembered decisions", async ({ page }) => {
  await page.evaluate(
    ({ id, bob, alice }) => {
      const w = window as any
      w.permissions.setDecision(id, "resource.https", "allow")
      w.account.setAccount(bob, "local")
      w.permissions.setDecision(id, "resource.https", "allow")
      w.permissions.forgetAllDecisions()
      w.account.setAccount(alice, "local")
    },
    { id, bob, alice }
  )
  expect(
    await page.evaluate(id => (window as any).permissions.coveredByGrant(id, "resource.https"), id)
  ).toBe(true)
})

test("napplet approval controls fit a narrow mobile window", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await page.evaluate(id => {
    void (window as any).permissions.requireApproval(id, "resource.https")
  }, id)
  for (const name of ["Deny", "Allow", "Allow for this session", "Deny always", "Allow always"]) {
    const button = page.getByRole("button", { name, exact: true })
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  await page.screenshot({ path: test.info().outputPath("napplet-permission-mobile.png") })
})
