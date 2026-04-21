const KEY = 'nostrapps:pubkey';
const listeners = new Set();

export function getPubkey() {
  return localStorage.getItem(KEY);
}

export function setPubkey(pk) {
  localStorage.setItem(KEY, pk);
  for (const fn of listeners) fn(pk);
}

export function clearPubkey() {
  localStorage.removeItem(KEY);
  for (const fn of listeners) fn(null);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
