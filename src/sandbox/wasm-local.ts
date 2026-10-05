// The napp_call methods a wasm napp gets answered without a round trip: the
// ones bridge.js answers inside a web napp's own page (nip19, fx, throwaway-key
// signing), restated here because a wasm napp has no page for them to run in.
// Same names, same params, same shapes as window.napp.nip19 / .fx / .utils.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { decode, naddrEncode, neventEncode, noteEncode, npubEncode } from "@nostr/tools/nip19"
import { finalizeEvent, generateSecretKey, getPublicKey } from "@nostr/tools/pure"
import { isHex64 } from "../utils.js"

type Local = (params: any) => unknown

export const WASM_LOCAL_METHODS: Record<string, Local> = {
  "nip19.decode": (code: unknown) => {
    const { type, data } = decode(stringParam(code))
    // nsec decodes to bytes, which JSON would turn into an object of indexes;
    // bridge.js hands it out as hex.
    return { type, data: data instanceof Uint8Array ? bytesToHex(data) : data }
  },
  "nip19.npubEncode": (hex: unknown) => npubEncode(hexParam(hex)),
  "nip19.noteEncode": (hex: unknown) => neventEncode({id: hexParam(hex) }),
  "nip19.neventEncode": (p: any) =>
    neventEncode({
      id: hexParam(p?.id),
      relays: stringList(p?.relays),
      author: p?.author ? hexParam(p.author) : undefined,
      kind: Number.isInteger(p?.kind) ? p.kind : undefined
    }),
  "nip19.naddrEncode": (p: any) => {
    if (!Number.isInteger(p?.kind)) throw new Error("naddrEncode: kind must be an integer")
    return naddrEncode({
      identifier: typeof p.identifier === "string" ? p.identifier : "",
      pubkey: hexParam(p.pubkey),
      kind: p.kind,
      relays: stringList(p.relays)
    })
  },

  "fx.isHex64": (s: unknown) => isHex64(s),
  "fx.parseCoordinate": (s: unknown) => parseCoordinate(s),
  "fx.formatCoordinate": (c: any) => `${c?.kind}:${c?.pubkey}:${c?.identifier ?? ""}`,
  "fx.satsFromBolt11": (s: unknown) => satsFromBolt11(s),

  // The key never leaves the napp and the launcher: no prompt, because the
  // user's identity isn't involved.
  "napp.generateKey": () => {
    const sk = generateSecretKey()
    return { sk: bytesToHex(sk), pk: getPublicKey(sk) }
  },
  "napp.signWithKey": (p: any) => {
    if (!p?.event || typeof p.event !== "object") throw new Error("signWithKey: no event")
    return finalizeEvent(p.event, hexToBytes(hexParam(p.sk)))
  }
}

function stringParam(v: unknown): string {
  if (typeof v !== "string") throw new Error("params must be a string")
  return v
}

function hexParam(v: unknown): string {
  if (!isHex64(v)) throw new Error("invalid hex")
  return v.toLowerCase()
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function parseCoordinate(coord: unknown) {
  if (typeof coord !== "string") return null
  const a = coord.indexOf(":")
  const b = coord.indexOf(":", a + 1)
  if (a < 0 || b < 0) return null
  const kind = Number(coord.slice(0, a))
  const pubkey = coord.slice(a + 1, b)
  if (!Number.isInteger(kind) || !isHex64(pubkey)) return null
  return { kind, pubkey, identifier: coord.slice(b + 1) }
}

function satsFromBolt11(invoice: unknown): number | null {
  if (typeof invoice !== "string") return null
  const s = invoice.toLowerCase().trim()
  const pos = s.lastIndexOf("1")
  if (pos < 0) return null
  const m = /^ln(?:bc|tbs?|bcrt|sb)(\d*)([munp]?)$/.exec(s.slice(0, pos))
  if (!m) return null
  if (!m[1]) return 0 // amountless invoice
  const factor = ({ m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 } as Record<string, number>)[m[2]] ?? 1
  return Math.round(parseInt(m[1], 10) * factor * 1e8)
}
