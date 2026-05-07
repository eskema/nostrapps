import { pool } from '@nostr/gadgets/global';
import { guessMime } from './mime.js';
import { outboxFilterRelayBatch } from '@nostr/gadgets/outbox';
import { loadBlossomServers } from '@nostr/gadgets/lists';

const NSITE_FILE_KIND = 34128;   // legacy: one event per file (d = path)
const NSITE_ROOT_KIND = 15128;   // NIP-5A: root manifest (replaceable)
const NSITE_NAMED_KIND = 35128;  // NIP-5A: named manifest (parameterized)

export async function fetchNsite(target, onProgress = () => {}) {
  const t = typeof target === 'string' ? { pubkey: target } : target;
  const { pubkey, kind, dTag } = t;
  if (!pubkey) throw new Error('fetchNsite: no pubkey');

  if (kind === NSITE_NAMED_KIND) {
    if (!dTag) throw new Error('Named nsite requires d-tag');
    return fetchNamedManifest(pubkey, dTag, onProgress);
  }

  return fetchRootOrLegacy(pubkey, onProgress);
}

async function fetchRootOrLegacy(pubkey, onProgress) {
  onProgress('Querying relays for nsite events…');
  // include kind 0 so we can extract a friendly title without an extra round-trip
  const reqs = await outboxFilterRelayBatch([pubkey], {
    kinds: [NSITE_ROOT_KIND, NSITE_FILE_KIND, 0],
  });
  const events = await collect(reqs, 'nsite');

  const manifest = latestOfKind(events, NSITE_ROOT_KIND);
  if (manifest) {
    return fetchFromManifest(pubkey, manifest, onProgress, null, events);
  }

  const fileEvents = events.filter((e) => e.kind === NSITE_FILE_KIND);
  if (fileEvents.length) {
    return fetchFromFileEvents(pubkey, fileEvents, onProgress, events);
  }
  throw new Error('No nsite manifest or file events found for this pubkey');
}

async function fetchNamedManifest(pubkey, dTag, onProgress) {
  onProgress(`Querying relays for named nsite "${dTag}"…`);
  const reqs = await outboxFilterRelayBatch([pubkey], {
    kinds: [NSITE_NAMED_KIND],
    '#d': [dTag],
  });
  const events = await collect(reqs, 'nsite-named');
  const manifest = latestOfKind(events, NSITE_NAMED_KIND, dTag);
  if (!manifest) throw new Error(`Named nsite "${dTag}" not found`);
  const nappId = `${pubkey.slice(0, 40)}-${dTag}`;
  return fetchFromManifest(pubkey, manifest, onProgress, nappId);
}

function collect(reqs, label) {
  const events = [];
  return new Promise((resolve, reject) => {
    pool.subscribeMap(reqs, {
      label,
      onevent(e) { events.push(e); },
      oneose: () => resolve(events),
      onerror: reject,
    });
  });
}

function latestOfKind(events, kind, dTag = null) {
  let best = null;
  for (const e of events) {
    if (e.kind !== kind) continue;
    if (dTag !== null && getTag(e, 'd') !== dTag) continue;
    if (!best || e.created_at > best.created_at) best = e;
  }
  return best;
}

async function fetchFromManifest(
  pubkey,
  manifest,
  onProgress,
  nappIdOverride,
  extraEvents = [],
) {
  const paths = manifest.tags.filter(
    (t) => t[0] === 'path' && t.length >= 3 && t[1] && t[2],
  );
  if (paths.length === 0) {
    throw new Error('Nsite manifest has no path tags');
  }

  const manifestServers = manifest.tags
    .filter((t) => t[0] === 'server' && t[1])
    .map((t) => t[1]);
  const userServers = (await loadBlossomServers(pubkey)).items ?? [];
  const servers = dedupe([...manifestServers, ...userServers]);

  const out = [];
  let i = 0;
  for (const tag of paths) {
    i++;
    const path = normalizePath(tag[1]);
    if (!path) continue;
    const sha = tag[2];
    const mime = tag[3] || guessMime(path);
    onProgress(`Fetching ${i}/${paths.length}: ${path}`);
    const blob = await fetchBlob(servers, sha);
    if (!blob) throw new Error(`Could not fetch ${path} (${sha})`);
    out.push({ path, body: blob, mime });
  }

  const nappId = nappIdOverride ?? pubkey.slice(0, 40);
  const title =
    getTag(manifest, 'title') ||
    findProfileName(extraEvents, pubkey) ||
    (await fetchProfileName(pubkey));
  return { nappId, files: out, title, manifest };
}

async function fetchFromFileEvents(pubkey, fileEvents, onProgress, extraEvents = []) {
  const servers = (await loadBlossomServers(pubkey)).items ?? [];
  const byPath = latestByPath(fileEvents);
  if (byPath.size === 0) {
    throw new Error('No nsite files found for this pubkey');
  }
  const out = [];
  let i = 0;
  for (const [path, evt] of byPath) {
    i++;
    onProgress(`Fetching ${i}/${byPath.size}: ${path}`);
    const sha = getTag(evt, 'x') || getTag(evt, 'sha256');
    if (!sha) continue;
    const mime = getTag(evt, 'm') || guessMime(path);
    const blob = await fetchBlob(servers, sha);
    if (!blob) throw new Error(`Could not fetch ${path} (${sha})`);
    out.push({ path, body: blob, mime });
  }
  const title = findProfileName(extraEvents, pubkey);
  return { nappId: pubkey.slice(0, 40), files: out, title };
}

function findProfileName(events, pubkey) {
  let latest = null;
  for (const e of events) {
    if (e.kind !== 0 || e.pubkey !== pubkey) continue;
    if (!latest || e.created_at > latest.created_at) latest = e;
  }
  if (!latest) return null;
  try {
    const meta = JSON.parse(latest.content);
    return meta.display_name || meta.displayName || meta.name || null;
  } catch {
    return null;
  }
}

async function fetchProfileName(pubkey) {
  try {
    const reqs = await outboxFilterRelayBatch([pubkey], { kinds: [0] });
    const events = await collect(reqs, 'nsite-profile');
    return findProfileName(events, pubkey);
  } catch {
    return null;
  }
}

function latestByPath(events) {
  const map = new Map();
  for (const evt of events) {
    const path = normalizePath(getTag(evt, 'd'));
    if (!path) continue;
    const prev = map.get(path);
    if (!prev || evt.created_at > prev.created_at) map.set(path, evt);
  }
  return map;
}

function normalizePath(p) {
  if (!p) return null;
  return p.startsWith('/') ? p : `/${p}`;
}

function getTag(evt, name) {
  const t = evt.tags.find((x) => x[0] === name);
  return t?.[1];
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

async function fetchBlob(servers, sha) {
  for (const server of servers) {
    try {
      const base = server.endsWith('/') ? server.slice(0, -1) : server;
      const res = await fetch(`${base}/${sha}`);
      if (res.ok) return await res.blob();
    } catch {
      // try next server
    }
  }
  return null;
}
