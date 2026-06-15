;(() => {
  // ── Neutralize service-worker registration ──────────────────────────
  // A napp runs inside the launcher's sandbox, where the origin's single
  // service-worker slot is already owned by the launcher (its sw.js serves the
  // napp's files from IDB). A napp registering its own SW can't work: the script
  // fetch bypasses the launcher SW and resolves from the network — 404 in prod,
  // or the dev server's index.html (text/html) which the browser rejects — and
  // if it did succeed it would evict the launcher's SW and break file serving.
  // Stub registration so such napps degrade gracefully instead of throwing.
  try {
    const swc = navigator.serviceWorker
    if (swc) {
      const stub = {
        scope: location.origin + "/",
        active: null,
        installing: null,
        waiting: null,
        update: () => Promise.resolve(stub),
        unregister: () => Promise.resolve(true),
        addEventListener() {},
        removeEventListener() {}
      }
      const def = (name, value) => {
        try {
          Object.defineProperty(swc, name, { configurable: true, value })
        } catch {}
      }
      def("register", () => {
        console.warn(
          "[nostrapps] service worker registration is unsupported in the sandbox; ignoring"
        )
        return Promise.resolve(stub)
      })
      def("getRegistration", () => Promise.resolve(undefined))
      def("getRegistrations", () => Promise.resolve([]))
      try {
        Object.defineProperty(swc, "ready", { configurable: true, get: () => Promise.resolve(stub) })
      } catch {}
    }
  } catch {}

  const pending = new Map()
  const feedCallbacks = new Map()

  let rpcSerial = 0
  function rpc(method, params) {
    const id = "rpc" + rpcSerial++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      window.parent.postMessage(
        {
          __nostrapps: "rpc",
          id,
          method,
          params,
          instanceId: window.name
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
        instanceId: window.name,
        ...(ok ? { result: payload } : { error: payload })
      },
      "*"
    )
  }

  const actionHandlers = []

  window.addEventListener("message", event => {
    const data = event.data
    if (!data) return

    switch (data.__nostrapps) {
      case "rpc-result":
      case "rpc-error": {
        const p = pending.get(data.id)
        if (!p) return
        pending.delete(data.id)
        if (data.__nostrapps === "rpc-result") p.resolve(data.result)
        else p.reject(new Error(data.error))
        return
      }
      case "napp-feed-callback": {
        const callback = feedCallbacks.get(data.callbackId)
        if (callback) callback(data.events, data.synced)
        return
      }
      case "napp-dispatch-action": {
        // if a callback was previously registered with registerAction() we'll have an idx here
        if (typeof data.idx === "number") {
          const fn = actionHandlers[data.idx]?.[1]
          if (!fn) {
            throw new Error("No registered action handler matched this dispatch")
          }

          // this is necessary to pass a result back to the caller, which is only possible when
          // a callback is registered with registerAction()
          Promise.resolve()
            .then(() => fn(data.name, data.payload))
            .then(result => reply(data.requestId, true, result ?? null))
        }

        // regardless of whether we have a callback registered or not, always call popstate
        const state = { action: { name: data.name, payload: data.payload } }
        history.pushState(state, "", location.href)
        window.dispatchEvent(new PopStateEvent("popstate", { state }))

        return
      }
      case "napp-theme-change": {
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
  //   window.napp.action(name, payload, options?) - call a registered action handler
  // Receiving apps register:
  //   window.napp.registerAction(pattern, handler) - handle incoming action dispatches
  //   window.napp.registerAction(pattern)
  //   window.addEventListener('popstate', handler) - each action is translated to a history event
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
    instance: window.name,
    action: (name, payload, options) => rpc("napp.action", { name, payload, options }),
    registerAction(pattern, fn) {
      if (typeof pattern !== "string" || !pattern) {
        throw new Error("window.napp.registerAction: pattern is required")
      }

      // if a callback is given we'll register its index(idx) in the array so actions fired later
      // with "napp=dispatch-action" can find and execute it easily
      let idx
      if (typeof fn === "function") {
        idx = actionHandlers.length
        actionHandlers.push([pattern, fn])
      }

      // but it can also be the case that it won't be registered because the app only wants to
      // receive new actions via the history 'popstate' event, which is fine too
      window.parent.postMessage(
        {
          __nostrapps: "napp-action-registered",
          instanceId: window.name,
          idx,
          pattern
        },
        "*"
      )
    },
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
      loadNostrUser: request => rpc("napp.loadNostrUser", request),
      // ── event fetching ────────────────────────────
      loadEvent: (code, relays, author) => rpc("napp.loadEvent", { code, relays, author }),
      // ── publishing ──────────────────────────────
      publish: (event, relays) => rpc("napp.publish", { event, relays })
    }
  }

  window.napp = napp
})()
