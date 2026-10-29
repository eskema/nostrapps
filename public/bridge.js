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
        Object.defineProperty(swc, "ready", {
          configurable: true,
          get: () => Promise.resolve(stub)
        })
      } catch {}
    }
  } catch {}

  const pending = new Map()
  const storeSubCallbacks = new Map()
  const subCallbacks = new Map()
  // nostrdb.subscribe and napp.utils.subscribe share one numbering, since the
  // host keeps both in the same place.
  let subSerial = 0

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

  // The NIP-5D window.napplet surface lives in its own file (napplet-bridge.js),
  // injected alongside this one; bridge.js owns only the napp surface below.
  // ── The napp's own history ──────────────────────────────────────────
  // The browser keeps one history for the whole tab: a real pushState in
  // here would be a step of the launcher's back button, and history.back()
  // would walk back whichever frame moved last — another napp's, or the
  // launcher itself away. So the entries live in this array, and the real
  // history only ever holds the current one (replaceState), which keeps
  // location reading as usual. Every entry gets its index as
  // __action_popstate_idx, so popstate handlers can tell back from forward.
  const popstateIdx = "__action_popstate_idx"
  // The real entry's state is the whole list, under this key: it outlives a
  // reload the napp does itself (location.reload() can't be wrapped), so the
  // next document picks up where this one was. history.state is patched to
  // read the current entry's own state instead.
  const stackKey = "__napp_history"
  const realReplace = history.replaceState.bind(history)
  const realStateGet = Object.getOwnPropertyDescriptor(History.prototype, "state").get
  const realReload = () => location.reload()
  const withIdx = (state, idx) =>
    state === null || typeof state === "object" ? { ...(state || {}), [popstateIdx]: idx } : state
  // The action an entry stands for, for the launcher: the one the launcher
  // dispatched into it (as it was sent, before view resolution), or the
  // napp's own { action: { name, payload } } state.
  const actionOf = state => {
    const a = state && state.action
    return a && typeof a.name === "string" && a.name ? { name: a.name, payload: a.payload } : null
  }

  // A list found in the real state is this window's, from before the napp
  // reloaded itself. Otherwise this is a fresh start — a new window, or the
  // launcher's reload, which resets the real state on its way out (see
  // napp-nav reload) so the replay it does next starts from nothing.
  let entries
  let pos
  const saved = (() => {
    const raw = realStateGet.call(history)
    return raw && typeof raw === "object" ? raw[stackKey] : null
  })()
  if (
    saved &&
    Array.isArray(saved.entries) &&
    Number.isInteger(saved.pos) &&
    saved.pos >= 0 &&
    saved.pos < saved.entries.length
  ) {
    entries = saved.entries
    pos = saved.pos
  } else {
    const state = withIdx(realStateGet.call(history), 0)
    entries = [{ state, url: location.href, action: actionOf(state) }]
    pos = 0
  }
  try {
    Object.defineProperty(History.prototype, "state", {
      configurable: true,
      enumerable: true,
      get() {
        const raw = realStateGet.call(this)
        return raw && typeof raw === "object" && stackKey in raw ? entries[pos].state : raw
      }
    })
  } catch {}

  // Writes the list into the real entry, at the current entry's location.
  // Too big to keep whole (the browser caps a state's size), the current
  // entry alone goes: a reload then keeps where the napp is, not how it got
  // there.
  function save(title) {
    const url = entries[pos].url
    try {
      realReplace({ [stackKey]: { entries, pos } }, title ?? "", url)
    } catch (err) {
      if (err?.name === "SecurityError") throw err
      realReplace({ [stackKey]: { entries: [entries[pos]], pos: 0 } }, title ?? "", url)
    }
  }
  // An entry as the napp's pushState/replaceState hands it: its state cloned
  // (and an uncloneable one thrown, as the real call would) and its url
  // resolved, before anything changed.
  function makeEntry(state, url, idx, action) {
    const cloned = structuredClone(withIdx(state, idx))
    const href = url == null ? location.href : new URL(url, location.href).href
    return { state: cloned, url: href, action: action ?? actionOf(cloned) }
  }
  // Applies a change to the list and writes it, or puts the list back as it
  // was if the real call refuses it (a url off the napp's origin, say).
  function commit(change, title) {
    const before = { entries: entries.slice(), pos }
    change()
    try {
      save(title)
    } catch (err) {
      entries = before.entries
      pos = before.pos
      throw err
    }
    report()
  }
  save()

  // The index the popstate being dispatched comes from, while it runs.
  let firingFrom = null

  // Where the napp is, as the launcher keeps it: the actions of its entries
  // in order and how many of them are ahead of the current one — restored
  // with the space, replayed after a reload. Sent only when it changed.
  let lastReport = ""
  const report = () => {
    const actions = []
    let ahead = 0
    entries.forEach((e, i) => {
      if (!e.action) return
      actions.push(e.action)
      if (i > pos) ahead++
    })
    const msg = { __nostrapps: "napp-history", instanceId: window.name, actions, ahead }
    let key
    try {
      key = JSON.stringify([actions, ahead])
    } catch {
      return
    }
    if (key === lastReport) return
    lastReport = key
    try {
      window.parent.postMessage(msg, "*")
    } catch {} // a payload that can't be cloned stays the napp's own business
  }

  function pushEntry(state, title, url, action) {
    const entry = makeEntry(state, url, pos + 1, action)
    commit(() => {
      entries = entries.slice(0, pos + 1)
      entries.push(entry)
      pos++
    }, title)
  }

  function firePopstate(state, from) {
    firingFrom = from
    try {
      window.dispatchEvent(new PopStateEvent("popstate", { state }))
    } finally {
      firingFrom = null
    }
  }

  function go(delta) {
    delta = Math.trunc(Number(delta)) || 0
    if (!delta) return realReload()
    const to = pos + delta
    if (to < 0 || to >= entries.length) return
    const from = pos
    commit(() => {
      pos = to
    })
    const state = history.state
    // popstate comes after the call returns, as the browser's does.
    setTimeout(() => firePopstate(state, from))
  }

  history.pushState = function (state, title, url) {
    pushEntry(state, title, url)
  }
  history.replaceState = function (state, title, url) {
    const entry = makeEntry(state, url, pos)
    commit(() => {
      entries = entries.slice()
      entries[pos] = entry
    }, title)
  }
  history.back = () => go(-1)
  history.forward = () => go(1)
  history.go = delta => go(delta)
  try {
    Object.defineProperty(history, "length", { configurable: true, get: () => entries.length })
  } catch {}

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
      case "nostrdb-sub-event": {
        storeSubCallbacks.get(data.callbackId)?.(data.event)
        return
      }
      case "napp-sub-callback": {
        const cbs = subCallbacks.get(data.callbackId)
        const msg = data.msg
        if (!cbs || !msg) return
        try {
          if (msg.type === "eose") cbs.eoseEventsCallback?.(msg.events || [])
          else if (msg.type === "event") cbs.liveEventCallback?.(msg.event)
          else if (msg.type === "closed") {
            subCallbacks.delete(data.callbackId)
            cbs.closedCallback?.(msg.reasons || {})
          }
        } catch (err) {
          console.error("[napp] subscription callback threw", err)
        }
        return
      }
      case "napp-dispatch-action": {
        // if a callback was previously registered with registerAction() we'll have an idx here.
        // A handler always answers, its error included, or the caller waits for good. With
        // no handler (popstate only, below) nothing answers: the window is the answer, and
        // an auxiliary one closes on it.
        if (typeof data.idx === "number") {
          const fn = actionHandlers[data.idx]?.[1]
          if (!fn) {
            reply(data.requestId, false, "No registered action handler matched this dispatch")
          } else {
            Promise.resolve()
              .then(() => fn(data.name, data.payload))
              .then(
                result => reply(data.requestId, true, result ?? null),
                err => reply(data.requestId, false, String(err?.message ?? err))
              )
          }
        }

        // regardless of whether we have a callback registered or not, always call popstate
        const from = pos
        pushEntry(
          { action: { name: data.name, payload: data.payload } },
          "",
          location.href,
          data.record && actionOf({ action: data.record })
        )
        firePopstate(history.state, from)

        return
      }
      case "napp-nav": {
        // The window's back/forward/reload buttons, and the launcher putting a
        // replayed history back where it was (go).
        if (data.dir === "back") go(-1)
        else if (data.dir === "forward") go(1)
        else if (data.dir === "go") go(data.delta)
        else if (data.dir === "reload") {
          // The launcher replays the window's actions into the new document, so
          // it starts from where this one started — the first entry's location,
          // no state — not from wherever the history had got to.
          realReplace({ [popstateIdx]: 0 }, "", entries[0].url)
          realReload()
        }
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

  const nostrShim = {
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
  // window.nostr (NIP-07) is GATED on the granted `identity` capability — the
  // shell declares the grant via window.__nappletDomains before this runs.
  //
  // We ALWAYS pin window.nostr non-writable/non-configurable, whether we grant it
  // or not. If granted, it's our shim (routing signer traffic through the host).
  // If NOT granted, it's pinned to `undefined` — otherwise a NIP-07 browser
  // extension (Alby, nos2x…) would inject its own window.nostr into the frame and
  // hand the site a signer anyway, bypassing the denial. Pinning blocks that; the
  // host also refuses the signer rpc when identity is ungranted (defense in depth
  // — a site could postMessage the rpc directly).
  const identityGranted =
    Array.isArray(window.__nappletDomains) && window.__nappletDomains.includes("identity")
  try {
    Object.defineProperty(window, "nostr", {
      value: identityGranted ? nostrShim : undefined,
      writable: false,
      configurable: false,
      enumerable: true
    })
  } catch {
    if (identityGranted) {
      try {
        window.nostr = nostrShim
      } catch {}
    }
  }

  window.nostrdb = {
    add: event => rpc("nostrdb.add", { event }),
    query: filters => rpc("nostrdb.query", { filters }),
    count: filters => rpc("nostrdb.count", { filters }),
    event: id => rpc("nostrdb.event", { id }),
    remove: ids => rpc("nostrdb.remove", { ids }),
    replaceable: (kind, author, identifier) =>
      rpc("nostrdb.replaceable", { kind, author, identifier }),
    // Every event saved to the store from now on that matches filters (one or
    // an array), one by one. What is already stored comes from query().
    // Leaving the loop (break, return, throw) ends the subscription, and so
    // does return() on it while it waits. Not a generator: one parked on an
    // await can't be returned until its next event. It starts at once, so
    // what is saved between this call and the loop is kept for it.
    subscribe: filters => {
      const callbackId = subSerial++
      const queue = []
      const waiting = []
      let done = false
      const end = () => {
        if (done) return
        done = true
        storeSubCallbacks.delete(callbackId)
        rpc("nostrdb.unsubscribe", { callbackId }).catch(() => {})
        for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true })
      }
      storeSubCallbacks.set(callbackId, event => {
        const resolve = waiting.shift()
        if (resolve) resolve({ value: event, done: false })
        else queue.push(event)
      })
      const started = rpc("nostrdb.subscribe", { filters, callbackId })
      started.catch(end)
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          await started
          if (queue.length) return { value: queue.shift(), done: false }
          if (done) return { value: undefined, done: true }
          return new Promise(resolve => waiting.push(resolve))
        },
        async return() {
          end()
          return { value: undefined, done: true }
        }
      }
    },
    supports: async () => []
  }

  // Inter-app calling. Everything is an action.
  //   window.napp.action(name, payload, options?) - call a registered action handler
  //     options: { instance?: string, auxiliary?: boolean } — auxiliary
  //     restricts the dispatch to "auxiliary"-mode apps, opened in an
  //     ephemeral floating window that closes itself on response.
  // Receiving apps register:
  //   window.napp.registerAction(pattern, handler) - handle incoming action dispatches
  //   window.napp.registerAction(pattern)
  //   window.addEventListener('popstate', handler) - each action is translated to a history event
  // A subscription on the host (napp.subscribe, napp.outbox): everything
  // stored comes in one go to eoseEventsCallback, then each new event to
  // liveEventCallback. Answers the closer.
  function hostSubscription(method, params, opts) {
    const { label, maxEoseTimeout, eoseEventsCallback, liveEventCallback, closedCallback } =
      opts || {}
    const callbackId = subSerial++
    subCallbacks.set(callbackId, { eoseEventsCallback, liveEventCallback, closedCallback })
    rpc(method, { ...params, label, maxEoseTimeout, callbackId }).catch(err => {
      const cbs = subCallbacks.get(callbackId)
      if (!cbs) return
      subCallbacks.delete(callbackId)
      console.error("[napp] subscription failed", err)
      const reason = "error: " + String(err?.message || err)
      try {
        const relays = params.relays || [""]
        cbs.closedCallback?.(Object.fromEntries(relays.map(url => [url, reason])))
      } catch {}
    })
    return () => {
      if (!subCallbacks.delete(callbackId)) return
      rpc("napp.unsubscribe", { callbackId }).catch(() => {})
    }
  }

  // A plain REQ to exactly these relays.
  function subscribe(relays, filter, opts) {
    return hostSubscription("napp.subscribe", { relays, filter }, opts)
  }

  // Track the cursor inside this iframe so dispatched actions can carry it; the
  // launcher converts it to screen coords (it never sees pointer events here).
  let __pointer = { x: 0, y: 0 }
  window.addEventListener(
    "pointermove",
    e => {
      __pointer = { x: e.clientX, y: e.clientY }
    },
    { passive: true }
  )

  // A click in the launcher can't light-dismiss a popover in here: this document
  // only ever sees pointer events that land inside the iframe, so the Popover
  // API's light-dismiss never runs and the napp's own menus stay open while the
  // user clicks around outside. Losing window focus is the one signal that does
  // cross the boundary — treat it as a click outside and run light-dismiss here,
  // which is what the browser would have done. Only auto/hint popovers dismiss
  // on their own; `manual` ones stay the napp's business. Note this also fires
  // when the whole browser loses focus, matching how native menus behave.
  window.addEventListener("blur", () => {
    let open
    try {
      open = document.querySelectorAll(":popover-open")
    } catch {
      return // pre-Chrome-114 engines don't know the selector
    }
    for (const el of open) {
      if (el.popover !== "auto" && el.popover !== "hint") continue
      try {
        el.hidePopover()
      } catch {} // already closed with an ancestor popover
    }
  })

  // ── Shared nostr primitives (sync, pure — no rpc) ────────────────────
  // Hand-rolled bech32 (BIP-173) + TLV so bridge.js stays a static,
  // dependency-free file the launcher's service worker serves as-is (no build
  // step). Shapes match nostr-tools nip19.
  const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
  const BECH32_MAP = {}
  for (let i = 0; i < BECH32_CHARSET.length; i++) BECH32_MAP[BECH32_CHARSET[i]] = i
  const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

  function bech32Polymod(values) {
    let chk = 1
    for (let p = 0; p < values.length; p++) {
      const top = chk >>> 25
      chk = ((chk & 0x1ffffff) << 5) ^ values[p]
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GEN[i]
    }
    return chk >>> 0
  }
  function bech32HrpExpand(hrp) {
    const out = []
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5)
    out.push(0)
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
    return out
  }
  function bech32Decode(str) {
    if (typeof str !== "string") return null
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null // mixed case
    const s = str.toLowerCase()
    const pos = s.lastIndexOf("1")
    if (pos < 1 || pos + 7 > s.length) return null
    const data = []
    for (let i = pos + 1; i < s.length; i++) {
      const v = BECH32_MAP[s[i]]
      if (v === undefined) return null
      data.push(v)
    }
    const hrp = s.slice(0, pos)
    if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) return null
    return { hrp, words: data.slice(0, data.length - 6) }
  }
  function bech32Checksum(hrp, data) {
    const mod = bech32Polymod(bech32HrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1
    const out = []
    for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31)
    return out
  }
  function bech32Encode(hrp, data) {
    const combined = data.concat(bech32Checksum(hrp, data))
    let s = hrp + "1"
    for (let i = 0; i < combined.length; i++) s += BECH32_CHARSET[combined[i]]
    return s
  }
  function convertBits(data, from, to, pad) {
    let acc = 0
    let bits = 0
    const out = []
    const maxv = (1 << to) - 1
    for (let i = 0; i < data.length; i++) {
      const value = data[i]
      if (value < 0 || value >>> from) return null
      acc = ((acc << from) | value) >>> 0
      bits += from
      while (bits >= to) {
        bits -= to
        out.push((acc >>> bits) & maxv)
      }
    }
    if (pad) {
      if (bits > 0) out.push((acc << (to - bits)) & maxv)
    } else if (bits >= from || (acc << (to - bits)) & maxv) {
      return null
    }
    return out
  }
  const bytesToHex = bytes => {
    let s = ""
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] & 255).toString(16).padStart(2, "0")
    return s
  }
  const hexToBytes = hex => {
    if (typeof hex !== "string" || hex.length % 2) throw new Error("invalid hex")
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  const utf8Decode = b => new TextDecoder().decode(new Uint8Array(b))
  const utf8Encode = s => new TextEncoder().encode(s)
  const uint32be = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  const be32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

  function parseTLV(bytes) {
    const result = {}
    let i = 0
    while (i + 1 < bytes.length) {
      const t = bytes[i++]
      const l = bytes[i++]
      if (i + l > bytes.length) break
      ;(result[t] = result[t] || []).push(bytes.slice(i, i + l))
      i += l
    }
    return result
  }
  function encodeTLV(entries) {
    const parts = []
    for (let e = 0; e < entries.length; e++) {
      const v = entries[e][1]
      parts.push(entries[e][0], v.length)
      for (let i = 0; i < v.length; i++) parts.push(v[i])
    }
    return parts
  }

  function nip19Decode(bech) {
    const dec = bech32Decode(bech)
    if (!dec) throw new Error("invalid bech32")
    const bytes = convertBits(dec.words, 5, 8, false)
    if (!bytes) throw new Error("invalid bech32 data")
    const type = dec.hrp
    if (type === "npub" || type === "note" || type === "nsec") {
      return { type, data: bytesToHex(bytes) }
    }
    const tlv = parseTLV(bytes)
    if (type === "nprofile") {
      if (!tlv[0]) throw new Error("nprofile missing pubkey")
      return {
        type,
        data: { pubkey: bytesToHex(tlv[0][0]), relays: (tlv[1] || []).map(utf8Decode) }
      }
    }
    if (type === "nevent") {
      if (!tlv[0]) throw new Error("nevent missing id")
      return {
        type,
        data: {
          id: bytesToHex(tlv[0][0]),
          relays: (tlv[1] || []).map(utf8Decode),
          author: tlv[2] ? bytesToHex(tlv[2][0]) : undefined,
          kind: tlv[3] ? uint32be(tlv[3][0]) : undefined
        }
      }
    }
    if (type === "naddr") {
      if (!tlv[0] || !tlv[2] || !tlv[3]) throw new Error("invalid naddr")
      return {
        type,
        data: {
          identifier: utf8Decode(tlv[0][0]),
          pubkey: bytesToHex(tlv[2][0]),
          kind: uint32be(tlv[3][0]),
          relays: (tlv[1] || []).map(utf8Decode)
        }
      }
    }
    throw new Error("unsupported prefix: " + type)
  }
  const encodeBytes = (hrp, bytes) => bech32Encode(hrp, convertBits(Array.from(bytes), 8, 5, true))
  const npubEncode = hex => encodeBytes("npub", hexToBytes(hex))
  const noteEncode = hex => neventEncode({ id: hex })
  // nostr-tools' encodeTLV emits types in reversed order (3,2,1,0); match it so
  // our encoded strings are byte-identical to the library's.
  function neventEncode(p) {
    const entries = []
    if (p.kind != null) entries.push([3, be32(p.kind)])
    if (p.author) entries.push([2, hexToBytes(p.author)])
    for (const r of p.relays || []) entries.push([1, utf8Encode(r)])
    entries.push([0, hexToBytes(p.id)])
    return encodeBytes("nevent", encodeTLV(entries))
  }
  function naddrEncode(p) {
    const entries = [
      [3, be32(p.kind)],
      [2, hexToBytes(p.pubkey)]
    ]
    for (const r of p.relays || []) entries.push([1, utf8Encode(r)])
    entries.push([0, utf8Encode(p.identifier || "")])
    return encodeBytes("naddr", encodeTLV(entries))
  }

  const isHex64 = s => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s)
  function parseCoordinate(coord) {
    if (typeof coord !== "string") return null
    const a = coord.indexOf(":")
    const b = coord.indexOf(":", a + 1)
    if (a < 0 || b < 0) return null
    const kind = Number(coord.slice(0, a))
    const pubkey = coord.slice(a + 1, b)
    if (!Number.isInteger(kind) || !isHex64(pubkey)) return null
    return { kind, pubkey, identifier: coord.slice(b + 1) }
  }
  const formatCoordinate = c => `${c.kind}:${c.pubkey}:${c.identifier}`
  function satsFromBolt11(invoice) {
    if (typeof invoice !== "string") return null
    const s = invoice.toLowerCase().trim()
    const pos = s.lastIndexOf("1")
    if (pos < 0) return null
    const m = /^ln(?:bc|tbs?|bcrt|sb)(\d*)([munp]?)$/.exec(s.slice(0, pos))
    if (!m) return null
    if (!m[1]) return 0 // amountless invoice
    const factor = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }[m[2]] ?? 1
    return Math.round(parseInt(m[1], 10) * factor * 1e8)
  }

  // Lazy loader for the signing companion (same-origin, see sw.js). Loaded
  // once, only when a napp actually signs with a throwaway key — most napps
  // never pay for it.
  let nostrCryptoModule = null
  const nostrCrypto = () => (nostrCryptoModule ||= import("/nostr-crypto.js"))

  const napp = {
    instance: window.name,
    get __popstate_last_idx() {
      return firingFrom ?? pos
    },
    action: (name, payload, options) =>
      rpc("napp.action", { name, payload, options, pointer: __pointer }),
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
    link: url => {
      window.parent.postMessage({ __nostrapps: "napp-link", url, instanceId: window.name }, "*")
    },
    // Close this window (same as the header × — keeps state for restore).
    close: () => {
      window.parent.postMessage({ __nostrapps: "napp-close", instanceId: window.name }, "*")
    },
    // A line for the launcher's logs window — a report of something the napp
    // did (a publish and each relay's answer, say), not a prompt. The launcher
    // prefixes it with the napp's id. Fire-and-forget.
    log: message => {
      rpc("napp.log", { message: String(message ?? "") }).catch(() => {})
    },
    // What the NIP-66 relay monitors say about these relays, with their place
    // in the launcher's ranking. See NAPP.md.
    relays: {
      health: urls => rpc("napp.relays.health", { urls })
    },
    // Bring these authors' events of these kinds between since and until into
    // the store from their write relays. See NAPP.md.
    sync: (authors, kinds, { since, until, limit } = {}) =>
      rpc("napp.sync", { authors, kinds, since, until, limit }),
    // A live subscription to filter (which must have authors) on each
    // author's write relays. Same opts as utils.subscribe. See NAPP.md.
    outbox: (filter, opts) => {
      const close = hostSubscription("napp.outbox", { filter }, opts)
      return { close }
    },
    // Sync, pure nostr helpers (bech32/TLV) — no rpc, no await.
    nip19: { decode: nip19Decode, npubEncode, noteEncode, neventEncode, naddrEncode },
    fx: { isHex64, parseCoordinate, formatCoordinate, satsFromBolt11 },
    // Data-loading helpers executed on the host via @nostr/gadgets.
    // Signatures match the original library functions.
    utils: {
      // ── lists ──────────────────────────────────────
      loadBlockedRelays: user => rpc("napp.loadBlockedRelays", user),
      loadBlossomServers: user => rpc("napp.loadBlossomServers", user),
      loadBookmarks: user => rpc("napp.loadBookmarks", user),
      loadDmRelays: user => rpc("napp.loadDmRelays", user),
      loadEmojis: user => rpc("napp.loadEmojis", user),
      loadFavoriteRelays: user => rpc("napp.loadFavoriteRelays", user),
      loadFollowsList: user => rpc("napp.loadFollowsList", user),
      loadMuteList: user => rpc("napp.loadMuteList", user),
      loadPins: user => rpc("napp.loadPins", user),
      loadRelayList: user => rpc("napp.loadRelayList", user),
      loadSearchRelays: user => rpc("napp.loadSearchRelays", user),
      loadWikiAuthors: user => rpc("napp.loadWikiAuthors", user),
      loadWikiRelays: user => rpc("napp.loadWikiRelays", user),
      loadFavoriteFollowSets: user => rpc("napp.loadFavoriteFollowSets", user),
      loadFavoriteScrolls: user => rpc("napp.loadFavoriteScrolls", user),
      loadProfileBadges: user => rpc("napp.loadProfileBadges", user),
      loadSimpleGroups: user => rpc("napp.loadSimpleGroups", user),
      loadGitAuthors: user => rpc("napp.loadGitAuthors", user),
      loadGitRepositories: user => rpc("napp.loadGitRepositories", user),
      loadMediaFollows: user => rpc("napp.loadMediaFollows", user),
      loadFavoritePodcasts: user => rpc("napp.loadFavoritePodcasts", user),
      loadAuthoredPodcasts: user => rpc("napp.loadAuthoredPodcasts", user),
      fetchFavoriteRelaysWithSets: user => rpc("napp.fetchFavoriteRelaysWithSets", user),
      fetchEmojisWithSets: user => rpc("napp.fetchEmojisWithSets", user),
      fetchFavoriteFollowSetsWithSets: user => rpc("napp.fetchFavoriteFollowSetsWithSets", user),
      fetchInstalledSlashCommands: user => rpc("napp.fetchInstalledSlashCommands", user),
      // ── sets ───────────────────────────────────────
      loadEmojiSets: user => rpc("napp.loadEmojiSets", user),
      loadFollowSets: user => rpc("napp.loadFollowSets", user),
      loadRelaySets: user => rpc("napp.loadRelaySets", user),
      // ── relays ──────────────────────────────────────
      loadRelayInfo: url => rpc("napp.loadRelayInfo", url),
      // a plain REQ to exactly these relays (no outbox logic); returns the closer
      subscribe,
      // ── metadata ───────────────────────────────────
      loadNostrUser: request => rpc("napp.loadNostrUser", request),
      // Local full-text search over profiles known to the launcher
      // (in-memory index, built from stored kind:0s at startup).
      searchUserLocal: term => rpc("napp.searchUserLocal", term),
      // Remote NIP-50 search for kind:0 on the user's search relays.
      searchUser: term => rpc("napp.searchUser", term),
      // What an author picker lists: an identifier's one person, else known
      // profiles ranked (follows first), relay search filling up when
      // { remote: true }; follows for "". Muted people left out.
      findAuthors: (term, opts) => rpc("napp.findAuthors", { term, ...(opts || {}) }),
      // ── event fetching ────────────────────────────
      // code: nip19 code / `nostr:` URI / bare hex id, or a decoded pointer
      // ({id,…} for nevent, {identifier,pubkey,kind,…} for naddr)
      loadEvent: (code, relays, author) => rpc("napp.loadEvent", { code, relays, author }),
      // batched by-id fetch (one REQ over the id union); invalid ids dropped
      loadEvents: ids => rpc("napp.loadEvents", ids),
      // verify an event's id + signature on the host (nostr-tools verifyEvent)
      verifyEvent: event => rpc("napp.verifyEvent", event),
      // ── throwaway-key signing (no rpc — runs IN this frame) ──────────
      // nostr-tools' signing, lazy-imported from the same-origin companion
      // /nostr-crypto.js (generated from @nostr/tools/pure; see sw.js). The
      // secret key never crosses the rpc boundary — the host only ever sees
      // finished signed events. For ephemeral/anonymous identities, NOT the
      // user's key. No permission prompt: the user's identity isn't involved.
      generateKey: async () => {
        const { generateSecretKey, getPublicKey, bytesToHex } = await nostrCrypto()
        const sk = generateSecretKey()
        return { sk: bytesToHex(sk), pk: getPublicKey(sk) }
      },
      signWithKey: async (event, sk) => {
        const { finalizeEvent, hexToBytes } = await nostrCrypto()
        return finalizeEvent(event, hexToBytes(sk))
      },
      // ── files ──────────────────────────────────
      // Save bytes to the user's disk. Napp iframes have no `allow-downloads`,
      // so an <a download> here is silently ignored — hand the data over and
      // the host does it, behind a permission prompt naming the file. Pass a
      // Blob to avoid copying the bytes across the frame boundary.
      saveFile: (name, data, type) => rpc("napp.saveFile", { name, data, type }),
      // ── clipboard ──────────────────────────────
      // Copy text to the user's clipboard. The sandbox has no clipboard-write
      // delegation, so navigator.clipboard rejects inside the iframe — hand
      // the text over and the host writes it, behind a permission prompt that
      // previews what is being copied.
      copyText: text => rpc("napp.copyText", { text }),
      // ── publishing ──────────────────────────────
      publish: (event, relays) => rpc("napp.publish", { event, relays })
    },
    // ── dev, with `requires: ["dev"]` ────────────────
    dev: {
      // Install (or replace) a local app from files: [{ path, data, type? }],
      // data a Blob, ArrayBuffer, typed array or string, metadata.json among
      // them. Resolves to { nappId }, or null if the user cancelled.
      installLocal: files => rpc("napp.dev.installLocal", { files })
    }
  }

  window.napp = napp
})()
