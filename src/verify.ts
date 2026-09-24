// Event signature checks, in wasm. Every event off a relay is verified on the
// main thread, once per subscription that receives it, so a few feeds open
// means thousands of checks; wasm does one ~7x faster than the JS verifier.
// JS covers the moment before the wasm loads, and has the last word on a
// rejection: the wasm serializes the event on its own, and a valid event it
// got wrong would otherwise be dropped. Only invalid events pay for both.

import { verifyEvent as jsVerifyEvent, type NostrEvent } from "@nostr/tools/pure"
import { setNostrWasm, verifyEvent as wasmVerifyEvent } from "@nostr/tools/wasm"
import { initNostrWasm } from "nostr-wasm/gzipped"

let wasmReady = false
initNostrWasm()
  .then(nw => {
    setNostrWasm(nw)
    wasmReady = true
  })
  .catch(err => console.warn("nostr-wasm failed to load, verifying in js", err))

export function verifyEvent(event: NostrEvent): boolean {
  return (wasmReady && wasmVerifyEvent(event)) || jsVerifyEvent(event)
}
