import { test, expect, type Page } from "@playwright/test"

const id = "napplet~runtime-publisher~counter"
const alice = "a".repeat(64)
const bob = "b".repeat(64)

async function launch(
  page: Page,
  html: string,
  domains = ["resource", "storage", "theme", "relay"]
) {
  await page.goto("/harness/napplet.html")
  await page.evaluate(
    async ({ id, html, domains, alice }) => {
      const persistence = await import("/src/persistence.ts")
      const account = await import("/src/account.ts")
      const host = await import("/src/sandbox/host.ts")
      const permissions = await import("/src/permissions.ts")
      account.setAccount(alice, "local")
      persistence.storeInstalledLocalApp({ nappId: id, title: "Counter", requires: domains, html })
      persistence.setPolicy(id, { domains, ask: ["relay"] })
      const win = host.launchNapplet(document.querySelector("#stage")!, id, html, {
        instanceId: "runtime-test"
      })
      Object.assign(window, { win, host, persistence, permissions, account })
    },
    { id, html, domains, alice }
  )
}

const resourceHtml = `<!doctype html><body><p id="result">starting</p><script>
window.fetchResource=async()=>{
  document.querySelector('#result').textContent='pending';
  try { const blob=await napplet.resource.bytes('https://resource.example/test'); document.querySelector('#result').textContent=await blob.text(); }
  catch(e) { document.querySelector('#result').textContent=e.message; }
}; fetchResource();
</script>`

test("a sandboxed napplet asks before fetching and revocation makes its next call ask again", async ({
  page
}) => {
  let requests = 0
  await page.route("https://resource.example/**", route => {
    requests++
    return route.fulfill({ body: "downloaded" })
  })
  await launch(page, resourceHtml)
  await expect(page.getByRole("dialog")).toBeVisible()
  expect(requests).toBe(0)
  await page.getByRole("button", { name: "Allow for this session", exact: true }).click()
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("downloaded")
  expect(requests).toBe(1)
  await page.evaluate(id => (window as any).permissions.forgetDecision(id, "resource.https"), id)
  // Execute inside the opaque frame through Playwright, just as a user action would.
  await page.frames()[1]!.evaluate(() => {
    void (window as any).fetchResource()
  })
  await expect(page.getByRole("dialog")).toBeVisible()
  expect(requests).toBe(1)
  await page.getByRole("button", { name: "Deny", exact: true }).click()
  await expect(page.frameLocator("iframe").locator("#result")).toContainText("Permission denied")
})

test("switching account during a resource approval returns denial and performs no fetch", async ({
  page
}) => {
  let requests = 0
  await page.route("https://resource.example/**", route => {
    requests++
    return route.fulfill({ body: "wrong account" })
  })
  await launch(page, resourceHtml)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(bob => (window as any).account.setAccount(bob, "local"), bob)
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.frameLocator("iframe").locator("#result")).not.toHaveText("pending")
  expect(requests).toBe(0)
})

test("closing a window cancels its pending approval even when another instance remains open", async ({
  page
}) => {
  await launch(page, resourceHtml)
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.evaluate(id => {
    const w = window as any
    w.host.launchNapplet(document.querySelector("#stage"), id, "<p>Second instance</p>", {
      instanceId: "second-test"
    })
    w.win.destroy()
  }, id)
  await expect(page.getByRole("dialog")).not.toBeVisible()
  await expect(page.locator("iframe")).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).permissions.listDecisions())).toEqual({})
})

test("permission edits rebuild srcdoc with the new available domains", async ({ page }) => {
  await launch(
    page,
    "<p id='result'></p><script>document.querySelector('#result').textContent=Object.keys(napplet).sort().join(',')</script>"
  )
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText(
    "relay,resource,storage,theme"
  )
  await page.evaluate(async id => {
    const w = window as any
    w.persistence.setPolicy(id, { domains: ["theme"] })
    await w.host.applyNappPolicy("", id)
  }, id)
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("theme")
  expect(await page.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts")
  expect(
    await page
      .frames()[1]!
      .evaluate(() => ({ signer: typeof (window as any).nostr, origin: location.origin }))
  ).toEqual({ signer: "undefined", origin: "null" })
})

test("closing a subscription while consent is pending cancels the prompt", async ({ page }) => {
  await launch(
    page,
    `<p id="result"></p><script>
    window.sub=napplet.relay.subscribe('pending',[{kinds:[1]}],{onClosed:()=>document.querySelector('#result').textContent='closed'},'wss://relay.example');
  </script>`
  )
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.frames()[1]!.evaluate(() => (window as any).sub.close())
  await expect(page.getByRole("dialog")).not.toBeVisible()
  expect(await page.evaluate(() => (window as any).permissions.listDecisions())).toEqual({})
})

test("the reload control restarts a srcdoc napplet", async ({ page }) => {
  await launch(
    page,
    `<p id="result">ready</p><script>napplet.storage.getItem('launches').then(async value=>{const n=Number(value||0)+1;await napplet.storage.setItem('launches',String(n));document.querySelector('#result').textContent=String(n)})</script>`
  )
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("1")
  await page.getByTitle("Reload", { exact: true }).click()
  await expect(page.frameLocator("iframe").locator("#result")).toHaveText("2")
})

test("an account switch while the signer is working prevents publication", async ({ page }) => {
  await launch(
    page,
    `<p id="result">ready</p><script>
    window.publish=async()=>{try{await napplet.relay.publish({kind:1,content:'test',tags:[]});document.querySelector('#result').textContent='published'}catch(e){document.querySelector('#result').textContent=e.message}};
  </script>`
  )
  await page.evaluate(alice => {
    const w = window as any
    w.signed = 0
    w.nostr = {
      getPublicKey: async () => alice,
      signEvent: () => {
        w.signed++
        return new Promise(resolve => (w.finishSigning = resolve))
      }
    }
    w.account.setAccount(alice, "nip07")
  }, alice)
  await page.frames()[1]!.evaluate(() => {
    void (window as any).publish()
  })
  await page.getByRole("button", { name: "Allow", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).signed)).toBe(1)
  await page.evaluate(
    ({ bob, alice }) => {
      const w = window as any
      w.account.setAccount(bob, "nip07")
      w.finishSigning({ pubkey: alice })
    },
    { bob, alice }
  )
  await expect(page.frameLocator("iframe").locator("#result")).not.toHaveText("ready")
  await expect(page.frameLocator("iframe").locator("#result")).not.toHaveText("published")
})

test("a signer using an unexpected account cannot publish an event", async ({ page }) => {
  await launch(
    page,
    `<p id="result">ready</p><script>
    window.publish=async()=>{try{await napplet.relay.publish({kind:1,content:'test',tags:[]});document.querySelector('#result').textContent='published'}catch(e){document.querySelector('#result').textContent=e.message}};
  </script>`
  )
  await page.evaluate(
    ({ alice, bob }) => {
      const w = window as any
      w.nostr = { getPublicKey: async () => alice, signEvent: async () => ({ pubkey: bob }) }
      w.account.setAccount(alice, "nip07")
    },
    { alice, bob }
  )
  await page.frames()[1]!.evaluate(() => {
    void (window as any).publish()
  })
  await page.getByRole("button", { name: "Allow", exact: true }).click()
  await expect(page.frameLocator("iframe").locator("#result")).toContainText("different account")
})

test("revocation closes a one-shot relay query already in progress", async ({ page }) => {
  await launch(
    page,
    `<p id="result">ready</p><script>
    window.query=async()=>{document.querySelector('#result').textContent='pending';try{await napplet.relay.query([{kinds:[1]}]);document.querySelector('#result').textContent='complete'}catch(e){document.querySelector('#result').textContent=e.message}};
  </script>`
  )
  await page.evaluate(async () => {
    const w = window as any
    w.account.clearPubkey()
    const pool = w.relayPool
    w.queryStarted = 0
    w.queryClosed = 0
    pool.subscribeMap = () => {
      w.queryStarted++
      return {
        close: () => {
          w.queryClosed++
        }
      }
    }
  })
  await page.frames()[1]!.evaluate(() => {
    void (window as any).query()
  })
  await page.getByRole("button", { name: "Allow for this session", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).queryStarted)).toBe(1)
  await page.evaluate(id => (window as any).permissions.forgetDecision(id, "relay.read"), id)
  await expect.poll(() => page.evaluate(() => (window as any).queryClosed)).toBe(1)
  await expect(page.frameLocator("iframe").locator("#result")).not.toHaveText("pending")
})
