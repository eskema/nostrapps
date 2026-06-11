;(() => {
  const pending = new Map()
  const feedCallbacks = new Map()
  // iframe.name (set by the launcher cross-origin)
  const INSTANCE_ID = window.name

  function rpc(method, params) {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      window.parent.postMessage(
        {
          __nostrapps: "rpc",
          id,
          method,
          params,
          instanceId: INSTANCE_ID
        },
        "*"
      )
    })
  }

  function reply(requestId, ok, payload) {
    window.parent.postMessage(
      {
        __nostrapps: "napp-dispatch-result",
        requestId,
        instanceId: INSTANCE_ID,
        ...(ok ? { result: payload } : { error: payload })
      },
      "*"
    )
  }

  const actionHandlers = []

  function registerAction(pattern, fn) {
    if (typeof pattern !== "string" || !pattern) {
      throw new Error("window.napp.registerAction: pattern is required")
    }
    if (typeof fn !== "function") {
      throw new Error("window.napp.registerAction: handler must be function")
    }

    const idx = actionHandlers.length
    actionHandlers.push([pattern, fn])

    window.parent.postMessage(
      {
        __nostrapps: "napp-action-registered",
        instanceId: INSTANCE_ID,
        idx,
        pattern
      },
      "*"
    )
  }

  async function handleDispatch(data) {
    const fn = actionHandlers[data.idx]?.[1]
    if (!fn) {
      throw new Error("No registered action handler matched this dispatch")
    }
    const result = await fn(data.name, data.payload)
    reply(data.requestId, true, result ?? null)
  }

  window.addEventListener("message", event => {
    const data = event.data
    if (!data) return
    if (data.__nostrapps === "rpc-result" || data.__nostrapps === "rpc-error") {
      const p = pending.get(data.id)
      if (!p) return
      pending.delete(data.id)
      if (data.__nostrapps === "rpc-result") p.resolve(data.result)
      else p.reject(new Error(data.error))
      return
    }
    if (data.__nostrapps === "napp-feed-callback") {
      const callback = feedCallbacks.get(data.callbackId)
      if (callback) callback(data.events)
      return
    }
    if (data.__nostrapps === "napp-dispatch-action") {
      handleDispatch(data)
      return
    }
    if (data.__nostrapps === "napp-theme-change") {
      document.documentElement.dataset.theme = data.theme
      // Apply the launcher's resolved color tokens as inline custom properties.
      // Inline styles on :root outrank any stylesheet `:root[data-theme=...]`
      // rule, so a napp that uses var(--surface)/var(--text) tracks the launcher
      // automatically — no need to hardcode matching colors in each napp.
      if (data.vars) {
        for (const key in data.vars) {
          document.documentElement.style.setProperty("--" + key, data.vars[key])
        }
      }
      return
    }
  })

  window.nostr = {
    getPublicKey: () => rpc("getPublicKey"),
    signEvent: evt => rpc("signEvent", evt),
    nip04: {
      encrypt: (pubkey, plaintext) => rpc("nip04.encrypt", { pubkey, plaintext }),
      decrypt: (pubkey, ciphertext) => rpc("nip04.decrypt", { pubkey, ciphertext })
    },
    nip44: {
      encrypt: (pubkey, plaintext) => rpc("nip44.encrypt", { pubkey, plaintext }),
      decrypt: (pubkey, ciphertext) => rpc("nip44.decrypt", { pubkey, ciphertext })
    }
  }

  window.nostrdb = {
    add: event => rpc("nostrdb.add", { event }),
    query: filters => rpc("nostrdb.query", { filters }),
    count: filters => rpc("nostrdb.count", { filters }),
    event: id => rpc("nostrdb.event", { id }),
    replaceable: (kind, author, identifier) =>
      rpc("nostrdb.replaceable", { kind, author, identifier }),
    supports: async () => []
  }

  // Inter-app calling. Everything is an action.
  //   window.napp.action(name, payload, options?) — call a registered action handler
  // Receiving apps register:
  //   window.napp.registerAction(pattern, handler) — handle incoming action dispatches
  let feedSerial = 0
  function feedRpc(method, params, callback) {
    if (!callback) throw new Error("no callback specified")

    const callbackId = feedSerial++
    params.callbackId = callbackId
    feedCallbacks.set(callbackId, callback)

    rpc(method, params)

    return {
      close() {
        feedCallbacks.delete(callbackId)
        rpc("napp.feeds.cancel", { callbackId }).catch(() => {})
      }
    }
  }

  const napp = {
    instance: INSTANCE_ID,
    action: (name, payload, options) => rpc("napp.action", { name, payload, options }),
    registerAction,
    actionHandlers,
    feeds: {
      profile: (pubkey, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.profile", { pubkey, kinds, since, until, limit }, callback),
      following: (source, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.following", { source, kinds, since, until, limit }, callback),
      inbox: (pubkey, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.inbox", { pubkey, kinds, since, until, limit }, callback)
    },
    // Data-loading helpers executed on the host via @nostr/gadgets.
    // Signatures match the original library functions.
    utils: {
      // ── lists ──────────────────────────────────────
      loadBlossomServers: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadBlossomServers", { pubkey, hints, refreshStyle, defaultItems }),
      loadBookmarks: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadBookmarks", { pubkey, hints, refreshStyle, defaultItems }),
      loadEmojis: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadEmojis", { pubkey, hints, refreshStyle, defaultItems }),
      loadFavoriteRelays: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadFavoriteRelays", { pubkey, hints, refreshStyle, defaultItems }),
      loadFavoriteScrolls: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadFavoriteScrolls", { pubkey, hints, refreshStyle, defaultItems }),
      loadFollowsList: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadFollowsList", { pubkey, hints, refreshStyle, defaultItems }),
      loadMuteList: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadMuteList", { pubkey, hints, refreshStyle, defaultItems }),
      loadPins: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadPins", { pubkey, hints, refreshStyle, defaultItems }),
      loadRelayList: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadRelayList", { pubkey, hints, refreshStyle, defaultItems }),
      loadWikiAuthors: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadWikiAuthors", { pubkey, hints, refreshStyle, defaultItems }),
      loadWikiRelays: (pubkey, hints, refreshStyle, defaultItems) =>
        rpc("napp.loadWikiRelays", { pubkey, hints, refreshStyle, defaultItems }),
      // ── sets ───────────────────────────────────────
      loadEmojiSets: (pubkey, hints, forceUpdate) =>
        rpc("napp.loadEmojiSets", { pubkey, hints, forceUpdate }),
      loadFollowPacks: (pubkey, hints, forceUpdate) =>
        rpc("napp.loadFollowPacks", { pubkey, hints, forceUpdate }),
      loadFollowSets: (pubkey, hints, forceUpdate) =>
        rpc("napp.loadFollowSets", { pubkey, hints, forceUpdate }),
      loadRelaySets: (pubkey, hints, forceUpdate) =>
        rpc("napp.loadRelaySets", { pubkey, hints, forceUpdate }),
      // ── relays ──────────────────────────────────────
      loadRelayInfo: (url, refreshStyle) => rpc("napp.loadRelayInfo", { url, refreshStyle }),
      // ── metadata ───────────────────────────────────
      loadNostrUser: request => rpc("napp.loadNostrUser", request)
    }
  }

  window.napp = napp
})()
