let zIndexCounter = 1;
let positionOffset = 0;

export function createNappWindow({
  nappId,
  instanceId,
  origin,
  src,
  petname,
  sandbox = 'allow-scripts allow-same-origin allow-forms',
  onMessage,
  onClose,
  onDestroy,
  onStateChange,
  initial,
}) {
  const root = document.createElement('div');
  root.className = 'napp-window';
  root.dataset.nappId = nappId;
  root.dataset.instanceId = instanceId;

  const header = document.createElement('div');
  header.className = 'napp-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'napp-title';
  titleEl.textContent = petname || nappId;
  titleEl.title = 'Double-click to rename';

  const instanceEl = document.createElement('span');
  instanceEl.className = 'napp-instance-id';
  instanceEl.textContent = instanceId ? instanceId.slice(0, 8) : '';
  instanceEl.title = instanceId ?? '';

  const controls = document.createElement('div');
  controls.className = 'napp-controls';
  const btnMin = makeBtn('–', 'Minimize');
  const btnMax = makeBtn('▢', 'Maximize');
  const btnClose = makeBtn('×', 'Close (keep state)');
  const btnDestroy = makeBtn('⌫', 'Destroy (wipe state)');
  btnDestroy.classList.add('napp-btn-destroy');
  controls.append(btnMin, btnMax, btnClose, btnDestroy);

  header.append(titleEl, instanceEl, controls);

  const body = document.createElement('div');
  body.className = 'napp-body';

  const iframe = document.createElement('iframe');
  iframe.sandbox = sandbox;
  iframe.src = src;
  body.appendChild(iframe);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'napp-resize';
  body.appendChild(resizeHandle);

  root.append(header, body);

  const start = initial ?? { ...nextPosition(), width: 640, height: 420 };
  root.style.left = `${start.left ?? 40}px`;
  root.style.top = `${start.top ?? 40}px`;
  root.style.width = `${start.width ?? 640}px`;
  root.style.height = `${start.height ?? 420}px`;
  if (start.minimized) root.classList.add('minimized');
  if (start.maximized) root.classList.add('maximized');
  bringToFront(root);

  let messageHandler = null;
  if (onMessage) {
    messageHandler = (event) => {
      if (event.origin !== origin) return;
      const data = event.data;
      if (!data || data.instanceId !== instanceId) return;
      onMessage(data, iframe);
    };
    window.addEventListener('message', messageHandler);
  }

  function teardown() {
    if (messageHandler) window.removeEventListener('message', messageHandler);
    root.remove();
  }

  function close() {
    teardown();
    onClose?.(instanceId);
  }

  function destroy() {
    teardown();
    onDestroy?.(instanceId);
  }

  function getState() {
    return {
      nappId,
      instanceId,
      petname: titleEl.textContent,
      left: parseFloat(root.style.left) || 0,
      top: parseFloat(root.style.top) || 0,
      width: parseFloat(root.style.width) || 0,
      height: parseFloat(root.style.height) || 0,
      minimized: root.classList.contains('minimized'),
      maximized: root.classList.contains('maximized'),
    };
  }

  const notifyState = () => onStateChange?.(getState());

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  btnDestroy.addEventListener('click', (e) => {
    e.stopPropagation();
    destroy();
  });
  btnMin.addEventListener('click', (e) => {
    e.stopPropagation();
    root.classList.toggle('minimized');
    notifyState();
  });
  btnMax.addEventListener('click', (e) => {
    e.stopPropagation();
    root.classList.toggle('maximized');
    notifyState();
  });

  titleEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(titleEl, (newName) => {
      if (newName) notifyState();
    });
  });

  root.addEventListener('pointerdown', () => bringToFront(root));

  setupDrag(root, header, notifyState);
  setupResize(root, resizeHandle, notifyState);

  return { root, iframe, close, destroy, getState };
}

function startRename(el, onDone) {
  const original = el.textContent;
  el.contentEditable = 'plaintext-only';
  el.classList.add('editing');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', finish);
    const trimmed = el.textContent.trim();
    if (!trimmed) {
      el.textContent = original;
      onDone(null);
    } else {
      el.textContent = trimmed;
      onDone(trimmed !== original ? trimmed : null);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      el.textContent = original;
      el.blur();
    }
  };

  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', finish);
}

function makeBtn(label, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.className = 'napp-btn';
  return btn;
}

function nextPosition() {
  positionOffset = (positionOffset + 28) % 240;
  return { left: 40 + positionOffset, top: 40 + positionOffset };
}

function bringToFront(el) {
  zIndexCounter++;
  el.style.zIndex = String(zIndexCounter);
}

function setupDrag(root, handle, onDone) {
  const THRESHOLD = 3;
  let pending = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (e.target.isContentEditable) return;
    if (root.classList.contains('maximized')) return;
    pending = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = root.offsetLeft;
    startTop = root.offsetTop;
  });

  handle.addEventListener('pointermove', (e) => {
    if (!pending && !dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (pending && !dragging) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      dragging = true;
      pending = false;
      handle.setPointerCapture(e.pointerId);
    }
    const stage = root.parentElement;
    const stageWidth = stage ? stage.clientWidth : window.innerWidth;
    const windowWidth = root.offsetWidth;
    const maxLeft = Math.max(0, stageWidth - windowWidth);
    root.style.left = `${Math.max(0, Math.min(maxLeft, startLeft + dx))}px`;
    root.style.top = `${Math.max(0, startTop + dy)}px`;
  });

  const end = (e) => {
    const wasDragging = dragging;
    pending = false;
    dragging = false;
    if (handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    if (wasDragging) onDone?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function setupResize(root, handle, onDone) {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (root.classList.contains('maximized')) return;
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = root.offsetWidth;
    startH = root.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    root.style.width = `${Math.max(240, startW + (e.clientX - startX))}px`;
    root.style.height = `${Math.max(120, startH + (e.clientY - startY))}px`;
  });

  const end = (e) => {
    if (!resizing) return;
    resizing = false;
    if (handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    onDone?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
