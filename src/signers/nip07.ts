import { EventTemplate } from "@nostr/tools/pure"
import { cachedPublicKey } from "../account.js"

function ext() {
  if (!window.nostr) {
    throw new Error("No NIP-07 extension detected")
  }
  return window.nostr
}

export const nip07Signer = {
  getPublicKey() {
    return cachedPublicKey(() => ext().getPublicKey())
  },
  signEvent: (evt: EventTemplate) => ext().signEvent(evt),
  nip04: {
    encrypt: (pubkey: string, plaintext: string) => ext().nip04.encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => ext().nip04.decrypt(pubkey, ciphertext)
  },
  nip44: {
    encrypt: (pubkey: string, plaintext: string) => ext().nip44.encrypt(pubkey, plaintext),
    decrypt: (pubkey: string, ciphertext: string) => ext().nip44.decrypt(pubkey, ciphertext)
  }
}
