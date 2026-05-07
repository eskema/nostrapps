import { loadRelayList } from '@nostr/gadgets/lists';
import { loadNostrUser } from '@nostr/gadgets/metadata';
import { npubEncode, naddrEncode } from '@nostr/tools/nip19';
import * as pool from '../pool.js';

export const id = 'store';
export const title = 'Store';
export const slash = '/store';

const NSITE_ROOT = 15128;
const NSITE_NAMED = 35128;
const CACHE_KEY = 'nostrapps:store:cache';
const RELAYS_KEY = 'nostrapps:store:relays';
const CACHE_LIMIT = 500;

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export function mount(container, ctx) {
  let events = readCache();
  let filter = '';
  let filterMode = 'all'; // 'all' | 'installed' | 'past'
  let refreshing = false;
  let cancelled = false;

  container.innerHTML = `
    <div class="store-panel">
      <div class="store-toolbar">
        <input class="store-search" type="search" placeholder="Search title, description, npub…" />
        <button type="button" class="store-refresh" title="Refresh">↻</button>
        <button type="button" class="store-relays-toggle" title="Configure relays">⚙</button>
      </div>
      <div class="store-relays" hidden>
        <label class="store-relays-label">Relays (one per line — leave empty to use your kind 10002, or fall back to defaults)</label>
        <textarea class="store-relays-input" rows="4" spellcheck="false"></textarea>
        <div class="store-relays-actions">
          <button type="button" class="store-relays-save">save &amp; refresh</button>
          <button type="button" class="store-relays-clear">clear</button>
        </div>
      </div>
      <div class="store-filters" role="group" aria-label="Filter">
        <button type="button" data-filter="all" class="active">all</button>
        <button type="button" data-filter="installed">installed</button>
      </div>
      <div class="store-status" hidden></div>
      <div class="store-list"></div>
    </div>
  `;

  const searchEl = container.querySelector('.store-search');
  const refreshBtn = container.querySelector('.store-refresh');
  const relaysToggleBtn = container.querySelector('.store-relays-toggle');
  const relaysPanel = container.querySelector('.store-relays');
  const relaysInput = container.querySelector('.store-relays-input');
  const relaysSaveBtn = container.querySelector('.store-relays-save');
  const relaysClearBtn = container.querySelector('.store-relays-clear');
  const statusEl = container.querySelector('.store-status');
  const listEl = container.querySelector('.store-list');
  const filterBtns = container.querySelectorAll('.store-filters button');

  relaysInput.value = readCustomRelays().join('\n');

  function setStatus(msg) {
    statusEl.textContent = msg || '';
    statusEl.hidden = !msg;
  }

  function renderList() {
    listEl.innerHTML = '';
    const filtered = events
      .filter((e) => matchesFilter(e, filter))
      .sort((a, b) => b.created_at - a.created_at);

    let displayed = [];

    if (filterMode === 'installed') {
      const installed = [];
      const past = [];
      for (const e of filtered) {
        const nid = computeNappId(e);
        if (ctx.isInstalled?.(nid)) installed.push(e);
        else if (ctx.wasInstalled?.(nid)) past.push(e);
      }

      if (installed.length === 0 && past.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'store-empty';
        empty.textContent = 'No installed nsites.';
        listEl.appendChild(empty);
        return;
      }

      if (installed.length > 0) {
        for (const evt of installed)
          listEl.appendChild(renderCard(evt, ctx));
      } else {
        const empty = document.createElement('div');
        empty.className = 'store-empty store-empty-thin';
        empty.textContent = 'Nothing currently installed.';
        listEl.appendChild(empty);
      }

      if (past.length > 0) {
        const heading = document.createElement('h4');
        heading.className = 'store-section-heading';
        heading.textContent = 'Previously installed';
        listEl.appendChild(heading);
        for (const evt of past) listEl.appendChild(renderCard(evt, ctx));
      }

      displayed = installed.concat(past);
    } else {
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'store-empty';
        empty.textContent =
          events.length === 0
            ? 'No nsites cached yet — tap ↻ to fetch.'
            : 'No matches.';
        listEl.appendChild(empty);
        return;
      }
      for (const evt of filtered) listEl.appendChild(renderCard(evt, ctx));
      displayed = filtered;
    }

    // Lazy-fetch profile metadata for unique authors across both sections
    const seen = new Set();
    for (const evt of displayed) {
      if (seen.has(evt.pubkey)) continue;
      seen.add(evt.pubkey);
      loadNostrUser(evt.pubkey)
        .then((user) => {
          if (cancelled) return;
          const cards = listEl.querySelectorAll(`[data-author="${evt.pubkey}"]`);
          const name = user?.shortName || user?.name || '';
          const pic = user?.image;
          for (const card of cards) {
            const nameEl = card.querySelector('.store-author-name');
            const picEl = card.querySelector('.store-author-pic');
            if (nameEl && name) nameEl.textContent = name;
            if (picEl && pic) {
              picEl.src = pic;
              picEl.hidden = false;
            }
          }
        })
        .catch(() => {});
    }
  }

  async function refresh() {
    if (refreshing || cancelled) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
    const before = events.length;
    try {
      setStatus('Resolving relays…');
      const relays = await resolveRelays(ctx);
      if (cancelled) return;
      if (!relays.length) {
        setStatus('No relays configured.');
        return;
      }
      setStatus(`Querying ${relays.length} relay(s)…`);
      const fresh = await pool.query(
        { kinds: [NSITE_ROOT, NSITE_NAMED], limit: 200 },
        { relays },
      );
      if (cancelled) return;
      events = mergeEvents(events, fresh);
      writeCache(events);
      renderList();
      const added = events.length - before;
      if (added > 0) {
        setStatus(`+${added} new — ${events.length} cached`);
      } else {
        setStatus(`Up to date — ${events.length} cached`);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('spinning');
    }
  }

  searchEl.addEventListener('input', () => {
    filter = searchEl.value.trim().toLowerCase();
    renderList();
  });

  for (const btn of filterBtns) {
    btn.addEventListener('click', () => {
      filterMode = btn.dataset.filter;
      for (const b of filterBtns)
        b.classList.toggle('active', b === btn);
      renderList();
    });
  }

  refreshBtn.addEventListener('click', refresh);

  relaysToggleBtn.addEventListener('click', () => {
    relaysPanel.hidden = !relaysPanel.hidden;
  });

  relaysSaveBtn.addEventListener('click', () => {
    const list = relaysInput.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    writeCustomRelays(list);
    relaysPanel.hidden = true;
    refresh();
  });

  relaysClearBtn.addEventListener('click', () => {
    writeCustomRelays([]);
    relaysInput.value = '';
    relaysPanel.hidden = true;
    refresh();
  });

  // Show cached results immediately, then check for updates in background
  renderList();
  if (events.length === 0) setStatus('Loading…');
  refresh();

  return {
    unmount() {
      cancelled = true;
    },
  };
}

function renderCard(evt, ctx) {
  const tag = (k) => evt.tags.find((t) => t[0] === k)?.[1] || '';
  const titleText = tag('title');
  const description = tag('description');
  const dTag = tag('d');
  const source = tag('source');
  const date = new Date(evt.created_at * 1000).toLocaleDateString();
  const pathCount = evt.tags.filter((t) => t[0] === 'path').length;
  const nappId = computeNappId(evt);
  const installed = ctx.isInstalled?.(nappId) ?? false;
  const installedManifest = installed ? ctx.installedManifest?.(nappId) : null;
  const updateAvailable =
    installed && installedManifest && installedManifest.createdAt < evt.created_at;

  const card = document.createElement('div');
  card.className = 'store-card';
  card.dataset.author = evt.pubkey;

  const head = document.createElement('div');
  head.className = 'store-card-head';

  const titles = document.createElement('div');
  titles.className = 'store-card-titles';

  const h = document.createElement('h3');
  h.className = 'store-title';
  h.textContent =
    titleText || (dTag ? `(${dTag})` : '(untitled site)');
  titles.appendChild(h);

  const meta = document.createElement('div');
  meta.className = 'store-meta';

  const author = document.createElement('span');
  author.className = 'store-author';
  const pic = document.createElement('img');
  pic.className = 'store-author-pic';
  pic.alt = '';
  pic.hidden = true;
  const name = document.createElement('span');
  name.className = 'store-author-name';
  name.textContent = evt.pubkey.slice(0, 8) + '…';
  author.append(pic, name);

  const dateEl = document.createElement('span');
  dateEl.className = 'store-date';
  dateEl.textContent = date;

  const pathsEl = document.createElement('span');
  pathsEl.className = 'store-paths';
  pathsEl.textContent = `${pathCount} file${pathCount === 1 ? '' : 's'}`;

  const kindEl = document.createElement('span');
  kindEl.className = 'store-kind';
  kindEl.textContent = evt.kind === NSITE_NAMED ? 'named' : 'root';

  meta.append(author, dateEl, pathsEl, kindEl);
  titles.appendChild(meta);

  const installBtn = document.createElement('button');
  installBtn.type = 'button';
  let installState;
  if (updateAvailable) installState = 'update';
  else if (installed) installState = 'uninstall';
  else installState = 'install';
  installBtn.className =
    installState === 'update'
      ? 'store-install update-available'
      : installState === 'uninstall'
        ? 'store-install installed'
        : 'store-install';
  installBtn.textContent = installState;

  head.append(titles, installBtn);
  card.appendChild(head);

  if (description) {
    const desc = document.createElement('p');
    desc.className = 'store-description';
    desc.textContent = description;
    card.appendChild(desc);
  }

  if (source) {
    const src = document.createElement('a');
    src.className = 'store-source';
    src.href = source;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = 'source ↗';
    card.appendChild(src);
  }

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    installBtn.textContent =
      installState === 'update'
        ? 'updating…'
        : installState === 'uninstall'
          ? 'uninstalling…'
          : 'launching…';
    try {
      if (installState === 'update') {
        await ctx.update({
          pubkey: evt.pubkey,
          kind: evt.kind,
          dTag: dTag || undefined,
        });
      } else if (installState === 'uninstall') {
        await ctx.uninstall(nappId);
      } else {
        const raw =
          evt.kind === NSITE_NAMED
            ? naddrEncode({
                pubkey: evt.pubkey,
                kind: NSITE_NAMED,
                identifier: dTag,
                relays: [],
              })
            : npubEncode(evt.pubkey);
        await ctx.launchFromInput(raw);
      }
      // Replace this card with a freshly-rendered one so the button flips.
      const replacement = renderCard(evt, ctx);
      card.replaceWith(replacement);
    } catch (err) {
      installBtn.title = err?.message || String(err);
      installBtn.textContent = 'error';
      installBtn.disabled = false;
      setTimeout(() => {
        installBtn.textContent = installState;
        installBtn.removeAttribute('title');
      }, 3000);
    }
  });

  return card;
}

function computeNappId(evt) {
  const dTag = evt.tags.find((t) => t[0] === 'd')?.[1];
  if (evt.kind === NSITE_NAMED && dTag) {
    return `${evt.pubkey.slice(0, 40)}-${dTag}`;
  }
  return evt.pubkey.slice(0, 40);
}


// ─── persistence ─────────────────────────────────────────────────

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCache(events) {
  try {
    // Cap to N most recent so we don't blow localStorage
    const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
    const capped = sorted.slice(0, CACHE_LIMIT);
    localStorage.setItem(CACHE_KEY, JSON.stringify(capped));
  } catch (err) {
    console.warn('store cache write failed', err);
  }
}

function readCustomRelays() {
  try {
    const raw = localStorage.getItem(RELAYS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCustomRelays(relays) {
  if (relays.length === 0) localStorage.removeItem(RELAYS_KEY);
  else localStorage.setItem(RELAYS_KEY, JSON.stringify(relays));
}

// ─── helpers ─────────────────────────────────────────────────────

async function resolveRelays(ctx) {
  const custom = readCustomRelays();
  if (custom.length) return custom;
  const pk = ctx.account.getPubkey();
  if (pk) {
    try {
      const rl = await loadRelayList(pk);
      const relays = (rl?.items || [])
        .filter((r) => r.read)
        .map((r) => r.url);
      if (relays.length) return relays;
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_RELAYS.slice();
}

function mergeEvents(cached, fresh) {
  const byKey = new Map();
  for (const e of [...cached, ...fresh]) {
    const dTag = e.tags.find((t) => t[0] === 'd')?.[1] || '';
    const key = `${e.kind}:${e.pubkey}:${dTag}`;
    const prev = byKey.get(key);
    if (!prev || e.created_at > prev.created_at) byKey.set(key, e);
  }
  return [...byKey.values()];
}

function matchesFilter(evt, filter) {
  if (!filter) return true;
  const fields = [
    evt.tags.find((t) => t[0] === 'title')?.[1] || '',
    evt.tags.find((t) => t[0] === 'description')?.[1] || '',
    evt.tags.find((t) => t[0] === 'd')?.[1] || '',
    evt.pubkey,
  ];
  return fields.some((f) => f.toLowerCase().includes(filter));
}
