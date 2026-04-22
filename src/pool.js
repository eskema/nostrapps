import { pool } from "@nostr/gadgets/global";

export async function query(filters, opts = {}) {
  const list = Array.isArray(filters) ? filters : [filters];
  const batches = await Promise.all(
    list.map((filter) =>
      pool.querySync(opts.relays, filter, { maxWait: opts.maxWait ?? 5000 }),
    ),
  );
  return dedupeById(batches.flat());
}

export async function publish(event, opts = {}) {
  const results = await Promise.allSettled(pool.publish(opts.relays, event));
  return results.map((r, i) => ({
    relay: opts.relays[i],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : undefined,
  }));
}

function dedupeById(events) {
  const seen = new Map();
  for (const e of events) seen.set(e.id, e);
  return [...seen.values()];
}
