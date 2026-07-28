const PUBKEY_KEY = "nostrapps:pubkey"
const TYPE_KEY = "nostrapps:signerType" // 'nip07' | 'nip46'
const listeners = new Set<(pk: string | null) => void>()

export function getPubkey() {
  return localStorage.getItem(PUBKEY_KEY)
}

export function getType() {
  return localStorage.getItem(TYPE_KEY) || null
}

export function setAccount(pk: string | null, type: string | null) {
  if (pk) localStorage.setItem(PUBKEY_KEY, pk)
  else localStorage.removeItem(PUBKEY_KEY)
  if (type) localStorage.setItem(TYPE_KEY, type)
  else localStorage.removeItem(TYPE_KEY)
  notify()
}

// Back-compat helper used by older callers; assumes nip07 if no type known.
export function setPubkey(pk: string | null) {
  setAccount(pk, getType() || "nip07")
}

export function clearPubkey() {
  localStorage.removeItem(PUBKEY_KEY)
  localStorage.removeItem(TYPE_KEY)
  inflightPubkey = null
  notify()
}

// Return the account pubkey, hitting the underlying signer only when we don't
// already have it. A single in-flight fetch is shared, so a burst of
// getPublicKey() calls (e.g. a napp asking repeatedly on load) can't fan out
// into multiple signer round-trips — and multiple extension/bunker prompts.
// The result is persisted, so every later call and every reload returns it
// instantly with no prompt.
let inflightPubkey: Promise<string> | null = null
export function cachedPublicKey(fetchFromSigner: () => Promise<string>): Promise<string> {
  const cached = getPubkey()
  if (cached) return Promise.resolve(cached)
  if (inflightPubkey) return inflightPubkey
  inflightPubkey = (async () => {
    try {
      const pk = await fetchFromSigner()
      setPubkey(pk)
      return pk
    } finally {
      inflightPubkey = null
    }
  })()
  return inflightPubkey
}

function notify() {
  const pk = getPubkey()
  for (const fn of listeners) fn(pk)
}

export function subscribe(fn: (pk: string | null) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
