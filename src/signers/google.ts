import { generateSecretKey, finalizeEvent } from "@nostr/tools/pure"
import { trustedKeyDeal, hexShard, hexPubShard } from "@fiatjaf/promenade-trusted-dealer"
import { argon2id } from "@noble/hashes/argon2.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { pool } from "@nostr/gadgets/global"
import { loadRelayList } from "@nostr/gadgets/lists"

// Hardcoded Pomegranate deployment we point this launcher at.
const CENTRAL_URL = "https://auth.njump.me"
const OPERATORS = [
  "https://po.njump.me",
  "https://po.nostrver.se",
  "https://po.f7z.io",
  "https://po.jumble.social",
  "https://po.coracle.social"
]

// Kind 16440 setup announcements map argon2id(email) -> central URL so
// clients can find where a Google identity already registered (spec step 5,
// mirrors hallway's google-login.service.ts).
const KIND_SETUP_ANNOUNCEMENT = 16440

// Big public relays for announcement lookup/publish — same set hallway uses
// as universe.bigRelayUrls.
const BIG_RELAYS = ["wss://relay.damus.io/", "wss://relay.primal.net/", "wss://nos.lol/"]

// Thrown when the 16440 lookup shows the user already registered at a
// different central. Extends Error so the launcher's `err.message` status
// path renders it, while callers can also `instanceof`-check `.central`.
export class WrongCentralError extends Error {
  readonly central: string
  constructor(actualCentral: string, ours: string) {
    super(
      `Account already set up at ${actualCentral} (this launcher uses ${ours}). Log in there instead.`
    )
    this.name = "WrongCentralError"
    this.central = actualCentral
  }
}

const utf8_encode = (s: string) => new TextEncoder().encode(s)

// Throw a descriptive error including any body text so failures from central
// or operators are debuggable in the launcher's status log.
async function assertOk(resp: Response, label: string) {
  if (resp.ok) return
  let body = ""
  try {
    body = (await resp.text()).slice(0, 200)
  } catch {}
  throw new Error(`${label} failed (${resp.status})${body ? `: ${body}` : ""}`)
}

// GET /account: returns the parsed account body when one exists for this
// Google identity, null on 404 (no account yet), and throws on any other
// error so the caller can surface it.
async function tryFetchAccount(central: string, token: string) {
  const resp = await fetch(`${central}/account`, {
    headers: { Authorization: "Token " + token }
  })
  if (resp.status === 404) return null
  await assertOk(resp, "central /account")
  return await resp.json()
}

// Poll GET /account until the operators confirm in the background and
// central marks the account operational (spec step 14). Without this the
// first POST /profiles can hit a half-provisioned account.
async function waitForAccount(
  central: string,
  token: string,
  log: (msg: string) => void,
  { tries = 15, delayMs = 2000 }: { tries?: number; delayMs?: number } = {}
) {
  for (let i = 0; i < tries; i++) {
    const account = await tryFetchAccount(central, token)
    if (account) return account
    log("Waiting for operators to confirm…")
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error("Account creation failed (operators never confirmed)")
}

// Token is base64-encoded JSON with a `tags` array; the operators want
// the email so the user can later log into the recovery popups.
function findTokenEmail(token: string): string {
  try {
    const parsed = JSON.parse(atob(token)) as { tags?: string[][] }
    const emailTag = Array.isArray(parsed?.tags)
      ? parsed.tags.find(
          (t: string[]) => Array.isArray(t) && t[0] === "email" && typeof t[1] === "string"
        )
      : null
    return emailTag?.[1] ?? ""
  } catch {
    return ""
  }
}

function emailSetupHash(email: string): string {
  return bytesToHex(argon2id(utf8_encode(email), "pomegranate", { t: 1, m: 65536, p: 4 }))
}

// Spec step 5: look up the kind-16440 announcement for this email to find
// which central it registered at. Returns null when there is none (or the
// lookup itself fails — relay outages must not brick login for users who
// do belong to our central, GET /account below remains authoritative).
async function searchForActualCentralURLAnnounced(email: string): Promise<string | null> {
  if (!email) return null
  try {
    const results = await pool.querySync(
      BIG_RELAYS,
      { kinds: [KIND_SETUP_ANNOUNCEMENT], "#m": [emailSetupHash(email)], limit: 1 },
      { maxWait: 5000 }
    )
    const centralTag = results[0]?.tags?.find(
      (t: string[]) => Array.isArray(t) && t[0] === "central" && typeof t[1] === "string"
    )
    return centralTag?.[1] ?? null
  } catch {
    return null
  }
}

// Announce this registration so other clients (and future logins here) can
// discover the right central via step 5. Best-effort: publish to the big
// relays plus the user's own write relays, like hallway does.
async function publishSetupAnnouncement(
  email: string,
  central: string,
  secretKey: Uint8Array,
  log: (msg: string) => void
) {
  if (!email) return
  log("Announcing setup…")
  const event = finalizeEvent(
    {
      kind: KIND_SETUP_ANNOUNCEMENT,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["m", emailSetupHash(email)],
        ["central", central]
      ],
      content: ""
    },
    secretKey
  )
  let writeRelays: string[] = []
  try {
    writeRelays = (await loadRelayList(event.pubkey)).items
      .filter(r => r.write)
      .map(r => r.url)
  } catch {}
  await Promise.allSettled(pool.publish([...BIG_RELAYS, ...writeRelays], event))
}

// GET /profiles, locate the one named "default", and produce a bunker://
// URI pointing at central's wss relay with that profile's handler_pubkey.
// If no "default" profile exists yet (fresh registration, or an existing
// account that lost it), POST /profiles to create one and re-list — this
// makes the helper idempotent so both the new-account and existing-account
// branches can call it unconditionally. The bunker URI shape lives only
// here so both code paths agree on it.
async function fetchDefaultBunkerUri(
  central: string,
  token: string,
  log: (msg: string) => void
): Promise<string> {
  const findDefault = (profiles: any[]) =>
    Array.isArray(profiles) ? profiles.find((p: any) => p?.name === "default") : null

  const list = async () => {
    const resp = await fetch(`${central}/profiles`, {
      headers: { Authorization: "Token " + token }
    })
    await assertOk(resp, "profile list")
    return await resp.json()
  }

  let profile = findDefault(await list())
  if (!profile) {
    // Single status update before the (only) side-effecting call.
    log("Creating default signing profile…")
    const createResp = await fetch(`${central}/profiles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Token " + token
      },
      body: JSON.stringify({ name: "default" })
    })
    await assertOk(createResp, "profile creation")
    // POST /profiles doesn't echo the created row, so re-list to read its
    // handler_pubkey.
    profile = findDefault(await list())
  }

  if (!profile?.handler_pubkey) {
    throw new Error('central did not return a "default" profile after creation')
  }
  // Central serves nostr-relay over wss on the same host as the HTTPS API,
  // so swapping the leading `http` → `ws` in the origin is enough; anchored
  // regex prevents accidental replacement of 'http' substrings elsewhere
  // in the URL. encodeURIComponent because the relay value contains `://`
  // which would otherwise confuse the `?relay=` parser.
  const relay = central.replace(/^http/, "ws")
  return `bunker://${profile.handler_pubkey}?relay=${encodeURIComponent(relay)}`
}

// Open the central's Google OAuth flow in a popup, then either:
//   - look up an existing account's default bunker (if /account hits), or
//   - mint a fresh nsec, shard it across the operators, register central +
//     operators, create a default signing profile, and return its bunker.
// In both cases the returned `bunker://` URI is ready to feed straight
// into `connectBunkerInput`.
export async function googleLoginAndCreateBunker({
  onProgress
}: { onProgress?: (msg: string) => void } = {}): Promise<string> {
  const log = onProgress || (() => {})
  const central = CENTRAL_URL
  const operators = OPERATORS

  // 1. OAuth popup — central redirects to Google then posts the resulting
  //    token back via window.postMessage.
  log("Opening Google login…")
  const popup = window.open(
    `${central}/login/google`,
    "PomegranateOAuth",
    "width=600,height=600"
  ) as Window | null
  if (!popup) throw new Error("Popup blocked")

  const token = await new Promise<string>((resolve, reject) => {
    let settled = false
    const monitor = window.setInterval(() => {
      if (settled || !popup.closed) return
      finish(null, new Error("Login cancelled"))
    }, 250)
    function finish(value: string | null, err?: Error) {
      if (settled) return
      settled = true
      window.clearInterval(monitor)
      window.removeEventListener("message", handler)
      if (err) reject(err)
      else resolve(value!)
    }
    function handler(event: MessageEvent) {
      // Filter inline (rather than `{ once: true }`) so an unrelated
      // postMessage from another tab doesn't kill our listener before the
      // real auth response arrives. `event.source === popup` further
      // narrows it to *our* popup vs. another same-origin window.
      if (
        event.origin !== central ||
        (event.source as Window) !== popup ||
        !(event.data as any)?.token
      ) {
        return
      }
      try {
        popup.close()
      } catch {}
      finish((event.data as any).token as string)
    }
    ;(window as any).addEventListener("message", handler)
  })

  // 2. Existing account? Skip the whole sharding dance and just hand back
  //    the bunker that was minted on a previous login.
  log("Checking account…")
  const email = findTokenEmail(token)
  const existingAccount = await tryFetchAccount(central, token)
  if (existingAccount) {
    log("Account found, fetching default bunker…")
    return await fetchDefaultBunkerUri(central, token, log)
  }

  // No account here — but the user may have registered at a different
  // central. Redirect instead of minting a duplicate key/account.
  const actualCentral = await searchForActualCentralURLAnnounced(email)
  if (actualCentral && actualCentral !== central) {
    throw new WrongCentralError(actualCentral, central)
  }

  // 3. No account anywhere yet — run the full first-time registration flow.
  const session = crypto.randomUUID()

  // Generate a fresh nsec and split it.
  log("Generating key…")
  const secretKey = generateSecretKey()
  // trustedKeyDeal wants the secret as a bigint — big-endian-decode the 32 bytes.
  const bytes = Array.from(secretKey) as number[]
  const masterSkBignum: bigint = bytes.reduce(
    (acc: bigint, byte: number) => (acc << 8n) + BigInt(byte),
    0n
  )
  const threshold = Math.ceil((operators.length * 7) / 12)
  log("Splitting secret…")
  const { shards } = trustedKeyDeal(masterSkBignum, threshold, operators.length)

  // Register the account at central. Events are stamped now() — central
  // rejects events too far out of clock-skew range, so we sign and send
  // each event in the same tick rather than batching ahead of time.
  log("Registering with central…")
  const regEvent = finalizeEvent(
    {
      kind: 20445,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["threshold", String(threshold)],
        ...operators.map((op, i) => ["operator", op, hexPubShard(shards[i].pubShard)])
      ],
      content: ""
    },
    secretKey
  )
  const regResp = await fetch(`${central}/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Token " + token,
      "X-Pomegranate-Session": session
    },
    body: JSON.stringify(regEvent)
  })
  await assertOk(regResp, "central /register")

  // Hand each operator its own shard. The session-derived header proves
  // central just authorized us with this session — sha256(session + ':' + opURL).
  // Note: if an operator fails after central is already registered, the
  // user must reset (DELETE /account) and try again — central won't let
  // them re-register over a half-provisioned account.
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i]
    log(`Registering with ${op}…`)
    const event = finalizeEvent(
      {
        kind: 20444,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["central", central],
          ["email", email]
        ],
        content: hexShard(shards[i])
      },
      secretKey
    )
    const opResp = await fetch(`${op}/po/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pomegranate-Operator-Token": bytesToHex(sha256(utf8_encode(session + ":" + op)))
      },
      body: JSON.stringify(event)
    })
    await assertOk(opResp, `${op} /register`)
  }

  // Announce the new setup, then wait until the operators confirm in the
  // background and central reports the account as operational before
  // touching /profiles.
  await publishSetupAnnouncement(email, central, secretKey, log)
  log("Waiting for account to become operational…")
  await waitForAccount(central, token, log)

  return await fetchDefaultBunkerUri(central, token, log)
}
