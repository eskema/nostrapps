import { RedEventStore } from '@nostr/gadgets/redstore';

let instance;

function getStore() {
  if (!instance) instance = new RedEventStore(null);
  return instance;
}

// Vite HMR: when this module reloads, the old RedEventStore worker still
// holds the OPFS access handle. Dispose it so the new instance can reopen
// the SQLite file. Without this, dev-mode HMR makes every nostrdb.* call
// hang behind a NoModificationAllowedError on the locked file.
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    const old = instance;
    instance = null;
    if (!old) return;
    try {
      await old.close();
    } catch {}
    try {
      old.worker?.terminate?.();
    } catch {}
  });
}

export async function add(event) {
  return getStore().saveEvent(event);
}

export async function query(filters) {
  const list = Array.isArray(filters) ? filters : [filters];
  const batches = await Promise.all(list.map((f) => getStore().queryEvents(f)));
  const seen = new Map();
  for (const batch of batches) {
    for (const e of batch) seen.set(e.id, e);
  }
  return [...seen.values()];
}

export async function count(filters) {
  const events = await query(filters);
  return events.length;
}

export async function event(id) {
  const [e] = await getStore().queryEvents({ ids: [id], limit: 1 });
  return e;
}

export async function replaceable(kind, author, identifier) {
  const [result] = await getStore().loadReplaceables([[kind, author, identifier]]);
  if (!result) return undefined;
  const value = result[1];
  if (Array.isArray(value)) {
    return value.sort((a, b) => b.created_at - a.created_at)[0];
  }
  return value;
}
