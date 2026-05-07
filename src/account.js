const PUBKEY_KEY = 'nostrapps:pubkey';
const TYPE_KEY = 'nostrapps:signerType'; // 'nip07' | 'nip46'
const listeners = new Set();

export function getPubkey() {
  return localStorage.getItem(PUBKEY_KEY);
}

export function getType() {
  return localStorage.getItem(TYPE_KEY) || null;
}

export function setAccount(pk, type) {
  if (pk) localStorage.setItem(PUBKEY_KEY, pk);
  else localStorage.removeItem(PUBKEY_KEY);
  if (type) localStorage.setItem(TYPE_KEY, type);
  else localStorage.removeItem(TYPE_KEY);
  notify();
}

// Back-compat helper used by older callers; assumes nip07 if no type known.
export function setPubkey(pk) {
  setAccount(pk, getType() || 'nip07');
}

export function clearPubkey() {
  localStorage.removeItem(PUBKEY_KEY);
  localStorage.removeItem(TYPE_KEY);
  notify();
}

function notify() {
  const pk = getPubkey();
  for (const fn of listeners) fn(pk);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
