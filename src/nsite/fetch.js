import { query as poolQuery } from '../pool.js';
import { guessMime } from './mime.js';

const NSITE_KIND = 34128;
const SERVER_LIST_KIND = 10063;

const DEFAULT_BLOSSOM_SERVERS = [
  'https://cdn.satellite.earth',
  'https://blossom.primal.net',
];

export async function fetchNsite(pubkey, onProgress = () => {}) {
  onProgress('Querying relays for nsite events…');
  const [fileEvents, serverEvents] = await Promise.all([
    poolQuery({ kinds: [NSITE_KIND], authors: [pubkey] }),
    poolQuery({ kinds: [SERVER_LIST_KIND], authors: [pubkey] }),
  ]);

  const servers = pickServers(serverEvents);
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

  return { nappId: pubkey.slice(0, 40), files: out };
}

function pickServers(events) {
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  const out = [];
  if (latest) {
    for (const tag of latest.tags) {
      if (tag[0] === 'server' && tag[1]) {
        out.push(tag[1].replace(/\/+$/, ''));
      }
    }
  }
  if (out.length === 0) out.push(...DEFAULT_BLOSSOM_SERVERS);
  return out;
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
