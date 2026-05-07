import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-code-pro';
import {
  launch,
  restore,
  focusInstance,
  launchSystem,
  wipe,
  destroyByNappId,
  reinstallFiles,
  reloadIframesByNappId,
} from './sandbox/host.js';
import { resolveInput } from './nsite/resolve.js';
import { fetchNsite } from './nsite/fetch.js';
import { collectLocalFolder } from './nsite/local.js';
import { nip07Signer } from './signers/nip07.js';
import * as account from './account.js';
import { mountDialog, clearDecisions } from './permissions.js';
import * as persist from './persistence.js';
import * as instanceStore from './storage/instance.js';
import {
  registry as systemRegistry,
  slashCommands,
  list as systemList,
  actionRegistry,
  slashActions,
  actionList,
} from './system-napps/index.js';

const stage = document.getElementById('stage');
const form = document.getElementById('launch-form');
const input = document.getElementById('nsite-input');
const suggestions = document.getElementById('suggestions');
const localFolderInput = document.getElementById('local-folder');

mountDialog(document.getElementById('permission-prompt'));

// ─── theme store ────────────────────────────────────────────────
const THEME_KEY = 'nostrapps:theme';
const themeSubs = new Set();
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') {
    document.documentElement.dataset.theme = choice;
  } else {
    delete document.documentElement.dataset.theme;
  }
}
const theme = {
  get() {
    return localStorage.getItem(THEME_KEY) || 'auto';
  },
  set(choice) {
    if (choice === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
    applyTheme(choice);
    for (const fn of themeSubs) fn(choice);
  },
  subscribe(fn) {
    themeSubs.add(fn);
    return () => themeSubs.delete(fn);
  },
};
applyTheme(theme.get());

// ─── log bus ────────────────────────────────────────────────────
// Each entry is `{ at: msTimestamp, msg: string }`. Consumers (currently
// /logs) format the timestamp how they want.
const logHistory = [];
const logSubs = new Set();
function setStatus(msg) {
  logHistory.push({ at: Date.now(), msg });
  for (const fn of logSubs) {
    try {
      fn();
    } catch {}
  }
}
const logs = {
  history: () => logHistory.slice(),
  subscribe(fn) {
    logSubs.add(fn);
    return () => logSubs.delete(fn);
  },
};

// ─── account actions ────────────────────────────────────────────
async function connect() {
  try {
    if (!window.nostr) throw new Error('No NIP-07 extension detected');
    setStatus('Requesting pubkey from extension…');
    const pk = await window.nostr.getPublicKey();
    account.setPubkey(pk);
    setStatus(`Connected as ${pk.slice(0, 8)}…`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}
function disconnect() {
  account.clearPubkey();
  setStatus('Disconnected');
}

function loadFolder() {
  localFolderInput.click();
}

async function uninstallNapp(nappId) {
  // Destroy any open windows; their onDestroy chain runs the per-instance
  // cleanup and (when the last open instance dies) the global wipe path.
  destroyByNappId(nappId);

  // Close any remaining (closed) sessions in persistence so they don't
  // linger as orphan entries.
  for (const s of persist.readOpen()) {
    if (s.nappId === nappId) {
      persist.removeOpen(s.instanceId);
      instanceStore.clear(s.instanceId).catch(() => {});
    }
  }

  // If the destroy chain didn't finalize global cleanup (because closed
  // sessions were present when the last open instance died), do it now.
  if (persist.readKnown().includes(nappId)) {
    const petnameKeys = Object.entries(persist.readPetnames())
      .filter(([, mapped]) => mapped === nappId)
      .map(([petname]) => petname);
    persist.forgetKnown(nappId);
    persist.forgetPetnamesForNapp(nappId);
    persist.forgetHistory(nappId);
    for (const p of petnameKeys) persist.forgetHistory(p);
    clearDecisions(nappId);
    persist.forgetInstalledManifest(nappId);
    setStatus(`Uninstalling ${nappId}…`);
    try {
      await wipe(nappId);
      setStatus(`Uninstalled ${nappId}`);
    } catch (err) {
      setStatus(`Wipe error: ${err.message}`);
    }
  }
  refreshSuggestions();
}

function manifestInfoFromEvent(evt) {
  if (!evt) return null;
  return {
    pubkey: evt.pubkey,
    kind: evt.kind,
    dTag: evt.tags.find((t) => t[0] === 'd')?.[1] || null,
    eventId: evt.id,
    createdAt: evt.created_at,
  };
}

// Update flow: re-fetch the manifest + files at the same target, swap them
// into the napp's existing origin storage (no new window), persist the new
// version, and force any open iframes to reload so they pick up new files.
async function updateNapp(target) {
  if (!target?.pubkey) throw new Error('updateNapp: missing pubkey');
  setStatus(`Checking update…`);
  const result = await fetchNsite(target, setStatus);
  const { nappId, files, title, manifest } = result;
  const label = title || nappId;
  setStatus(`Updating ${label}…`);
  await reinstallFiles(nappId, files, setStatus, label);
  if (manifest) persist.setInstalledManifest(nappId, manifestInfoFromEvent(manifest));
  const reloaded = reloadIframesByNappId(nappId);
  setStatus(
    `Updated ${label}` +
      (reloaded
        ? ` — reloaded ${reloaded} window${reloaded === 1 ? '' : 's'}`
        : ''),
  );
  refreshSuggestions();
}

// ─── system napp ctx ────────────────────────────────────────────
const systemCtx = {
  account,
  theme,
  logs,
  connect,
  disconnect,
  loadFolder,
  setStatus,
  launchSystemNapp,
  // Use a thunk so the reference resolves to the function declared later.
  launchFromInput: (raw) => launchFromInput(raw),
  isInstalled: (nappId) => persist.readKnown().includes(nappId),
  wasInstalled: (nappId) => persist.readInstallLog().includes(nappId),
  uninstall: (nappId) => uninstallNapp(nappId),
  installedManifest: (nappId) => persist.getInstalledManifest(nappId),
  update: (target) => updateNapp(target),
};

function makeSystemLaunchOpts(sysId) {
  return {
    onStateChange: (state) => {
      persist.updateOpen(state.instanceId, {
        ...state,
        system: true,
        systemId: sysId,
      });
      refreshSuggestions();
    },
    onReorder: persistDomOrder,
    onClose: (instanceId) => {
      persist.setOpenClosed(instanceId, true);
      refreshSuggestions();
    },
  };
}

function launchSystemNapp(sysId, { initial } = {}) {
  const def = systemRegistry[sysId];
  if (!def) throw new Error(`Unknown system napp: ${sysId}`);
  const win = launchSystem(stage, sysId, def, systemCtx, {
    ...makeSystemLaunchOpts(sysId),
    initial,
  });
  bringToTopOfStack(win.root);
  // Persist the entry now (with current zIndex/position) so it can be
  // restored on the next reload even if the user never interacts with it.
  persist.updateOpen(`system:${sysId}`, {
    ...win.getState(),
    system: true,
    systemId: sysId,
    closed: false,
  });
  persistDomOrder();
  refreshSuggestions();
  return win;
}

// ─── suggestions ────────────────────────────────────────────────
function buildSuggestionItems() {
  const seen = new Set();
  const out = [];
  const sessionNappIds = new Set();

  // System napps + slash actions first — discoverability for slash commands
  for (const def of systemList) {
    out.push({
      source: 'system',
      systemId: def.id,
      slash: def.slash,
      petname: def.title,
    });
  }
  for (const def of actionList) {
    out.push({
      source: 'action',
      actionId: def.id,
      slash: def.slash,
      petname: def.title,
    });
  }

  const openSessions = persist.readOpen();
  const petnames = persist.readPetnames();

  for (const s of openSessions) {
    if (s.system) continue; // shown via systemList row instead
    const key = `sess:${s.instanceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const customPet = s.petname && s.petname !== s.nappId ? s.petname : null;
    out.push({
      source: s.closed ? 'closed' : 'open',
      nappId: s.nappId,
      instanceId: s.instanceId,
      petname: customPet,
    });
    if (s.nappId) sessionNappIds.add(s.nappId);
  }

  for (const [petname, nappId] of Object.entries(petnames)) {
    if (sessionNappIds.has(nappId)) continue;
    const key = `name:${petname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: 'name', nappId, petname });
  }

  for (const v of persist.readKnown()) {
    const key = `napp:${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: 'napp',
      nappId: v,
      petname: petnameForNappId(v, petnames, openSessions),
    });
  }

  return out;
}

function petnameForNappId(nappId, petnamesMap, sessions) {
  // Prefer a petname from any session for this nappId — that's typically the
  // friendliest name (manifest title we set at launch).
  for (const s of sessions) {
    if (s.nappId === nappId && s.petname && s.petname !== nappId) {
      return s.petname;
    }
  }
  // Fall back to the inverse petnames map, preferring values that don't look
  // like raw identifiers (npub/naddr/host) so we surface the friendly title.
  const candidates = [];
  for (const [petname, mapped] of Object.entries(petnamesMap)) {
    if (mapped === nappId) candidates.push(petname);
  }
  if (candidates.length === 0) return null;
  return candidates.find((p) => !looksLikeIdentifier(p)) || candidates[0];
}

function looksLikeIdentifier(s) {
  if (/^[0-9a-f]{64}$/i.test(s)) return true;
  if (/^(npub1|nprofile1|naddr1)[0-9a-z]+$/i.test(s)) return true;
  if (/^(?:https?:\/\/)?[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/i.test(s)) return true;
  return false;
}


function itemSearchText(item) {
  return [
    item.nappId,
    item.instanceId,
    item.petname,
    item.raw,
    item.slash,
    item.systemId,
    item.actionId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function itemPreferredValue(item) {
  return item.slash || item.petname || item.nappId || item.raw || '';
}

function renderSuggestions() {
  const filter = input.value.trim().toLowerCase();
  const items = buildSuggestionItems().filter(
    (item) => !filter || itemSearchText(item).includes(filter),
  );

  // Three sections:
  //   1. System items (slash commands and slash actions) — discoverability.
  //   2. Last 5 sessions (open or closed), in recency order from persist.
  //   3. Everything else (NAPP / NAME), alphabetical by friendly name.
  const systemItems = items.filter(
    (i) => i.source === 'system' || i.source === 'action',
  );
  const sessionItems = items
    .filter((i) => i.source === 'open' || i.source === 'closed')
    .slice(0, 5);
  const sessionSet = new Set(sessionItems);
  const sysSet = new Set(systemItems);
  const restItems = items
    .filter((i) => !sysSet.has(i) && !sessionSet.has(i))
    .sort((a, b) => itemSortLabel(a).localeCompare(itemSortLabel(b)));

  suggestions.innerHTML = '';
  let appended = false;
  for (const section of [systemItems, sessionItems, restItems]) {
    if (section.length === 0) continue;
    if (appended) {
      const divider = document.createElement('div');
      divider.className = 'sugg-divider';
      suggestions.appendChild(divider);
    }
    appended = true;
    for (const item of section) suggestions.appendChild(renderSuggestionRow(item));
  }
}

function itemSortLabel(item) {
  return (item.petname || item.nappId || item.raw || '').toLowerCase();
}

function renderSuggestionRow(item) {
  const row = document.createElement('div');
  row.className = 'suggestion';

  const main = document.createElement('span');
  main.className = 'sugg-main';

  if (item.systemId || item.actionId) {
    const cmd = document.createElement('span');
    cmd.className = 'sugg-slash';
    cmd.textContent = item.slash;
    main.appendChild(cmd);
  } else if (item.raw) {
    const raw = document.createElement('span');
    raw.className = 'sugg-raw';
    raw.textContent = item.raw;
    main.appendChild(raw);
  } else {
    // Friendly name first, then the pubkey-id, then the instance id for sessions.
    if (item.petname) {
      const pet = document.createElement('span');
      pet.className = 'sugg-pet';
      pet.textContent = item.petname;
      main.appendChild(pet);
    }
    const napp = document.createElement('span');
    napp.className = 'sugg-napp';
    napp.textContent = item.nappId;
    main.appendChild(napp);
    if (item.instanceId) {
      const id = document.createElement('span');
      id.className = 'sugg-id';
      id.textContent = item.instanceId.slice(0, 8);
      main.appendChild(id);
    }
  }

  const source = document.createElement('span');
  source.className = 'source';
  source.textContent = item.source;
  row.append(main, source);

  row.addEventListener('mousedown', async (e) => {
    e.preventDefault();
    const label = itemPreferredValue(item);
    hideSuggestions();
    try {
      if (item.systemId) {
        const win = launchSystemNapp(item.systemId);
        win?.focus?.();
      } else if (item.actionId) {
        actionRegistry[item.actionId]?.run(systemCtx);
      } else if (item.instanceId) {
        await launchSession(item.instanceId);
      } else if (item.nappId) {
        await launchFresh(item.nappId, item.petname || item.nappId);
      } else if (item.raw) {
        await launchFromInput(item.raw);
      }
      setStatus(`Launched ${label}`);
      input.value = '';
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      console.error(err);
    }
  });
  return row;
}

async function launchFresh(nappId, petname) {
  const win = restore(stage, nappId, nip07Signer, {
    ...makeLaunchOpts(),
    petname: petname && petname !== nappId ? petname : nappId,
  });
  trackOpened(nappId, win);
  win.focus();
}

async function launchSession(instanceId) {
  const session = persist.readOpen().find((s) => s.instanceId === instanceId);
  if (!session) throw new Error('Session not found');
  if (!session.closed && focusInstance(instanceId)) return;
  const win = restore(stage, session.nappId, nip07Signer, {
    ...makeLaunchOpts(),
    instanceId: session.instanceId,
    petname: session.petname,
    initial: session,
  });
  bringToTopOfStack(win.root);
  persist.updateOpen(session.instanceId, {
    ...win.getState(),
    closed: false,
  });
  persistDomOrder();
  refreshSuggestions();
  win.focus();
}

function showSuggestions() {
  renderSuggestions();
  suggestions.hidden = false;
}

function hideSuggestions() {
  suggestions.hidden = true;
}

input.addEventListener('focus', showSuggestions);
input.addEventListener('input', () => {
  if (!suggestions.hidden) renderSuggestions();
  else showSuggestions();
});
input.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 150);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSuggestions();
});

function refreshSuggestions() {
  if (!suggestions.hidden) renderSuggestions();
}

function bringToTopOfStack(root) {
  if (!root || !stage.contains(root)) return;
  if (stage.firstElementChild === root) return;
  stage.insertBefore(root, stage.firstElementChild);
}

function trackOpened(nappId, win) {
  const state = win.getState();
  persist.rememberKnown(nappId);
  bringToTopOfStack(win.root);
  persist.updateOpen(state.instanceId, state);
  persistDomOrder();
  refreshSuggestions();
}

function persistDomOrder() {
  const ordered = Array.from(stage.children)
    .filter((el) => el.classList?.contains('napp-window'))
    .map((el) => el.dataset.instanceId)
    .filter(Boolean);
  if (ordered.length === 0) return;
  const open = persist.readOpen();
  const byId = new Map(open.map((s) => [s.instanceId, s]));
  const nextOrder = [];
  const used = new Set();
  for (const id of ordered) {
    const s = byId.get(id);
    if (s) {
      // system napps aren't in `open`, so they get filtered here automatically
      nextOrder.push(s);
      used.add(id);
    }
  }
  for (const s of open) {
    if (!used.has(s.instanceId)) nextOrder.push(s);
  }
  persist.writeOpen(nextOrder);
}

function makeLaunchOpts() {
  return {
    onProgress: setStatus,
    onStateChange: (state) => {
      persist.updateOpen(state.instanceId, state);
      if (state.petname && state.petname !== state.nappId) {
        persist.setPetname(state.petname, state.nappId);
      }
      refreshSuggestions();
    },
    onReorder: persistDomOrder,
    onClose: (instanceId) => {
      persist.setOpenClosed(instanceId, true);
      refreshSuggestions();
    },
    onDestroy: (instanceId) => {
      const entry = persist.readOpen().find(
        (s) => s.instanceId === instanceId,
      );
      persist.removeOpen(instanceId);
      instanceStore.clear(instanceId).catch(() => {});
      if (entry?.nappId) {
        const stillUsed = persist
          .readOpen()
          .some((s) => s.nappId === entry.nappId);
        if (!stillUsed) {
          const petnameKeys = Object.entries(persist.readPetnames())
            .filter(([, mapped]) => mapped === entry.nappId)
            .map(([petname]) => petname);
          persist.forgetKnown(entry.nappId);
          persist.forgetPetnamesForNapp(entry.nappId);
          persist.forgetHistory(entry.nappId);
          for (const p of petnameKeys) persist.forgetHistory(p);
          clearDecisions(entry.nappId);
          persist.forgetInstalledManifest(entry.nappId);
          // Wipe the napp's origin storage (IDB, localStorage, caches, SW)
          // so re-installing it later starts from a clean slate.
          setStatus(`Wiping ${entry.nappId}…`);
          wipe(entry.nappId)
            .then(() => setStatus(`Destroyed ${entry.nappId}`))
            .catch((err) => setStatus(`Wipe error: ${err.message}`));
        }
      }
      refreshSuggestions();
    },
  };
}

async function restoreAll() {
  const open = persist.readActiveSessions();
  for (const state of open) {
    try {
      if (state.system && state.systemId) {
        const def = systemRegistry[state.systemId];
        if (!def) continue;
        const win = launchSystem(stage, state.systemId, def, systemCtx, {
          ...makeSystemLaunchOpts(state.systemId),
          initial: state,
        });
        persist.updateOpen(state.instanceId, {
          ...win.getState(),
          system: true,
          systemId: state.systemId,
        });
        continue;
      }
      const win = restore(stage, state.nappId, nip07Signer, {
        ...makeLaunchOpts(),
        instanceId: state.instanceId,
        petname: state.petname,
        initial: state,
      });
      persist.updateOpen(state.instanceId, win.getState());
    } catch (err) {
      setStatus(`Failed to restore ${state.nappId}: ${err.message}`);
    }
  }
}

const BOOTSTRAP_KEY = 'nostrapps:bootstrapped';
function maybeBootstrap() {
  if (localStorage.getItem(BOOTSTRAP_KEY)) return;
  // First ever load: open every system napp once. After this, the user's
  // open/closed state is the source of truth.
  for (const def of systemList) {
    try {
      launchSystemNapp(def.id);
    } catch (err) {
      console.warn(`bootstrap ${def.id}:`, err);
    }
  }
  localStorage.setItem(BOOTSTRAP_KEY, '1');
}

async function init() {
  setStatus(
    'Ready — try /store, /settings, /logs, /permissions, /folder, or enter a pubkey/npub/nsite host',
  );
  await restoreAll();
  maybeBootstrap();
}
init();

async function launchFromInput(raw) {
  // Slash commands → system napps or one-shot actions
  if (raw.startsWith('/')) {
    const sysId = slashCommands[raw];
    if (sysId) {
      const win = launchSystemNapp(sysId);
      win?.focus?.();
      return;
    }
    const actionId = slashActions[raw];
    if (actionId) {
      actionRegistry[actionId]?.run(systemCtx);
      return;
    }
    throw new Error(`Unknown command: ${raw}`);
  }

  const existing = persist.findSessionByPetname(raw);
  if (existing) {
    if (!existing.closed && focusInstance(existing.instanceId)) {
      setStatus(`${raw} is already open`);
      refreshSuggestions();
      return;
    }
    const win = restore(stage, existing.nappId, nip07Signer, {
      ...makeLaunchOpts(),
      instanceId: existing.instanceId,
      petname: existing.petname,
      initial: existing,
    });
    bringToTopOfStack(win.root);
    persist.updateOpen(existing.instanceId, {
      ...win.getState(),
      closed: false,
    });
    persistDomOrder();
    refreshSuggestions();
    win.focus();
    return;
  }

  const petNappId = persist.getNappIdForPetname(raw);
  if (petNappId) {
    const win = restore(stage, petNappId, nip07Signer, {
      ...makeLaunchOpts(),
      petname: raw,
    });
    trackOpened(petNappId, win);
    win.focus();
    return;
  }
  const known = new Set(persist.readKnown());
  if (known.has(raw)) {
    const win = restore(stage, raw, nip07Signer, {
      ...makeLaunchOpts(),
      petname: raw,
    });
    trackOpened(raw, win);
    win.focus();
    return;
  }
  let resolved;
  try {
    resolved = resolveInput(raw);
  } catch {
    throw new Error(
      `Couldn't resolve "${raw}" — try a pubkey, npub, nprofile, naddr, or nsite hostname`,
    );
  }
  const { nappId, files, title, manifest } = await fetchNsite(
    resolved,
    setStatus,
  );
  const petname = title || raw;
  const win = await launch(stage, nappId, files, nip07Signer, {
    ...makeLaunchOpts(),
    petname,
  });
  trackOpened(nappId, win);
  if (raw && raw !== petname) persist.setPetname(raw, nappId);
  persist.pushHistory(raw);
  if (manifest) persist.setInstalledManifest(nappId, manifestInfoFromEvent(manifest));
  win.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideSuggestions();
  const raw = input.value.trim();
  if (!raw) return;
  try {
    await launchFromInput(raw);
    setStatus(`Launched ${raw}`);
    input.value = '';
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
});

localFolderInput.addEventListener('change', async (e) => {
  const inputFiles = e.target.files;
  if (!inputFiles || inputFiles.length === 0) return;
  try {
    const { nappId, files } = await collectLocalFolder(inputFiles, setStatus);
    const win = await launch(stage, nappId, files, nip07Signer, {
      ...makeLaunchOpts(),
      petname: nappId,
    });
    trackOpened(nappId, win);
    win.focus();
    setStatus(`Launched ${nappId}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  } finally {
    e.target.value = '';
  }
});
