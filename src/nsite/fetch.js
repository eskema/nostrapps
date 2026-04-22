import { pool } from "@nostr/gadgets/global";
import { guessMime } from "./mime.js";
import { outboxFilterRelayBatch } from "@nostr/gadgets/outbox";
import { loadBlossomServers } from "@nostr/gadgets/lists";

const NSITE_KIND = 34128;

export async function fetchNsite(pubkey, onProgress = () => {}) {
  onProgress("Querying relays for nsite events…");
  const reqs = await outboxFilterRelayBatch([pubkey], { kinds: [NSITE_KIND] });

  let fileEvents = []
  await new Promise((resolve, reject) => {
    const subc = pool.subscribeMap(reqs, { label: "nsite" ,
onevent(evt) {fileEvents.push(evt)},
oneose: resolve,
onerror: reject,
});
})

  const servers = await loadBlossomServers(pubkey)
  const byPath = latestByPath(fileEvents);
  if (byPath.size === 0) {
    throw new Error("No nsite files found for this pubkey");
  }

  const out = [];
  let i = 0;
  for (const [path, evt] of byPath) {
    i++;
    onProgress(`Fetching ${i}/${byPath.size}: ${path}`);
    const sha = getTag(evt, "x") || getTag(evt, "sha256");
    if (!sha) continue;
    const mime = getTag(evt, "m") || guessMime(path);
    const blob = await fetchBlob(servers.items, sha);
    if (!blob) throw new Error(`Could not fetch ${path} (${sha})`);
    out.push({ path, body: blob, mime });
  }

  return { nappId: pubkey.slice(0, 40), files: out };
}

function latestByPath(events) {
  const map = new Map();
  for (const evt of events) {
    const path = normalizePath(getTag(evt, "d"));
    if (!path) continue;
    const prev = map.get(path);
    if (!prev || evt.created_at > prev.created_at) map.set(path, evt);
  }
  return map;
}

function normalizePath(p) {
  if (!p) return null;
  return p.startsWith("/") ? p : `/${p}`;
}

function getTag(evt, name) {
  const t = evt.tags.find((x) => x[0] === name);
  return t?.[1];
}

async function fetchBlob(servers, sha) {
  for (const server of servers) {
    try {
      const res = await fetch(`${server}/${sha}`);
      if (res.ok) return await res.blob();
    } catch {
      // try next server
    }
  }
  return null;
}
