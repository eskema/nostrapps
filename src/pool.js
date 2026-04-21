import { SimplePool } from 'nostr-tools/pool';

const STORAGE_KEY = 'nostrapps:relays';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

function loadPersisted() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '');
    if (Array.isArray(saved) && saved.every((r) => typeof r === 'string')) {
      return saved;
    }
  } catch {
    // fall through
  }
  return [...DEFAULT_RELAYS];
}

function savePersisted(relays) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(relays));
  } catch {
    // ignore
  }
}

let poolInstance = null;
let currentRelays = loadPersisted();

export function getPool() {
  if (!poolInstance) poolInstance = new SimplePool();
  return poolInstance;
}

export function getRelays() {
  return [...currentRelays];
}

export function setRelays(relays) {
  const next =
    Array.isArray(relays) && relays.length
      ? [...new Set(relays.filter((r) => typeof r === 'string'))]
      : [...DEFAULT_RELAYS];
  currentRelays = next;
  savePersisted(currentRelays);
  return [...currentRelays];
}

export async function query(filters, opts = {}) {
  const pool = getPool();
  const relays = opts.relays && opts.relays.length ? opts.relays : currentRelays;
  const list = Array.isArray(filters) ? filters : [filters];
  const batches = await Promise.all(
    list.map((filter) =>
      pool.querySync(relays, filter, { maxWait: opts.maxWait ?? 5000 }),
    ),
  );
  return dedupeById(batches.flat());
}

export async function publish(event, opts = {}) {
  const pool = getPool();
  const relays = opts.relays && opts.relays.length ? opts.relays : currentRelays;
  const results = await Promise.allSettled(pool.publish(relays, event));
  return results.map((r, i) => ({
    relay: relays[i],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : undefined,
  }));
}

function dedupeById(events) {
  const seen = new Map();
  for (const e of events) seen.set(e.id, e);
  return [...seen.values()];
}
