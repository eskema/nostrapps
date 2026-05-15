import * as nip19 from "@nostr/tools/nip19"

// NIP-5A:
//   root site:  <npub>.<host>                       → kind 15128
//   named site: <pubkeyB36><dTag>.<host>            → kind 35128
//     pubkeyB36 = 50-char lowercase base36 of the 32-byte pubkey
//     dTag      = 1..13 chars of [a-z0-9-]

export function resolveInput(input) {
  const s = input.trim()
  if (!s) throw new Error("empty input")

  if (/^[0-9a-f]{64}$/i.test(s)) {
    return { pubkey: s.toLowerCase() }
  }

  if (/^(npub1|nprofile1|naddr1)/i.test(s)) {
    return resolveBech32(s.toLowerCase())
  }

  if (looksLikeHostOrUrl(s)) {
    return resolveHostname(s)
  }

  throw new Error(`Unrecognized input format`)
}

function resolveBech32(s) {
  const decoded = nip19.decode(s)
  if (decoded.type === "npub") return { pubkey: decoded.data }
  if (decoded.type === "nprofile") return { pubkey: decoded.data.pubkey }
  if (decoded.type === "naddr") {
    const { pubkey, kind, identifier } = decoded.data
    if (kind === 35128) return { pubkey, kind, dTag: identifier }
    if (kind === 15128) return { pubkey, kind }
    throw new Error(`Unsupported naddr kind: ${kind}`)
  }
  throw new Error(`Unsupported bech32 type: ${decoded.type}`)
}

function looksLikeHostOrUrl(s) {
  if (/^https?:\/\//i.test(s)) return true
  if (s.includes(".") && !s.includes(" ")) return true
  return false
}

function resolveHostname(input) {
  const host = input
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase()
  const label = host.split(".")[0]
  if (!label) throw new Error(`No hostname label in "${input}"`)

  if (label.startsWith("npub1")) {
    const decoded = nip19.decode(label)
    if (decoded.type !== "npub") {
      throw new Error(`Expected npub label, got ${decoded.type}`)
    }
    return { pubkey: decoded.data, kind: 15128 }
  }

  // <50 base36 chars><1..13 chars [a-z0-9-]>
  const m = label.match(/^([0-9a-z]{50})([a-z0-9-]{1,13})$/)
  if (m) {
    return {
      pubkey: pubkeyB36ToHex(m[1]),
      kind: 35128,
      dTag: m[2]
    }
  }

  throw new Error(`Hostname "${label}" is not a NIP-5A label`)
}

function pubkeyB36ToHex(s) {
  let n = 0n
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    let v
    if (c >= 48 && c <= 57)
      v = c - 48 // 0-9
    else if (c >= 97 && c <= 122)
      v = c - 87 // a-z = 10..35
    else throw new Error(`Bad base36 char: ${ch}`)
    n = n * 36n + BigInt(v)
  }
  const hex = n.toString(16)
  if (hex.length > 64) {
    throw new Error("base36 pubkey overflows 32 bytes")
  }
  return hex.padStart(64, "0")
}
