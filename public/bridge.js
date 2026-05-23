;(() => {
  const pending = new Map()
  // Prefer iframe.name (set by the launcher cross-origin) so we don't pollute
  // the URL with a query string that napps might echo into their own routing.
  // Fall back to the legacy `?__instance=` for back-compat.
  const INSTANCE_ID =
    (typeof window.name === "string" && window.name) ||
    new URLSearchParams(location.search).get("__instance") ||
    ""

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
        __nostrapps: ok ? "napp-dispatch-result" : "napp-dispatch-error",
        requestId,
        instanceId: INSTANCE_ID,
        ...(ok ? { result: payload } : { error: payload })
      },
      "*"
    )
  }

  async function handleDispatch(data) {
    const fn = window.napp?.onAction
    if (typeof fn !== "function") {
      throw new Error("window.napp.onAction is not registered")
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
    if (data.__nostrapps === "napp-dispatch-action") {
      handleDispatch(data)
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
    },
    pool: {
      query: (filters, opts) => rpc("pool.query", { filters, opts }),
      publish: (event, opts) => rpc("pool.publish", { event, opts })
    },
    instance: {
      id: INSTANCE_ID,
      get: key => rpc("instance.get", { key }),
      set: (key, value) => rpc("instance.set", { key, value }),
      delete: key => rpc("instance.delete", { key }),
      keys: () => rpc("instance.keys")
    }
  }

  window.nostrdb = {
    add: event => rpc("nostrdb.add", { event }),
    query: filters => rpc("nostrdb.query", { filters }),
    count: filters => rpc("nostrdb.count", { filters }),
    event: id => rpc("nostrdb.event", { id }),
    replaceable: (kind, author, identifier) =>
      rpc("nostrdb.replaceable", { kind, author, identifier })
  }

  // Inter-app calling. Everything is an action.
  //   window.napp.action(name, payload) — call a registered action handler
  // Receiving apps register:
  //   window.napp.onAction = async (name, payload) => { ... return value }
  window.napp = {
    action: (name, payload) => rpc("napp.action", { name, payload }),
    onAction: null,
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
      // ── metadata ───────────────────────────────────
      loadNostrUser: request => rpc("napp.loadNostrUser", request)
    }
  }
})()
