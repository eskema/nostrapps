import { launch, restore, focusInstance } from './sandbox/host.js';
import { resolveInput } from './nsite/resolve.js';
import { fetchNsite } from './nsite/fetch.js';
import { collectLocalFolder } from './nsite/local.js';
import { nip07Signer } from './signers/nip07.js';
import * as account from './account.js';
import { mountDialog } from './permissions.js';
import * as persist from './persistence.js';
import * as instanceStore from './storage/instance.js';

const stage = document.getElementById('stage');
const form = document.getElementById('launch-form');
const input = document.getElementById('nsite-input');
const suggestions = document.getElementById('suggestions');
const logEl = document.getElementById('log');
const logContainer = document.getElementById('log-container');
const logToggle = document.getElementById('log-toggle');
const loadLocalBtn = document.getElementById('load-local');
const localFolderInput = document.getElementById('local-folder');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const pubkeyDisplay = document.getElementById('pubkey-display');
const pubkeyShort = document.getElementById('pubkey-short');

mountDialog(document.getElementById('permission-prompt'));

const logHistory = [];

function renderLog() {
  if (logContainer.classList.contains('log-expanded')) {
    logEl.textContent = logHistory.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  } else {
    logEl.textContent = logHistory[logHistory.length - 1] ?? '';
  }
}

const setStatus = (msg) => {
  const stamp = new Date().toLocaleTimeString(undefined, { hour12: false });
  logHistory.push(`${stamp}  ${msg}`);
  renderLog();
};

logToggle.textContent = '▸';
logToggle.addEventListener('click', () => {
  const expanded = logContainer.classList.toggle('log-expanded');
  logContainer.classList.toggle('log-collapsed', !expanded);
  logToggle.textContent = expanded ? '▾' : '▸';
  logToggle.title = expanded ? 'Collapse log' : 'Expand log';
  renderLog();
});

function renderAccount(pk) {
  if (pk) {
    connectBtn.hidden = true;
    pubkeyDisplay.hidden = false;
    pubkeyShort.textContent = `${pk.slice(0, 8)}…${pk.slice(-4)}`;
    pubkeyShort.title = pk;
  } else {
    connectBtn.hidden = false;
    pubkeyDisplay.hidden = true;
    pubkeyShort.textContent = '';
  }
}

renderAccount(account.getPubkey());
account.subscribe(renderAccount);

connectBtn.addEventListener('click', async () => {
  try {
    if (!window.nostr) throw new Error('No NIP-07 extension detected');
    setStatus('Requesting pubkey from extension…');
    const pk = await window.nostr.getPublicKey();
    account.setPubkey(pk);
    setStatus(`Connected as ${pk.slice(0, 8)}…`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

disconnectBtn.addEventListener('click', () => {
  account.clearPubkey();
  setStatus('Disconnected');
});

function buildSuggestionItems() {
  const seen = new Set();
  const out = [];

  for (const s of persist.readOpen()) {
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
  }

  const petnames = persist.readPetnames();
  for (const [petname, nappId] of Object.entries(petnames)) {
    const key = `name:${petname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: 'name', nappId, petname });
  }

  for (const v of persist.readKnown()) {
    const key = `napp:${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: 'napp', nappId: v });
  }

  for (const v of persist.readHistory()) {
    const key = `hist:${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: 'history', raw: v });
  }

  return out;
}

function itemSearchText(item) {
  return [item.nappId, item.instanceId, item.petname, item.raw]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function itemPreferredValue(item) {
  return item.petname || item.nappId || item.raw || '';
}

function renderSuggestions() {
  const filter = input.value.trim().toLowerCase();
  const items = buildSuggestionItems().filter(
    (item) => !filter || itemSearchText(item).includes(filter),
  );
  suggestions.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'suggestion';

    const main = document.createElement('span');
    main.className = 'sugg-main';

    if (item.raw) {
      const raw = document.createElement('span');
      raw.className = 'sugg-raw';
      raw.textContent = item.raw;
      main.appendChild(raw);
    } else {
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

      if (item.petname) {
        const pet = document.createElement('span');
        pet.className = 'sugg-pet';
        pet.textContent = item.petname;
        main.appendChild(pet);
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
        if (item.instanceId) {
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
    suggestions.appendChild(row);
  }
}

async function launchFresh(nappId, petname) {
  const win = restore(stage, nappId, nip07Signer, {
    ...makeLaunchOpts(),
    petname: petname && petname !== nappId ? petname : nappId,
  });
  trackOpened(nappId, win);
  refreshSuggestions();
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
  persist.updateOpen(session.instanceId, {
    ...win.getState(),
    closed: false,
  });
  refreshSuggestions();
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

function trackOpened(nappId, win) {
  const state = win.getState();
  persist.rememberKnown(nappId);
  persist.updateOpen(state.instanceId, state);
  refreshSuggestions();
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
    onClose: (instanceId) => {
      persist.setOpenClosed(instanceId, true);
      refreshSuggestions();
    },
    onDestroy: (instanceId) => {
      persist.removeOpen(instanceId);
      instanceStore.clear(instanceId).catch(() => {});
      refreshSuggestions();
    },
  };
}

async function restoreAll() {
  const open = persist.readActiveSessions();
  for (const state of open) {
    try {
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

setStatus('Ready — connect, enter an npub or nappId, or load a local folder');
await restoreAll();

async function launchFromInput(raw) {
  const existing = persist.findSessionByPetname(raw);
  if (existing) {
    if (!existing.closed && focusInstance(existing.instanceId)) {
      setStatus(`${raw} is already open`);
      persist.pushHistory(raw);
      refreshSuggestions();
      return;
    }
    const win = restore(stage, existing.nappId, nip07Signer, {
      ...makeLaunchOpts(),
      instanceId: existing.instanceId,
      petname: existing.petname,
      initial: existing,
    });
    persist.updateOpen(existing.instanceId, { ...win.getState(), closed: false });
    persist.pushHistory(raw);
    refreshSuggestions();
    return;
  }

  const petNappId = persist.getNappIdForPetname(raw);
  if (petNappId) {
    const win = restore(stage, petNappId, nip07Signer, {
      ...makeLaunchOpts(),
      petname: raw,
    });
    trackOpened(petNappId, win);
    persist.pushHistory(raw);
    refreshSuggestions();
    return;
  }
  const known = new Set(persist.readKnown());
  if (known.has(raw)) {
    const win = restore(stage, raw, nip07Signer, {
      ...makeLaunchOpts(),
      petname: raw,
    });
    trackOpened(raw, win);
    persist.pushHistory(raw);
    refreshSuggestions();
    return;
  }
  const { pubkey } = resolveInput(raw);
  const { nappId, files } = await fetchNsite(pubkey, setStatus);
  const win = await launch(stage, nappId, files, nip07Signer, {
    ...makeLaunchOpts(),
    petname: raw,
  });
  trackOpened(nappId, win);
  persist.pushHistory(raw);
  refreshSuggestions();
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

loadLocalBtn.addEventListener('click', () => localFolderInput.click());

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
    setStatus(`Launched ${nappId}`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    console.error(err);
  } finally {
    e.target.value = '';
  }
});
