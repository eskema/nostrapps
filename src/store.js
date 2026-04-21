import { RedEventStore } from '@nostr/gadgets/redstore';

let instance;

function getStore() {
  if (!instance) instance = new RedEventStore(null);
  return instance;
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
