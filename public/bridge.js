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

  // The NIP-5D window.napplet surface lives in its own file (napplet-bridge.js),
  // injected alongside this one; bridge.js owns only the napp surface below.
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
      case "napp-nav": {
        // The launcher can't drive a cross-origin frame's history, so it asks
        // us (running inside the napp) to do it. reload() reloads the CURRENT
        // location (client-side route included), not the original src.
        if (data.dir === "back") history.back()
        else if (data.dir === "forward") history.forward()
        else if (data.dir === "reload") location.reload()
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
    } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
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
      return { type, data: { pubkey: bytesToHex(tlv[0][0]), relays: (tlv[1] || []).map(utf8Decode) } }
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
  const noteEncode = hex => encodeBytes("note", hexToBytes(hex))
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
    feeds: {
      profile: (pubkey, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.profile", { pubkey, kinds, since, until, limit }, callback),
      following: (source, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.following", { source, kinds, since, until, limit }, callback),
      inbox: (pubkey, kinds, callback, { since, until, limit } = {}) =>
        feedRpc("napp.feeds.inbox", { pubkey, kinds, since, until, limit }, callback)
    },
    // Sync, pure nostr helpers (bech32/TLV) — no rpc, no await.
    nip19: { decode: nip19Decode, npubEncode, noteEncode, neventEncode, naddrEncode },
    fx: { isHex64, parseCoordinate, formatCoordinate, satsFromBolt11 },
    // Data-loading helpers executed on the host via @nostr/gadgets.
    // Signatures match the original library functions.
    utils: {
      // ── lists ──────────────────────────────────────
      loadBlossomServers: user => rpc("napp.loadBlossomServers", user),
      loadBookmarks: user => rpc("napp.loadBookmarks", user),
      loadEmojis: user => rpc("napp.loadEmojis", user),
      loadFavoriteRelays: user => rpc("napp.loadFavoriteRelays", user),
      loadFollowsList: user => rpc("napp.loadFollowsList", user),
      loadMuteList: user => rpc("napp.loadMuteList", user),
      loadPins: user => rpc("napp.loadPins", user),
      loadRelayList: user => rpc("napp.loadRelayList", user),
      loadWikiAuthors: user => rpc("napp.loadWikiAuthors", user),
      loadWikiRelays: user => rpc("napp.loadWikiRelays", user),
      // ── sets ───────────────────────────────────────
      loadEmojiSets: user => rpc("napp.loadEmojiSets", user),
      loadFollowSets: user => rpc("napp.loadFollowSets", user),
      loadRelaySets: user => rpc("napp.loadRelaySets", user),
      // ── relays ──────────────────────────────────────
      loadRelayInfo: url => rpc("napp.loadRelayInfo", url),
      // ── metadata ───────────────────────────────────
      loadNostrUser: request => rpc("napp.loadNostrUser", request),
      // ── event fetching ────────────────────────────
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
    }
  }

  window.napp = napp

})()
