import { getType } from "../account.js"
import { nip07Signer } from "./nip07.js"
import { nip46Signer, restoreBunkerSigner, hasStoredBunker } from "./nip46.js"

// Resolves to whichever signer is currently selected, based on persisted
// account type. The returned object exposes the standard shape:
//   { getPublicKey, signEvent, nip04: {encrypt, decrypt}, nip44: {...} }
//
// All methods are async-tolerant; the host's RPC dispatch awaits them.
export function currentSigner() {
  const type = getType()
  if (type === "nip46") return nip46Signer
  // Default and explicit 'nip07' both use the extension. If neither is set
  // (e.g. legacy state, never connected), fall through to nip07 — its
  // methods will throw "No NIP-07 extension detected" on first use.
  return nip07Signer
}

// Re-establish the bunker connection in the background after page reload.
// No-op if the user is on NIP-07 or has no stored bunker.
export async function reconnectIfNeeded() {
  if (getType() !== "nip46") return
  if (!hasStoredBunker()) return
  try {
    await restoreBunkerSigner()
  } catch (err) {
    console.warn("NIP-46 reconnect failed:", err)
  }
}
