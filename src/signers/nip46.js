import { generateSecretKey, getPublicKey } from "@nostr/tools/pure"
import { BunkerSigner, parseBunkerInput } from "@nostr/tools/nip46"

const CLIENT_SECRET_KEY = "nostrapps:nip46:client-secret"
const BUNKER_POINTER_KEY = "nostrapps:nip46:bunker-pointer"

let activeSigner = null
let restorePromise = null

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) throw new Error("Invalid hex secret")
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function getClientSecret() {
  const stored = localStorage.getItem(CLIENT_SECRET_KEY)
  if (stored) return hexToBytes(stored)
  const secret = generateSecretKey()
  localStorage.setItem(CLIENT_SECRET_KEY, bytesToHex(secret))
  return secret
}

function readBunkerPointer() {
  const raw = localStorage.getItem(BUNKER_POINTER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    localStorage.removeItem(BUNKER_POINTER_KEY)
    return null
  }
}

function writeBunkerPointer(pointer) {
  localStorage.setItem(BUNKER_POINTER_KEY, JSON.stringify(pointer))
}

export function hasStoredBunker() {
  return !!readBunkerPointer()
}

// Connect from a bunker URI. We only accept bunker:// URIs here — NIP-05
// (name@domain) shortcuts route through a third-party HTTPS lookup that
// could hand back an attacker's bunker pubkey if compromised.
export async function connectBunkerInput(input) {
  const trimmed = (input || "").trim()
  if (!trimmed.startsWith("bunker://")) {
    throw new Error(
      "Paste a bunker:// URI from your signer app. " + "name@host shortcuts are not supported."
    )
  }
  const pointer = await parseBunkerInput(trimmed)
  if (!pointer) throw new Error("Invalid bunker URL")
  const signer = BunkerSigner.fromBunker(getClientSecret(), pointer)
  const pk = await signer.getPublicKey()
  writeBunkerPointer(pointer)
  activeSigner = signer
  return pk
}

// Re-create the signer from the persisted pointer. Returns the pubkey or
// null if no bunker is stored. Lazily memoized so concurrent callers share
// one BunkerSigner instance.
export async function restoreBunkerSigner() {
  if (activeSigner) return activeSigner.getPublicKey()
  if (restorePromise) return restorePromise
  const pointer = readBunkerPointer()
  if (!pointer) return null
  restorePromise = (async () => {
    try {
      const signer = BunkerSigner.fromBunker(getClientSecret(), pointer)
      const pk = await signer.getPublicKey()
      activeSigner = signer
      return pk
    } catch (err) {
      // Bad pointer / unreachable bunker — wipe so the user is forced
      // through the connect UI again.
      localStorage.removeItem(BUNKER_POINTER_KEY)
      throw err
    } finally {
      restorePromise = null
    }
  })()
  return restorePromise
}

export async function disconnectBunkerSigner() {
  localStorage.removeItem(BUNKER_POINTER_KEY)
  const signer = activeSigner
  activeSigner = null
  restorePromise = null
  await signer?.close?.()
}

async function active() {
  if (activeSigner) return activeSigner
  await restoreBunkerSigner()
  if (!activeSigner) throw new Error("No bunker connection")
  return activeSigner
}

// Standard signer shape (matches nip07Signer). All methods lazily ensure
// the underlying BunkerSigner is alive.
export const nip46Signer = {
  async getPublicKey() {
    return (await active()).getPublicKey()
  },
  async signEvent(evt) {
    return (await active()).signEvent(evt)
  },
  async getRelays() {
    const a = await active()
    if (a.getRelays) return a.getRelays()
    return Object.fromEntries((a.bp?.relays ?? []).map(r => [r, { read: true, write: true }]))
  },
  nip04: {
    async encrypt(pubkey, plaintext) {
      const a = await active()
      return a.nip04?.encrypt
        ? a.nip04.encrypt(pubkey, plaintext)
        : a.nip04Encrypt(pubkey, plaintext)
    },
    async decrypt(pubkey, ciphertext) {
      const a = await active()
      return a.nip04?.decrypt
        ? a.nip04.decrypt(pubkey, ciphertext)
        : a.nip04Decrypt(pubkey, ciphertext)
    }
  },
  nip44: {
    async encrypt(pubkey, plaintext) {
      const a = await active()
      return a.nip44?.encrypt
        ? a.nip44.encrypt(pubkey, plaintext)
        : a.nip44Encrypt(pubkey, plaintext)
    },
    async decrypt(pubkey, ciphertext) {
      const a = await active()
      return a.nip44?.decrypt
        ? a.nip44.decrypt(pubkey, ciphertext)
        : a.nip44Decrypt(pubkey, ciphertext)
    }
  }
}
