// napplet-bridge — the NIP-5D window.napplet surface, and ONLY that.
//
// Two homes use this exact code:
//  - nsite-hosted napps: the service worker injects this alongside bridge.js
//    (which owns window.nostr / window.napp / window.nostrdb).
//  - true napplets (kind 35129): the srcdoc loader inlines this file's text
//    before the verified index.html bytes. A napplet gets NO window.nostr —
//    signing is mediated through the relay domain — so this file must never
//    reference the napp surface.
//
// Availability is PRESENCE: the shell declares window.__nappletDomains before
// this runs, and we build window.napplet with exactly those domain objects.
// Wire + result-field names match the @napplet/nap contracts, so an app built
// against @napplet/shim runs unchanged.
;(function () {
  const pending5d = new Map()
  let n5dSerial = 0
  const themeHandlers = new Set()
  const identityHandlers = new Set()
  const relaySubs = new Map() // subId -> { onEvent, onEose, onClosed }
  const outboxSubs = new Map() // subId -> { event: Set, closed: Set }

  function nappletCall(type, params, pick) {
    const id = "n5d" + n5dSerial++
    return new Promise((resolve, reject) => {
      pending5d.set(id, { resolve, reject, pick })
      // napplet → shell posts to '*'; the shell demuxes by message source/origin.
      window.parent.postMessage({ type, id, ...(params || {}) }, "*")
    })
  }

  function handleNappletMessage(data) {
    if (data.type === "theme.changed") {
      for (const fn of themeHandlers) {
        try {
          fn(data.theme)
        } catch {}
      }
      return
    }
    if (data.type === "identity.changed") {
      for (const fn of identityHandlers) {
        try {
          fn(data.pubkey)
        } catch {}
      }
      return
    }
    if (data.type === "relay.event") {
      const s = relaySubs.get(data.subId)
      if (s && s.onEvent) try { s.onEvent(data.result && data.result.event) } catch {}
      return
    }
    if (data.type === "relay.eose") {
      const s = relaySubs.get(data.subId)
      if (s && s.onEose) try { s.onEose() } catch {}
      return
    }
    if (data.type === "relay.closed") {
      const s = relaySubs.get(data.subId)
      if (s) {
        if (s.onClosed) try { s.onClosed(data.reason) } catch {}
        relaySubs.delete(data.subId)
      }
      return
    }
    if (data.type === "outbox.event") {
      const s = outboxSubs.get(data.subId)
      if (s) for (const fn of s.event) try { fn(data.result) } catch {}
      return
    }
    if (data.type === "outbox.closed") {
      const s = outboxSubs.get(data.subId)
      if (s) {
        for (const fn of s.closed) try { fn(data.reason) } catch {}
        outboxSubs.delete(data.subId)
      }
      return
    }
    // Request/response results. Success carries named fields; failure is a
    // `.error`-typed message, an `error` field, or `ok === false`.
    if (data.type.endsWith(".result") || data.type.endsWith(".error")) {
      const p = pending5d.get(data.id)
      if (!p) return
      pending5d.delete(data.id)
      if (data.type.endsWith(".error") || data.error != null || data.ok === false)
        p.reject(new Error(data.message || data.error || "napplet call failed"))
      else p.resolve(p.pick ? p.pick(data) : data)
    }
  }

  window.addEventListener("message", event => {
    const data = event.data
    if (data && typeof data.type === "string" && !data.__nostrapps) handleNappletMessage(data)
  })

  const NAPPLET_DOMAIN_FACTORIES = {
    identity: () => ({
      getPublicKey: () => nappletCall("identity.getPublicKey", null, d => d.pubkey),
      getRelays: () => nappletCall("identity.getRelays", null, d => d.relays),
      getProfile: () => nappletCall("identity.getProfile", null, d => d.profile),
      getFollows: () => nappletCall("identity.getFollows", null, d => d.pubkeys),
      getMutes: () => nappletCall("identity.getMutes", null, d => d.pubkeys),
      getBlocked: () => nappletCall("identity.getBlocked", null, d => d.pubkeys),
      getList: listType => nappletCall("identity.getList", { listType }, d => d.entries),
      getZaps: () => nappletCall("identity.getZaps", null, d => d.zaps),
      getBadges: () => nappletCall("identity.getBadges", null, d => d.badges),
      onChanged: handler => {
        identityHandlers.add(handler)
        return { close: () => identityHandlers.delete(handler) }
      }
    }),
    theme: () => ({
      get: () => nappletCall("theme.get", null, d => d.theme),
      onChanged: handler => {
        themeHandlers.add(handler)
        return { close: () => themeHandlers.delete(handler) }
      }
    }),
    storage: () => {
      const ops = scope => ({
        get: key => nappletCall("storage.get", { key, scope }, d => d.value),
        set: (key, value) => nappletCall("storage.set", { key, value, scope }, () => undefined),
        remove: key => nappletCall("storage.remove", { key, scope }, () => undefined),
        keys: () => nappletCall("storage.keys", { scope }, d => d.keys)
      })
      return Object.assign(ops("shared"), { instance: Object.freeze(ops("instance")) })
    },
    resource: () => ({
      // Returns a Blob (its .type carries the mime), matching @napplet/nap. The
      // host handles https/http/data/blob and blossom:<sha256>.
      bytes: url => nappletCall("resource.bytes", { url }, d => d.blob),
      bytesMany: urls => nappletCall("resource.bytesMany", { urls }, d => d.items),
      // Ergonomic media helper: fetch bytes, wrap in a managed object URL. Set
      // `img.src = h.url` after `await h.ready`; call `h.revoke()` on load.
      bytesAsObjectURL: url => {
        const handle = { url: "", revoke: () => {} }
        let objectUrl = null
        let revoked = false
        const ready = nappletCall("resource.bytes", { url }, d => d.blob).then(blob => {
          if (revoked) return
          objectUrl = URL.createObjectURL(blob)
          handle.url = objectUrl
          return objectUrl
        })
        handle.revoke = () => {
          if (revoked) return
          revoked = true
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl)
            objectUrl = null
          }
        }
        Object.defineProperty(handle, "ready", { value: ready, enumerable: false })
        return handle
      }
    }),
    relay: () => ({
      publish: event => nappletCall("relay.publish", { event }, d => d.event),
      publishEncrypted: (event, recipient, encryption) =>
        nappletCall("relay.publishEncrypted", { event, recipient, encryption }, d => d.event),
      query: filters => nappletCall("relay.query", { filters }, d => d.events),
      subscribe: (subId, filters, handlers, relay) => {
        relaySubs.set(subId, handlers || {})
        const msg = { type: "relay.subscribe", id: "n5d" + n5dSerial++, subId, filters }
        if (relay) msg.relay = relay
        window.parent.postMessage(msg, "*")
        return {
          close: () => {
            relaySubs.delete(subId)
            window.parent.postMessage({ type: "relay.close", id: "n5d" + n5dSerial++, subId }, "*")
          }
        }
      }
    }),
    // Outbox-model routing: the shell discovers each author's relays (NIP-65),
    // queries/publishes there, and dedups. Result shapes match @napplet/nap:
    // getEvent → OutboxEventResult, query → OutboxResult, publish →
    // OutboxPublishResult, resolveRelays → OutboxRelayPlan.
    outbox: () => ({
      getEvent: (eventId, options) =>
        nappletCall("outbox.getEvent", { eventId, options }, d => ({
          result: d.result,
          incomplete: d.incomplete
        })),
      query: (filters, options) =>
        nappletCall("outbox.query", { filters, options }, d => ({
          events: d.events,
          incomplete: d.incomplete
        })),
      publish: (event, options) =>
        nappletCall("outbox.publish", { event, options }, d => ({
          ok: d.ok,
          event: d.event,
          eventId: d.eventId,
          relays: d.relays
        })),
      resolveRelays: target => nappletCall("outbox.resolveRelays", { target }, d => d.plan),
      subscribe: (filters, options) => {
        const subId = "ob" + n5dSerial++
        const listeners = { event: new Set(), closed: new Set() }
        outboxSubs.set(subId, listeners)
        window.parent.postMessage(
          { type: "outbox.subscribe", id: "n5d" + n5dSerial++, subId, filters, options },
          "*"
        )
        return {
          on: (evt, cb) => {
            if (evt === "event") listeners.event.add(cb)
            else if (evt === "closed") listeners.closed.add(cb)
          },
          close: () => {
            outboxSubs.delete(subId)
            window.parent.postMessage({ type: "outbox.close", id: "n5d" + n5dSerial++, subId }, "*")
          }
        }
      }
    })
  }

  const grantedDomains = Array.isArray(window.__nappletDomains) ? window.__nappletDomains : []
  if (grantedDomains.length) {
    const napplet = {}
    for (const d of grantedDomains) {
      const factory = NAPPLET_DOMAIN_FACTORIES[d]
      if (factory) napplet[d] = Object.freeze(factory())
    }
    Object.freeze(napplet)
    // Left replaceable on purpose: apps built with @napplet/shim assign their
    // own window.napplet (same wire, and the host enforces grants regardless).
    // Only window.nostr is pinned — that one is a signer.
    try {
      window.napplet = napplet
    } catch {}
  }
})()
