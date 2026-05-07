import { isGated, requireApproval } from '../permissions.js';
import * as pool from '../pool.js';
import * as store from '../store.js';
import * as instanceStore from '../storage/instance.js';
import { createNappWindow } from './napp-window.js';

const BOOT_TIMEOUT_MS = 10_000;

const openWindows = new Map();

export function nappOriginFor(nappId) {
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${nappId}.napps.localhost${port}`;
}

export async function launch(stageEl, nappId, files, signer, opts = {}) {
  const origin = nappOriginFor(nappId);
  const onProgress = opts.onProgress ?? (() => {});
  const label = opts.petname || nappId;

  onProgress(`Booting ${label}…`);
  await bootNapp(origin, files, onProgress, label);

  return mount(stageEl, nappId, origin, signer, opts);
}

export function restore(stageEl, nappId, signer, opts = {}) {
  const origin = nappOriginFor(nappId);
  return mount(stageEl, nappId, origin, signer, opts);
}

export function focusInstance(instanceId) {
  const win = openWindows.get(instanceId);
  if (!win) return false;
  win.focus?.();
  return true;
}

export function destroyByNappId(nappId) {
  // Snapshot — destroy() mutates openWindows.
  const targets = [];
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId) targets.push(win);
  }
  for (const win of targets) win.destroy();
  return targets.length;
}

// Re-run the install flow into the napp's existing origin without spawning
// a new visible window. boot.html's install handler clears its files store
// before writing, so this swaps the files atomically for in-place updates.
export async function reinstallFiles(nappId, files, onProgress, label) {
  const origin = nappOriginFor(nappId);
  await bootNapp(origin, files, onProgress ?? (() => {}), label || nappId);
}

// Reload every open iframe whose dataset.nappId matches. Reassigning
// iframe.src triggers a same-origin navigation; window.name (the bridge's
// instanceId) is preserved across same-origin reloads.
export function reloadIframesByNappId(nappId) {
  let count = 0;
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId && win.iframe) {
      win.iframe.src = win.iframe.src;
      count++;
    }
  }
  return count;
}

const systemSingletons = new Map(); // sysId -> instanceId

export function launchSystem(stageEl, sysId, def, ctx, opts = {}) {
  // singleton — focus the existing instance if already open
  const existing = systemSingletons.get(sysId);
  if (existing && openWindows.has(existing)) {
    focusInstance(existing);
    return openWindows.get(existing);
  }

  const instanceId = `system:${sysId}`;
  const bodyElement = document.createElement('div');
  bodyElement.className = `system-napp-content system-napp-${sysId}`;

  const handle = def.mount(bodyElement, ctx);

  const win = createNappWindow({
    nappId: `__${sysId}__`,
    instanceId,
    petname: def.title || sysId,
    bodyElement,
    system: true,
    initial: opts.initial,
    onStateChange: opts.onStateChange,
    onClose: () => {
      handle?.unmount?.();
      openWindows.delete(instanceId);
      systemSingletons.delete(sysId);
      opts.onClose?.(instanceId);
    },
    onReorder: opts.onReorder,
  });
  win.systemId = sysId;
  stageEl.appendChild(win.root);
  openWindows.set(instanceId, win);
  systemSingletons.set(sysId, instanceId);
  return win;
}

function mount(stageEl, nappId, origin, signer, opts = {}) {
  const {
    instanceId = crypto.randomUUID(),
    petname,
    onProgress = () => {},
    onStateChange,
    onReorder,
    onClose,
    onDestroy,
    initial,
  } = opts;

  onProgress(`Starting ${petname || nappId}…`);
  const win = createNappWindow({
    nappId,
    instanceId,
    origin,
    src: `${origin}/`,
    petname,
    initial,
    onMessage: (data, iframe) => {
      if (!data || data.__nostrapps !== 'rpc') return;
      handleRpc(data, iframe, signer, nappId);
    },
    onClose: () => {
      openWindows.delete(instanceId);
      onClose?.(instanceId);
    },
    onDestroy: () => {
      openWindows.delete(instanceId);
      onDestroy?.(instanceId);
    },
    onStateChange,
    onReorder,
  });
  stageEl.appendChild(win.root);
  openWindows.set(instanceId, win);
  return win;
}

export async function wipe(nappId) {
  const origin = nappOriginFor(nappId);
  const boot = document.createElement('iframe');
  boot.src = `${origin}/boot.html`;
  boot.style.display = 'none';
  document.body.appendChild(boot);

  try {
    const ready = await waitForMessage(
      origin,
      'napp-boot-ready',
      'napp-boot-error',
    );
    if (ready.__nostrapps === 'napp-boot-error') {
      throw new Error(`Napp boot failed: ${ready.error}`);
    }
    boot.contentWindow.postMessage(
      { __nostrapps: 'napp-wipe' },
      origin,
    );
    const result = await waitForMessage(
      origin,
      'napp-wipe-done',
      'napp-wipe-error',
    );
    if (result.__nostrapps === 'napp-wipe-error') {
      throw new Error(result.error);
    }
  } finally {
    boot.remove();
  }
}

async function bootNapp(origin, files, onProgress, label) {
  const boot = document.createElement('iframe');
  boot.src = `${origin}/boot.html`;
  boot.style.display = 'none';
  document.body.appendChild(boot);

  try {
    const ready = await waitForMessage(
      origin,
      'napp-boot-ready',
      'napp-boot-error',
    );
    if (ready.__nostrapps === 'napp-boot-error') {
      throw new Error(`Napp boot failed: ${ready.error}`);
    }

    onProgress(`Installing ${files.length} file(s) for ${label}…`);
    boot.contentWindow.postMessage(
      { __nostrapps: 'napp-install', files },
      origin,
    );

    const result = await waitForMessage(
      origin,
      'napp-install-done',
      'napp-install-error',
    );
    if (result.__nostrapps === 'napp-install-error') {
      throw new Error(result.error);
    }
  } finally {
    boot.remove();
  }
}

function waitForMessage(expectedOrigin, successType, errorType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`Timed out waiting for ${successType}`));
    }, BOOT_TIMEOUT_MS);

    const handler = (event) => {
      if (event.origin !== expectedOrigin) return;
      const data = event.data;
      if (!data) return;
      if (
        data.__nostrapps === successType ||
        (errorType && data.__nostrapps === errorType)
      ) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(data);
      }
    };
    window.addEventListener('message', handler);
  });
}

async function handleRpc(data, iframe, signer, nappId) {
  const { id, method, params, instanceId } = data;
  try {
    if (isGated(method)) {
      const allowed = await requireApproval(nappId, method);
      if (!allowed) throw new Error(`Permission denied: ${method}`);
    }
    const result = await dispatch(signer, method, params, instanceId);
    iframe.contentWindow?.postMessage(
      { __nostrapps: 'rpc-result', id, result },
      '*',
    );
  } catch (err) {
    iframe.contentWindow?.postMessage(
      { __nostrapps: 'rpc-error', id, error: err?.message ?? String(err) },
      '*',
    );
  }
}

function dispatch(signer, method, params, instanceId) {
  switch (method) {
    case 'getPublicKey':
      return signer.getPublicKey();
    case 'signEvent':
      return signer.signEvent(params);
    case 'getRelays':
      return signer.getRelays?.() ?? {};
    case 'nip04.encrypt':
      return signer.nip04.encrypt(params.pubkey, params.plaintext);
    case 'nip04.decrypt':
      return signer.nip04.decrypt(params.pubkey, params.ciphertext);
    case 'nip44.encrypt':
      return signer.nip44.encrypt(params.pubkey, params.plaintext);
    case 'nip44.decrypt':
      return signer.nip44.decrypt(params.pubkey, params.ciphertext);
    case 'pool.query':
      return pool.query(params.filters, params.opts);
    case 'pool.publish':
      return pool.publish(params.event, params.opts);
    case 'instance.get':
      return instanceStore.get(instanceId, params.key);
    case 'instance.set':
      return instanceStore.set(instanceId, params.key, params.value);
    case 'instance.delete':
      return instanceStore.del(instanceId, params.key);
    case 'instance.keys':
      return instanceStore.keys(instanceId);
    case 'nostrdb.add':
      return store.add(params.event);
    case 'nostrdb.query':
      return store.query(params.filters);
    case 'nostrdb.count':
      return store.count(params.filters);
    case 'nostrdb.event':
      return store.event(params.id);
    case 'nostrdb.replaceable':
      return store.replaceable(params.kind, params.author, params.identifier);
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}
