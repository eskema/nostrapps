const OPEN_KEY = 'nostrapps:open';
const HISTORY_KEY = 'nostrapps:history';
const KNOWN_KEY = 'nostrapps:known';
const PETNAMES_KEY = 'nostrapps:petnames';
const HISTORY_LIMIT = 20;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readOpen() {
  const raw = readJson(OPEN_KEY, []);
  if (!Array.isArray(raw)) {
    writeOpen([]);
    return [];
  }
  const byId = new Map();
  let dirty = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || !entry.instanceId) {
      dirty = true;
      continue;
    }
    if (byId.has(entry.instanceId)) dirty = true;
    byId.set(entry.instanceId, entry);
  }
  const clean = [...byId.values()];
  if (dirty) writeOpen(clean);
  return clean;
}

export function writeOpen(napps) {
  writeJson(OPEN_KEY, napps);
}

export function updateOpen(instanceId, state) {
  const all = readOpen();
  const existing = all.find((n) => n.instanceId === instanceId);
  const rest = all.filter((n) => n.instanceId !== instanceId);
  if (state) rest.push({ ...existing, ...state });
  writeOpen(rest);
}

export function removeOpen(instanceId) {
  writeOpen(readOpen().filter((n) => n.instanceId !== instanceId));
}

export function setOpenClosed(instanceId, closed) {
  const all = readOpen();
  const entry = all.find((n) => n.instanceId === instanceId);
  if (!entry) return;
  entry.closed = closed;
  writeOpen(all);
}

export function readActiveSessions() {
  return readOpen().filter((n) => !n.closed);
}

export function findSessionByPetname(petname) {
  const all = readOpen();
  return all.find((n) => n.petname === petname) ?? null;
}

export function readHistory() {
  return readJson(HISTORY_KEY, []);
}

export function pushHistory(entry) {
  const prev = readHistory().filter((e) => e !== entry);
  prev.unshift(entry);
  writeJson(HISTORY_KEY, prev.slice(0, HISTORY_LIMIT));
}

export function readKnown() {
  return readJson(KNOWN_KEY, []);
}

export function rememberKnown(nappId) {
  const prev = readKnown().filter((n) => n !== nappId);
  prev.unshift(nappId);
  writeJson(KNOWN_KEY, prev.slice(0, 100));
}

export function readPetnames() {
  const raw = readJson(PETNAMES_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

export function setPetname(petname, nappId) {
  if (!petname || !nappId) return;
  const all = readPetnames();
  all[petname] = nappId;
  writeJson(PETNAMES_KEY, all);
}

export function getNappIdForPetname(petname) {
  return readPetnames()[petname] ?? null;
}
