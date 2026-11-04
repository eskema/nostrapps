import type { AbstractSimplePool } from "@nostr/tools/abstract-pool"
import type { AbstractRelay } from "@nostr/tools/abstract-relay"
import type { EventTemplate, VerifiedEvent } from "@nostr/tools"

type AuthSigner = (draft: EventTemplate) => Promise<VerifiedEvent>

// AUTH advertises support and supplies a challenge. Only an auth-required
// response should invoke the authorization policy (including in auto mode).
export function configureRelayAuth(pool: AbstractSimplePool, signer: AuthSigner) {
  const configured = new WeakSet<AbstractRelay>()
  pool.automaticallyAuth = url => {
    // The pool calls this hook after creating the relay, before connecting it.
    // Its relay map is protected and there is no public pre-connect hook; keep
    // this dependency here so even an initial NOTICE is handled.
    const relay = (pool as unknown as { relays: Map<string, AbstractRelay> }).relays.get(url)
    if (relay && !configured.has(relay)) {
      configured.add(relay)
      relay.onauth = undefined
      const onnotice = relay.onnotice
      relay.onnotice = message => {
        onnotice.call(relay, message)
        if (message.startsWith("auth-required:")) {
          void relay.auth(signer).catch(err => {
            console.warn(`Relay authentication failed for ${relay.url}:`, err)
          })
        }
      }
    }
    return null
  }

  // The pool already authenticates and retries rejected REQs and EVENTs once.
  // Supply a default for the launcher's readers, while preserving napp-specific
  // signers so their prompts still identify the app requesting access.
  const subscribeMap = pool.subscribeMap.bind(pool)
  pool.subscribeMap = (requests, params) =>
    subscribeMap(requests, { ...params, onauth: params.onauth ?? signer })
  const publish = pool.publish.bind(pool)
  pool.publish = (relays, event, params) =>
    publish(relays, event, { ...params, onauth: params?.onauth ?? signer })
}
