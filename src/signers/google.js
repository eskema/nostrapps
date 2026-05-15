import { generateSecretKey, finalizeEvent } from "@nostr/tools/pure"
import { trustedKeyDeal, hexShard, hexPubShard } from "@fiatjaf/promenade-trusted-dealer"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"

// Hardcoded Pomegranate deployment we point this launcher at.
const CENTRAL_URL = "https://auth.njump.me"
const OPERATORS = ["https://po.njump.me", "https://po.fiatjaf.com"]

const utf8 = new TextEncoder()

// Throw a descriptive error including any body text so failures from central
// or operators are debuggable in the launcher's status log.
async function assertOk(resp, label) {
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
async function tryFetchAccount(central, token) {
  const resp = await fetch(`${central}/account`, {
    headers: { Authorization: "Token " + token }
  })
  if (resp.status === 404) return null
  await assertOk(resp, "central /account")
  return await resp.json()
}

// GET /profiles, locate the one named "default", and produce a bunker://
// URI pointing at central's wss relay with that profile's handler_pubkey.
// If no "default" profile exists yet (fresh registration, or an existing
// account that lost it), POST /profiles to create one and re-list — this
// makes the helper idempotent so both the new-account and existing-account
// branches can call it unconditionally. The bunker URI shape lives only
// here so both code paths agree on it.
//
// `skipInitialList`: when we *just* registered the account we know the
// profile list is empty, so skip the first GET and go straight to POST.
async function fetchDefaultBunkerUri(central, token, log, { skipInitialList = false } = {}) {
  const findDefault = profiles =>
    Array.isArray(profiles) ? profiles.find(p => p?.name === "default") : null

  const list = async () => {
    const resp = await fetch(`${central}/profiles`, {
      headers: { Authorization: "Token " + token }
    })
    await assertOk(resp, "profile list")
    return await resp.json()
  }

  let profile = skipInitialList ? null : findDefault(await list())
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
export async function googleLoginAndCreateBunker({ onProgress } = {}) {
  const log = onProgress || (() => {})
  const central = CENTRAL_URL
  const operators = OPERATORS

  // 1. OAuth popup — central redirects to Google then posts the resulting
  //    token back via window.postMessage.
  log("Opening Google login…")
  const popup = window.open(`${central}/login/google`, "PomegranateOAuth", "width=600,height=600")
  if (!popup) throw new Error("Popup blocked")

  const token = await new Promise((resolve, reject) => {
    let settled = false
    const monitor = window.setInterval(() => {
      if (settled || !popup.closed) return
      finish(null, new Error("Login cancelled"))
    }, 250)
    function finish(value, err) {
      if (settled) return
      settled = true
      window.clearInterval(monitor)
      window.removeEventListener("message", handler)
      if (err) reject(err)
      else resolve(value)
    }
    function handler(event) {
      // Filter inline (rather than `{ once: true }`) so an unrelated
      // postMessage from another tab doesn't kill our listener before the
      // real auth response arrives. `event.source === popup` further
      // narrows it to *our* popup vs. another same-origin window.
      if (event.origin !== central || event.source !== popup || !event.data?.token) {
        return
      }
      try {
        popup.close()
      } catch {}
      finish(event.data.token)
    }
    window.addEventListener("message", handler)
  })

  // 2. Existing account? Skip the whole sharding dance and just hand back
  //    the bunker that was minted on a previous login.
  log("Checking account…")
  const existingAccount = await tryFetchAccount(central, token)
  if (existingAccount) {
    log("Account found, fetching default bunker…")
    return await fetchDefaultBunkerUri(central, token, log)
  }

  // 3. No account yet — run the full first-time registration flow.
  const session = crypto.randomUUID()

  // Token is base64-encoded JSON with a `tags` array; the operators want
  // the email so the user can later log into the recovery popups.
  let email = ""
  try {
    const parsed = JSON.parse(atob(token))
    const emailTag = Array.isArray(parsed?.tags)
      ? parsed.tags.find(t => Array.isArray(t) && t[0] === "email" && typeof t[1] === "string")
      : null
    email = emailTag?.[1] ?? ""
  } catch {}

  // Generate a fresh nsec and split it.
  log("Generating key…")
  const secretKey = generateSecretKey()
  // trustedKeyDeal wants the secret as a bigint — big-endian-decode the 32 bytes.
  const masterSkBignum = Array.from(secretKey).reduce((acc, byte) => (acc << 8n) + BigInt(byte), 0n)
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
    const opResp = await fetch(`${op}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pomegranate-Operator-Token": bytesToHex(sha256(utf8.encode(session + ":" + op)))
      },
      body: JSON.stringify(event)
    })
    await assertOk(opResp, `${op} /register`)
  }

  // Default signing profile is created lazily inside fetchDefaultBunkerUri.
  // We just registered, so the profile list is guaranteed empty — skip the
  // initial GET and have the helper POST directly, then re-list.
  return await fetchDefaultBunkerUri(central, token, log, { skipInitialList: true })
}
