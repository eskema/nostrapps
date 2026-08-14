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
  const incHandlers = new Map() // topic -> Set<callback(payload, syntheticEvent)>
  const configSubscribers = new Set()
  const configSchemaErrorHandlers = new Set()
  let lastConfigValues = null

  // `raw` marks calls whose contract resolves ok:false results (common): an
  // `ok` boolean means the call completed — only shapeless failures reject.
  function nappletCall(type, params, pick, raw) {
    const id = "n5d" + n5dSerial++
    return new Promise((resolve, reject) => {
      pending5d.set(id, { resolve, reject, pick, raw })
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
    // config.values answers config.get (id set) or is a subscription push.
    if (data.type === "config.values") {
      lastConfigValues = data.values || {}
      if (typeof data.id === "string") {
        const p = pending5d.get(data.id)
        if (p) {
          pending5d.delete(data.id)
          p.resolve(p.pick ? p.pick(data) : data)
        }
        return
      }
      for (const fn of configSubscribers) try { fn(lastConfigValues) } catch {}
      return
    }
    if (data.type === "config.schemaError") {
      for (const fn of configSchemaErrorHandlers)
        try { fn({ code: data.code, error: data.error }) } catch {}
      return
    }
    if (data.type === "inc.event") {
      const hs = incHandlers.get(data.topic)
      if (hs) {
        const payload = data.payload ?? {}
        const sender = data.sender ?? ""
        // Second arg mirrors @napplet/shim: a synthetic kind-0-shaped envelope.
        const synthetic = {
          id: "",
          pubkey: sender,
          created_at: Math.floor(Date.now() / 1000),
          kind: 0,
          tags: [["t", data.topic]],
          content: typeof payload === "string" ? payload : JSON.stringify(payload),
          sig: ""
        }
        for (const fn of hs) try { fn(payload, synthetic) } catch {}
      }
      return
    }
    // Request/response results. Success carries named fields; failure is a
    // `.error`-typed message, an `error` field, or `ok === false`.
    if (data.type.endsWith(".result") || data.type.endsWith(".error")) {
      const p = pending5d.get(data.id)
      if (!p) return
      pending5d.delete(data.id)
      if (p.raw && !data.type.endsWith(".error") && typeof data.ok === "boolean")
        p.resolve(p.pick ? p.pick(data) : data)
      else if (data.type.endsWith(".error") || data.error != null || data.ok === false)
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
        getItem: key => nappletCall("storage.get", { key, scope }, d => d.value),
        setItem: (key, value) => nappletCall("storage.set", { key, value, scope }, () => undefined),
        removeItem: key => nappletCall("storage.remove", { key, scope }, () => undefined),
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
    }),
    // Social actions the shell performs (nip19, profiles, follow/react/report).
    // Results resolve whenever `ok` is a boolean — ok:false is an answer.
    common: () => {
      const strip = d => {
        const { type, id, ...rest } = d
        return rest
      }
      const call = (type, params) => nappletCall(type, params, strip, true)
      return {
        encodeNip19: input => call("common.encodeNip19", { input }),
        decodeNip19: value => call("common.decodeNip19", { value }),
        getProfile: target => call("common.getProfile", { target }),
        follows: () => call("common.follows", null),
        follow: (...pubkeys) => call("common.follow", { pubkeys }),
        unfollow: (...pubkeys) => call("common.unfollow", { pubkeys }),
        react: (targetEventId, reaction, customEmojiHref) =>
          call("common.react", {
            targetEventId,
            reaction,
            ...(customEmojiHref === undefined ? {} : { customEmojiHref })
          }),
        report: (target, reason, text) => call("common.report", { target, reason, text })
      }
    },
    // In-session topic bus between napplet windows, mediated by the shell.
    inc: () => ({
      // emit(topic, extraTags, content) — @napplet/shim parity: content is a
      // JSON string that becomes the payload; extraTags aren't transported.
      emit: (topic, _extraTags, content) => {
        let payload
        try {
          payload = content ? JSON.parse(content) : undefined
        } catch {
          payload = content || undefined
        }
        window.parent.postMessage(
          { type: "inc.emit", topic, ...(payload !== undefined ? { payload } : {}) },
          "*"
        )
      },
      on: (topic, callback) => {
        let set = incHandlers.get(topic)
        if (!set) incHandlers.set(topic, (set = new Set()))
        set.add(callback)
        window.parent.postMessage({ type: "inc.subscribe", id: "n5d" + n5dSerial++, topic }, "*")
        return {
          close: () => {
            set.delete(callback)
            if (set.size === 0) {
              incHandlers.delete(topic)
              window.parent.postMessage({ type: "inc.unsubscribe", topic }, "*")
            }
          }
        }
      }
    }),
    link: () => ({
      // Resolves { status: "opened" | "denied" }; malformed URLs reject.
      open: (url, options) =>
        nappletCall("link.open", { url, ...(options ? { options } : {}) }, d => ({
          status: d.status
        }))
    }),
    // Shell-owned settings (@napplet/shim parity, including the lazy .schema
    // getter — the manifest meta tag isn't parsed yet when this runs).
    config: () => {
      let registered = null
      const manifestSchema = () => {
        const el = document.querySelector('meta[name="napplet-config-schema"]')
        try {
          return el ? JSON.parse(el.getAttribute("content") || "") : null
        } catch {
          return null
        }
      }
      const api = {
        registerSchema: (schema, version) =>
          nappletCall(
            "config.registerSchema",
            { schema, ...(version === undefined ? {} : { version }) },
            () => undefined
          ).then(r => {
            registered = schema
            return r
          }),
        get: () => nappletCall("config.get", null, d => d.values),
        subscribe: callback => {
          const first = configSubscribers.size === 0
          configSubscribers.add(callback)
          if (first) window.parent.postMessage({ type: "config.subscribe" }, "*")
          else if (lastConfigValues !== null) {
            const snap = lastConfigValues
            queueMicrotask(() => {
              if (configSubscribers.has(callback)) try { callback(snap) } catch {}
            })
          }
          return {
            close: () => {
              if (configSubscribers.delete(callback) && configSubscribers.size === 0)
                window.parent.postMessage({ type: "config.unsubscribe" }, "*")
            }
          }
        },
        openSettings: options => {
          const section = options && options.section
          window.parent.postMessage(
            { type: "config.openSettings", ...(section === undefined ? {} : { section }) },
            "*"
          )
        },
        onSchemaError: callback => {
          configSchemaErrorHandlers.add(callback)
          return () => configSchemaErrorHandlers.delete(callback)
        }
      }
      Object.defineProperty(api, "schema", {
        get: () => registered ?? manifestSchema(),
        enumerable: true
      })
      return api
    }
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
