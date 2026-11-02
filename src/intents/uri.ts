// @ts-nocheck
// NAP-INTENT URI normalizer from @kehto/shell 0.25.0 (MIT).
// Kept self-contained so the host and injected bridge use exactly the same parser.
export function createIntentUriNormalizer() {
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
  const fail = message => {
    throw new TypeError(message)
  }
  const decode = (value, label) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return fail(`Intent URI has malformed percent-encoding in ${label}`)
    }
  }
  const decodeUtf8 = bytes => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
    } catch {
      return fail("Intent URI fragment contains invalid UTF-8")
    }
  }
  const decodeHint = fragment => {
    if (!fragment.startsWith("naddr") || fragment !== fragment.toLowerCase()) {
      return fail("Intent URI fragment must be a bare lowercase naddr")
    }
    const separator = fragment.lastIndexOf("1")
    if (separator <= 0 || separator + 7 > fragment.length)
      fail("Intent URI fragment is not a valid naddr")
    const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    const values = []
    for (const character of fragment.slice(separator + 1)) {
      const value = alphabet.indexOf(character)
      if (value < 0) fail("Intent URI fragment is not a valid naddr")
      values.push(value)
    }
    const polymod = input => {
      let checksum = 1
      for (const value of input) {
        const top = checksum >>> 25
        checksum = ((checksum & 33554431) << 5) ^ value
        if (top & 1) checksum ^= 996825010
        if (top & 2) checksum ^= 642813549
        if (top & 4) checksum ^= 513874426
        if (top & 8) checksum ^= 1027748829
        if (top & 16) checksum ^= 705979059
      }
      return checksum
    }
    const hrp = fragment.slice(0, separator)
    const hrpValues = [...hrp]
      .map(character => character.charCodeAt(0) >>> 5)
      .concat(
        [0],
        [...hrp].map(character => character.charCodeAt(0) & 31)
      )
    if (hrp !== "naddr" || polymod(hrpValues.concat(values)) !== 1)
      fail("Intent URI fragment is not a valid naddr")
    const words = values.slice(0, -6)
    const bytes = []
    let accumulator = 0
    let bits = 0
    for (const word of words) {
      accumulator = (accumulator << 5) | word
      bits += 5
      while (bits >= 8) {
        bits -= 8
        bytes.push((accumulator >>> bits) & 255)
      }
    }
    if (bits >= 5 || ((accumulator << (8 - bits)) & 255) !== 0)
      fail("Intent URI fragment is not a valid naddr")
    let index = 0
    let identifier
    let pubkey
    let kind
    const relays = []
    while (index < bytes.length) {
      if (index + 2 > bytes.length) fail("Intent URI fragment is not a valid naddr")
      const type = bytes[index++]
      const length = bytes[index++]
      if (index + length > bytes.length) fail("Intent URI fragment is not a valid naddr")
      const value = bytes.slice(index, index + length)
      index += length
      if (type === 0) {
        if (identifier !== void 0) fail("Intent URI fragment repeats its identifier")
        identifier = decodeUtf8(value)
      } else if (type === 1) {
        const relay = decodeUtf8(value)
        if (!relay) fail("Intent URI fragment has an empty relay hint")
        relays.push(relay)
      } else if (type === 2) {
        if (pubkey !== void 0 || value.length !== 32)
          fail("Intent URI fragment has an invalid pubkey")
        pubkey = value.map(part => part.toString(16).padStart(2, "0")).join("")
      } else if (type === 3) {
        if (kind !== void 0 || value.length !== 4) fail("Intent URI fragment has an invalid kind")
        kind = (((value[0] << 24) >>> 0) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0
      } else {
        fail("Intent URI fragment has unsupported naddr data")
      }
    }
    if (!identifier || !pubkey || kind !== 35129)
      fail("Intent URI fragment must recommend a named 35129 napplet")
    return { address: `${kind}:${pubkey}:${identifier}`, ...(relays.length > 0 ? { relays } : {}) }
  }
  const normalizeHint = value => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("Intent handlerHint must be an object")
    const hint = value
    if (Object.keys(hint).some(key => key !== "address" && key !== "relays"))
      fail("Intent handlerHint contains unsupported fields")
    const address = hint.address
    if (typeof address !== "string" || !/^35129:[0-9a-f]{64}:.+$/u.test(address)) {
      fail("Intent handlerHint address must be a named 35129 coordinate")
    }
    const relays = hint.relays
    if (
      relays !== void 0 &&
      (!Array.isArray(relays) ||
        relays.some(relay => typeof relay !== "string" || relay.length === 0))
    ) {
      fail("Intent handlerHint relays must be non-empty text")
    }
    return { address, ...(relays === void 0 ? {} : { relays: [...relays] }) }
  }
  return function normalizeIntentUri2(uri, options) {
    if (typeof uri !== "string") throw new TypeError("Intent URI must be text")
    const match = /^napplet:([^/?#\s]+)\/([^/?#\s]+)(?:\?([^#]*))?(?:#(.*))?$/u.exec(uri)
    if (match === null) return fail("Intent URI must be napplet:<archetype>/<action>")
    const archetype = match[1]
    const action = match[2]
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(archetype) || !/^[a-z0-9][a-z0-9-]*$/u.test(action)) {
      fail("Intent URI archetype and action must be lowercase slugs")
    }
    const query = match[3]
    const fragment = match[4]
    const supplied = options === void 0 ? {} : options
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      fail("Intent options must be an object")
    const parsedOptions = supplied
    if (
      Object.keys(parsedOptions).some(
        key => key !== "payload" && key !== "handler" && key !== "handlerHint" && key !== "behavior"
      )
    ) {
      fail("Intent options contain unsupported fields")
    }
    const handler = parsedOptions.handler
    if (handler !== void 0 && (typeof handler !== "string" || handler.length === 0)) {
      fail("Intent handler must be non-empty text")
    }
    let behavior
    if (parsedOptions.behavior !== void 0) {
      if (
        !parsedOptions.behavior ||
        typeof parsedOptions.behavior !== "object" ||
        Array.isArray(parsedOptions.behavior)
      )
        fail("Intent behavior must be an object")
      const value = parsedOptions.behavior
      if (
        Object.keys(value).some(key => key !== "focus" && key !== "reuse") ||
        (hasOwn(value, "focus") && typeof value.focus !== "boolean") ||
        (hasOwn(value, "reuse") && typeof value.reuse !== "boolean")
      )
        fail("Intent behavior contains unsupported fields")
      behavior = {
        ...(hasOwn(value, "focus") ? { focus: value.focus } : {}),
        ...(hasOwn(value, "reuse") ? { reuse: value.reuse } : {})
      }
    }
    let payload
    if (query !== void 0) {
      if (hasOwn(parsedOptions, "payload"))
        fail("Intent URI query cannot accompany options.payload")
      if (query.length > 0) {
        const fields = /* @__PURE__ */ Object.create(null)
        for (const field of query.split("&")) {
          const equal = field.indexOf("=")
          if (equal <= 0 || field.indexOf("=", equal + 1) >= 0)
            fail("Intent URI query fields must be name=value")
          const name = decode(field.slice(0, equal), "a query name")
          const value = decode(field.slice(equal + 1), "a query value")
          if (!name || hasOwn(fields, name))
            fail("Intent URI query names must be unique after decoding")
          Object.defineProperty(fields, name, {
            value,
            enumerable: true,
            writable: true,
            configurable: true
          })
        }
        payload = fields
      }
    } else if (hasOwn(parsedOptions, "payload")) {
      payload = parsedOptions.payload
    }
    if (fragment !== void 0) {
      if (!fragment) fail("Intent URI fragment must be a bare naddr")
      if (parsedOptions.handlerHint !== void 0)
        fail("Intent URI fragment cannot accompany options.handlerHint")
    }
    const handlerHint =
      fragment === void 0
        ? parsedOptions.handlerHint === void 0
          ? void 0
          : normalizeHint(parsedOptions.handlerHint)
        : decodeHint(fragment)
    return {
      archetype,
      action,
      convention: `napplet:${archetype}/${action}`,
      ...(payload === void 0 ? {} : { payload }),
      ...(handlerHint === void 0 ? {} : { handlerHint }),
      ...(handler === void 0 ? {} : { handler }),
      ...(behavior === void 0 ? {} : { behavior })
    }
  }
}

export const normalizeIntentUri = createIntentUriNormalizer()
