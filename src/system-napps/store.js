import { loadBlossomServers, loadRelayList } from '@nostr/gadgets/lists';
import { loadNostrUser } from '@nostr/gadgets/metadata';
import { npubEncode, naddrEncode } from '@nostr/tools/nip19';
import * as pool from '../pool.js';

export const id = 'store';
export const title = 'Store';
export const slash = '/store';

const NSITE_ROOT = 15128;
const NSITE_NAMED = 35128;
const NSITE_LISTING = 37348; // NIP-5B app listing (paired to a manifest by d-tag)
const CACHE_KEY = 'nostrapps:store:cache';
const RELAYS_KEY = 'nostrapps:store:relays';
const CACHE_LIMIT = 500;

// Transparent 1×1 SVG used as the initial src for icon/avatar slots so the
// browser doesn't render a broken-image glyph while async loads are pending.
// The CSS placeholder background shows through; a real src replaces it
// without changing the slot's dimensions, so loading icons doesn't cause CLS.
const PLACEHOLDER_SRC =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>';

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

    // Cached events include both manifests (15128/35128) and NIP-5B listings
    // (37348). Pair them by (pubkey, d-tag) so the rendered cards are driven
    // by manifests but enriched with their listing's metadata.
    const listingsByKey = new Map();
    for (const e of events) {
      if (e.kind !== NSITE_LISTING) continue;
      const dTag = e.tags.find((t) => t[0] === 'd')?.[1] || '';
      listingsByKey.set(`${e.pubkey}:${dTag}`, e);
    }
    const listingFor = (manifest) => {
      const dTag = manifest.tags.find((t) => t[0] === 'd')?.[1] || '';
      return listingsByKey.get(`${manifest.pubkey}:${dTag}`) || null;
    };

    const manifests = events.filter(
      (e) => e.kind === NSITE_ROOT || e.kind === NSITE_NAMED,
    );
    const filtered = manifests
      .filter((m) => matchesFilter(m, listingFor(m), filter))
      .sort((a, b) => b.created_at - a.created_at);

    let displayed = [];
    const renderOne = (evt) => listEl.appendChild(renderCard(evt, ctx, listingFor(evt)));

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
        for (const evt of installed) renderOne(evt);
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
        for (const evt of past) renderOne(evt);
      }

      displayed = installed.concat(past);
    } else {
      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'store-empty';
        empty.textContent =
          manifests.length === 0
            ? 'No nsites cached yet — tap ↻ to fetch.'
            : 'No matches.';
        listEl.appendChild(empty);
        return;
      }
      for (const evt of filtered) renderOne(evt);
      displayed = filtered;
    }

    // Lazy-load profile metadata for unique authors.
    const seenAuthors = new Set();
    for (const evt of displayed) {
      if (seenAuthors.has(evt.pubkey)) continue;
      seenAuthors.add(evt.pubkey);
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
            // Slot was reserved at render time; just swap src — no shift.
            if (picEl && pic) picEl.src = pic;
          }
        })
        .catch(() => {});
    }

    // Lazy-load Blossom icons for unique authors that published a listing.
    const seenIconPks = new Set();
    for (const evt of displayed) {
      if (seenIconPks.has(evt.pubkey)) continue;
      const listing = listingFor(evt);
      if (!listing) continue;
      const hasIcon = listing.tags.some((t) => t[0] === 'icon' && t[1]);
      if (!hasIcon) continue;
      seenIconPks.add(evt.pubkey);
      loadBlossomServers(evt.pubkey)
        .then((res) => {
          if (cancelled) return;
          const servers = res?.items ?? [];
          if (servers.length === 0) return;
          const icons = listEl.querySelectorAll(
            `[data-listing-pubkey="${evt.pubkey}"] .store-card-icon[data-icon-sha]`,
          );
          for (const img of icons) {
            const sha = img.dataset.iconSha;
            const base = servers[0].endsWith('/')
              ? servers[0].slice(0, -1)
              : servers[0];
            img.src = `${base}/${sha}`;
            // If the first server fails, fall through to the next. If all
            // servers fail, restore the placeholder so the slot stays the
            // same height (vs hiding it and shifting layout).
            let next = 1;
            img.onerror = () => {
              if (next >= servers.length) {
                img.src = PLACEHOLDER_SRC;
                return;
              }
              const b = servers[next].endsWith('/')
                ? servers[next].slice(0, -1)
                : servers[next];
              next++;
              img.src = `${b}/${sha}`;
            };
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
        { kinds: [NSITE_ROOT, NSITE_NAMED, NSITE_LISTING], limit: 400 },
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

function renderCard(evt, ctx, listing = null) {
  const tag = (k) => evt.tags.find((t) => t[0] === k)?.[1] || '';
  const dTag = tag('d');
  const source = tag('source');
  const date = new Date(evt.created_at * 1000).toLocaleDateString();
  const pathCount = evt.tags.filter((t) => t[0] === 'path').length;
  const nappId = computeNappId(evt);
  const installed = ctx.isInstalled?.(nappId) ?? false;
  const installedManifest = installed ? ctx.installedManifest?.(nappId) : null;
  const updateAvailable =
    installed && installedManifest && installedManifest.createdAt < evt.created_at;

  // NIP-5B: prefer listing fields over manifest fallbacks.
  const listingName = localizedListingTag(listing, 'name');
  const listingSummary = localizedListingTag(listing, 'summary');
  const listingDescription = localizedListingTag(listing, 'description');
  const titleText = listingName || tag('title');
  const description = listingDescription || listingSummary || tag('description');
  const iconTag = listing?.tags.find((t) => t[0] === 'icon');
  const iconSha = iconTag?.[1];
  const iconMime = iconTag?.[2];
  const categoryTags = listing
    ? listing.tags.filter((t) => t[0] === 'l' && t[1]).map((t) => t[1])
    : [];
  const hashtags = listing
    ? listing.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1])
    : [];

  const card = document.createElement('div');
  card.className = 'store-card';
  card.dataset.author = evt.pubkey;
  if (listing) card.dataset.listingPubkey = listing.pubkey;

  const head = document.createElement('div');
  head.className = 'store-card-head';

  if (iconSha) {
    const icon = document.createElement('img');
    icon.className = 'store-card-icon';
    icon.alt = '';
    icon.dataset.iconSha = iconSha;
    if (iconMime) icon.dataset.iconMime = iconMime;
    // Reserve the slot up front so the placeholder background fills it; the
    // real src is set once a Blossom URL resolves (no layout shift).
    icon.src = PLACEHOLDER_SRC;
    head.appendChild(icon);
  }

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
  // Always reserve the 16×16 slot via the CSS placeholder background; src is
  // set when loadNostrUser resolves with a profile image.
  pic.src = PLACEHOLDER_SRC;
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

  // Action buttons. When an update is available we show *both* update and
  // uninstall (so the user can drop an installed app without first updating
  // it). Otherwise it's a single install/uninstall toggle.
  const actions = document.createElement('div');
  actions.className = 'store-actions';

  const performAction = async (btn, action) => {
    btn.disabled = true;
    btn.textContent =
      action === 'update'
        ? 'updating…'
        : action === 'uninstall'
          ? 'uninstalling…'
          : 'launching…';
    try {
      if (action === 'update') {
        await ctx.update({
          pubkey: evt.pubkey,
          kind: evt.kind,
          dTag: dTag || undefined,
        });
      } else if (action === 'uninstall') {
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
      // Re-render so the buttons reflect the new install state.
      const replacement = renderCard(evt, ctx, listing);
      card.replaceWith(replacement);
    } catch (err) {
      btn.title = err?.message || String(err);
      btn.textContent = 'error';
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = action;
        btn.removeAttribute('title');
      }, 3000);
    }
  };

  const makeActionBtn = (action, className) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = action;
    b.addEventListener('click', () => performAction(b, action));
    return b;
  };

  if (updateAvailable) {
    actions.append(
      makeActionBtn('update', 'store-install update-available'),
      makeActionBtn('uninstall', 'store-install installed'),
    );
  } else if (installed) {
    actions.append(makeActionBtn('uninstall', 'store-install installed'));
  } else {
    actions.append(makeActionBtn('install', 'store-install'));
  }

  head.append(titles, actions);
  card.appendChild(head);

  if (description) {
    const desc = document.createElement('p');
    desc.className = 'store-description';
    desc.textContent = description;
    card.appendChild(desc);
  }

  if (categoryTags.length || hashtags.length) {
    const chips = document.createElement('div');
    chips.className = 'store-chips';
    for (const cat of categoryTags) {
      const chip = document.createElement('span');
      chip.className = 'store-chip store-chip-category';
      chip.textContent = formatCategory(cat);
      chip.title = cat;
      chips.appendChild(chip);
    }
    for (const t of hashtags) {
      const chip = document.createElement('span');
      chip.className = 'store-chip store-chip-tag';
      chip.textContent = `#${t}`;
      chips.appendChild(chip);
    }
    card.appendChild(chips);
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

function matchesFilter(evt, listing, filter) {
  if (!filter) return true;
  const fields = [
    evt.tags.find((t) => t[0] === 'title')?.[1] || '',
    evt.tags.find((t) => t[0] === 'description')?.[1] || '',
    evt.tags.find((t) => t[0] === 'd')?.[1] || '',
    evt.pubkey,
  ];
  if (listing) {
    for (const t of listing.tags) {
      if (
        (t[0] === 'name' ||
          t[0] === 'summary' ||
          t[0] === 'description' ||
          t[0] === 'l' ||
          t[0] === 't') &&
        typeof t[1] === 'string'
      ) {
        fields.push(t[1]);
      }
    }
  }
  return fields.some((f) => f.toLowerCase().includes(filter));
}

// Picks the best language variant of a listing's tag (name, summary,
// description). Tag shape: ["<name>", "<value>", "<lang?>"].
function localizedListingTag(listing, tagName) {
  if (!listing) return null;
  const matches = listing.tags.filter(
    (t) => t[0] === tagName && typeof t[1] === 'string' && t[1].length > 0,
  );
  if (matches.length === 0) return null;
  const userLang =
    typeof navigator !== 'undefined' && navigator.language
      ? navigator.language.slice(0, 2).toLowerCase()
      : 'en';
  return (
    matches.find((t) => (t[2] || '').toLowerCase() === userLang)?.[1] ||
    matches.find((t) => !t[2] || t[2].toLowerCase() === 'en')?.[1] ||
    matches[0][1]
  );
}

// Renders a category label like "napp.utilities:office" into a friendlier
// "office · utilities" form for the chip text.
function formatCategory(label) {
  const m = /^napp\.([^:]+):(.+)$/.exec(label);
  if (!m) return label;
  return `${m[2]} · ${m[1]}`;
}
