let zIndexCounter = 1;
let positionOffset = 0;
let focusTrackerInstalled = false;
// Pinned windows live in a separate stacking tier well above any plausible
// non-pinned counter. The same counter drives ordering inside both tiers, so
// the most-recently-bumped window is on top within its tier.
const PIN_BASE = 100000;

function ensureFocusTracker() {
  if (focusTrackerInstalled) return;
  focusTrackerInstalled = true;
  // Cross-origin iframes don't reliably fire `focus` when their content is
  // clicked, so we poll document.activeElement instead. Whenever the focus
  // lands on a different napp iframe, bring its window to the front.
  let lastFocused = null;
  function tick() {
    const el = document.activeElement;
    if (el && el.tagName === 'IFRAME') {
      const root = el.closest('.napp-window');
      if (root && root !== lastFocused) {
        lastFocused = root;
        bringToFront(root);
      }
    } else {
      lastFocused = null;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

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
  onReorder,
  initial,
  bodyElement, // when provided, mount this DOM node instead of an iframe
  system = false, // trusted in-bundle napp; hides destroy + instance id, no rename
}) {
  const root = document.createElement('div');
  root.className = 'napp-window';
  if (system) root.classList.add('system-napp');
  root.dataset.nappId = nappId;
  root.dataset.instanceId = instanceId;
  // Allow programmatic focus on the window itself (skipped in tab order).
  // Iframe napps focus their iframe; system napps focus the root.
  root.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'napp-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'napp-title';
  titleEl.textContent = petname || nappId;
  if (!system) {
    titleEl.title = 'Double-click to rename';
    if (instanceId) titleEl.dataset.instance = instanceId.slice(0, 8);
  }

  const controls = document.createElement('div');
  controls.className = 'napp-controls';
  const btnMin = makeBtn('–', 'Minimize');
  const btnMax = makeBtn('▢', 'Maximize');
  const btnPin = makeBtn('•', 'Pin on top');
  btnPin.classList.add('napp-btn-pin');
  const btnClose = makeBtn('×', system ? 'Close' : 'Close (keep state)');
  const btnDestroy = makeBtn('⌫', 'Destroy (wipe state)');
  btnDestroy.classList.add('napp-btn-destroy');
  if (system) btnDestroy.hidden = true;
  controls.append(btnMin, btnMax, btnPin, btnClose, btnDestroy);

  header.append(titleEl, controls);

  const body = document.createElement('div');
  body.className = 'napp-body';
  if (system) body.classList.add('napp-body-system');

  let iframe = null;
  if (bodyElement) {
    body.appendChild(bodyElement);
  } else {
    iframe = document.createElement('iframe');
    iframe.sandbox = sandbox;
    // window.name is cross-origin readable from inside the iframe, so the bridge
    // can pick up the instance id without us polluting the URL.
    iframe.name = instanceId || '';
    iframe.src = src;
    body.appendChild(iframe);
  }

  const resizeHandles = {};
  const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  for (const dir of RESIZE_DIRS) {
    const h = document.createElement('div');
    h.className = `napp-resize-handle napp-resize-${dir}`;
    resizeHandles[dir] = h;
  }

  root.append(header, body);
  for (const dir of RESIZE_DIRS) root.appendChild(resizeHandles[dir]);

  const start = initial ?? { ...nextPosition(), width: 640 };
  root.style.left = `${start.left ?? 40}px`;
  root.style.top = `${start.top ?? 40}px`;
  root.style.width = `${start.width ?? 640}px`;
  // Persisted height wins. Otherwise: system napps stay auto so their DOM
  // content drives the size; iframe napps fall back to 420 since cross-origin
  // iframes don't expose intrinsic dimensions.
  if (start.height) {
    root.style.height = `${start.height}px`;
  } else if (!system) {
    root.style.height = `420px`;
  }
  if (start.minimized) root.classList.add('minimized');
  if (start.maximized) root.classList.add('maximized');
  if (start.userSized) root.classList.add('user-sized');
  if (start.pinned) {
    root.classList.add('pinned');
    btnPin.textContent = '●';
    btnPin.title = 'Unpin';
  }
  if (typeof start.zIndex === 'number' && start.zIndex > 0) {
    root.style.zIndex = String(start.zIndex);
    // Bump the shared counter using the *logical* part (subtract pin tier
    // base when restoring a pinned window) so future bringToFront calls land
    // in the right tier without racing past the saved values.
    const logical = start.pinned
      ? Math.max(0, start.zIndex - PIN_BASE)
      : start.zIndex;
    if (logical > zIndexCounter) zIndexCounter = logical;
  } else {
    bringToFront(root);
  }

  let messageHandler = null;
  if (onMessage && iframe) {
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
    const h = parseFloat(root.style.height);
    return {
      nappId,
      instanceId,
      petname: titleEl.textContent,
      left: parseFloat(root.style.left) || 0,
      top: parseFloat(root.style.top) || 0,
      width: parseFloat(root.style.width) || 0,
      // omit when there's no inline height — keeps system-napp auto-sizing
      // intact across reload/restore until the user explicitly resizes.
      height: Number.isFinite(h) && h > 0 ? h : undefined,
      minimized: root.classList.contains('minimized'),
      maximized: root.classList.contains('maximized'),
      pinned: root.classList.contains('pinned'),
      userSized: root.classList.contains('user-sized'),
      zIndex: parseInt(root.style.zIndex, 10) || 0,
    };
  }

  function focus() {
    bringToFront(root);
    if (iframe) iframe.focus();
    else root.focus({ preventScroll: true });
  }

  const notifyState = () => onStateChange?.(getState());

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  btnDestroy.addEventListener('click', (e) => {
    e.stopPropagation();
    const label = titleEl.textContent || nappId;
    const ok = window.confirm(
      `Destroy "${label}"?\n\nThis removes the app and wipes all of its data — files, settings, permissions and any storage it created. This cannot be undone.`,
    );
    if (!ok) return;
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
  btnPin.addEventListener('click', (e) => {
    e.stopPropagation();
    const isPinned = root.classList.toggle('pinned');
    btnPin.textContent = isPinned ? '●' : '•';
    btnPin.title = isPinned ? 'Unpin' : 'Pin on top';
    // Re-stack: pinning lifts into pin tier, unpinning drops to top of normal.
    bringToFront(root);
    notifyState();
  });

  if (!system) {
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(titleEl, (newName) => {
        if (newName) notifyState();
      });
    });
  }

  ensureFocusTracker();
  root.addEventListener('pointerdown', () => bringToFront(root));
  iframe?.addEventListener('focus', () => bringToFront(root));
  // Persist zIndex changes so the stack ordering survives reloads.
  root.addEventListener('napp-zindex-change', () => notifyState());

  setupDrag(root, header, notifyState, onReorder);
  for (const dir of RESIZE_DIRS) {
    setupResize(root, resizeHandles[dir], dir, notifyState);
  }

  return { root, iframe, close, destroy, getState, focus };
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
  const z = el.classList.contains('pinned')
    ? PIN_BASE + zIndexCounter
    : zIndexCounter;
  el.style.zIndex = String(z);
  // Let the window owner know so it can persist the new zIndex.
  el.dispatchEvent(new Event('napp-zindex-change'));
}

function isCompact() {
  return window.matchMedia('(max-width: 723px)').matches;
}

function snapLayout(zone, w, h) {
  switch (zone) {
    case 'top':
      return { left: 0, top: 0, width: w, height: h / 2 };
    case 'left':
      return { left: 0, top: 0, width: w / 2, height: h };
    case 'right':
      return { left: w / 2, top: 0, width: w / 2, height: h };
    case 'bottom':
      return { left: 0, top: h / 2, width: w, height: h / 2 };
    case 'top-left':
      return { left: 0, top: 0, width: w / 2, height: h / 2 };
    case 'top-right':
      return { left: w / 2, top: 0, width: w / 2, height: h / 2 };
    case 'bottom-left':
      return { left: 0, top: h / 2, width: w / 2, height: h / 2 };
    case 'bottom-right':
      return { left: w / 2, top: h / 2, width: w / 2, height: h / 2 };
    default:
      return null;
  }
}

function detectSnapZone(x, y, w, h) {
  const EDGE = 24;
  const CORNER = 56;
  const nearTop = y < EDGE;
  const nearBottom = y > h - EDGE;
  const nearLeft = x < EDGE;
  const nearRight = x > w - EDGE;
  const inCornerY = y < CORNER || y > h - CORNER;
  const inCornerX = x < CORNER || x > w - CORNER;
  if (nearTop && nearLeft && inCornerY && inCornerX) return 'top-left';
  if (nearTop && nearRight && inCornerY && inCornerX) return 'top-right';
  if (nearBottom && nearLeft && inCornerY && inCornerX) return 'bottom-left';
  if (nearBottom && nearRight && inCornerY && inCornerX) return 'bottom-right';
  if (nearTop) return 'top';
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  if (nearBottom) return 'bottom';
  return null;
}

function setupDrag(root, handle, onDone, onReorder) {
  // Desktop float drag: small threshold so the cursor feels responsive.
  // Mobile reorder: bigger threshold + a hold timer so a quick flick to
  // scroll/swipe doesn't accidentally enter reorder mode.
  const FLOAT_THRESHOLD = 2;
  const REORDER_THRESHOLD = 10;
  const REORDER_HOLD_MS = 220;
  // How long the cursor must be *still* in a hot area before its snap layout
  // gets armed/previewed. The timer resets on every pointer movement, so the
  // user has to actually stop, not just hover. Lets you drag through edges
  // and corners without auto-snapping.
  const SNAP_HOVER_MS = 300;
  let mode = null; // 'float' or 'reorder'
  let pending = false;
  let dragging = false;
  let reordering = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let snapZone = null;
  let snapPreview = null;
  // Reorder-mode finger tracking. anchorY is the offset from the window's
  // natural top to the finger at drag start; we keep that offset constant by
  // applying a translateY so the window stays under the finger even as the
  // static stack reflows (heights change, DOM order changes, etc.).
  let anchorY = 0;
  let translateY = 0;

  // Float-drag perf: cache stage geometry at drag start so the move loop
  // never has to read layout (no getBoundingClientRect / offsetWidth in the
  // hot path), batch all DOM writes through requestAnimationFrame, and use
  // `transform` (composited) instead of `left`/`top` (layout) during the
  // drag. Final position is committed to `left`/`top` on pointerup.
  let dragRaf = 0;
  let lastClientX = 0;
  let lastClientY = 0;
  let cachedStageRect = null;
  let cachedStageWidth = 0;
  let cachedStageHeight = 0;
  let cachedMaxLeft = 0;

  // Mobile reorder hold: drag is only allowed to activate once the press has
  // been held this long. Lets quick flicks pass through without entering
  // reorder mode by accident.
  let holdTimer = 0;
  let holdReady = false;

  // Snap zone hover: `pendingZone` is the area the cursor is currently over,
  // `snapZone` is the *armed* zone (preview shown, will snap on release).
  // The hover timer promotes pending → armed after SNAP_HOVER_MS so quick
  // drags through the corners don't accidentally snap.
  let pendingZone = null;
  let snapTimer = 0;

  // Pin the dragged window so its `anchorY` offset stays under `clientY`.
  // We clear the current transform before reading the rect — that way we
  // measure the *natural* top directly, which is immune to any browser
  // quirks around getBoundingClientRect + just-applied transforms (we've
  // hit those on iOS), so translateY can never accumulate drift.
  function pinToFinger(clientY) {
    const desiredTop = clientY - anchorY;
    root.style.transform = '';
    const naturalTop = root.getBoundingClientRect().top;
    translateY = desiredTop - naturalTop;
    root.style.transform = `translateY(${translateY}px)`;
  }

  // Per-frame throttle for the pin so we don't burn forced layouts on every
  // pointermove (touch can fire 100+/sec; the screen only paints at ~60).
  let pinRaf = 0;
  let pinClientY = 0;
  function schedulePin(clientY) {
    pinClientY = clientY;
    if (pinRaf) return;
    pinRaf = requestAnimationFrame(() => {
      pinRaf = 0;
      if (reordering) pinToFinger(pinClientY);
    });
  }

  function updateSnapPreview(zone, stage, stageRect) {
    if (!zone) {
      snapPreview?.remove();
      snapPreview = null;
      return;
    }
    const layout = snapLayout(zone, stageRect.width, stageRect.height);
    if (!layout) return;
    if (!snapPreview) {
      snapPreview = document.createElement('div');
      snapPreview.className = 'snap-preview';
      stage.appendChild(snapPreview);
    }
    // The layout is in viewport-of-stage coordinates (0,0 = current visible
    // top-left). The preview is positioned absolutely inside #stage, whose
    // coordinate system is the *content*, so we offset by the scroll.
    snapPreview.style.left = `${layout.left + stage.scrollLeft}px`;
    snapPreview.style.top = `${layout.top + stage.scrollTop}px`;
    snapPreview.style.width = `${layout.width}px`;
    snapPreview.style.height = `${layout.height}px`;
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (e.target.isContentEditable) return;
    if (root.classList.contains('maximized')) return;
    pending = true;
    startX = e.clientX;
    startY = e.clientY;
    if (isCompact()) {
      mode = 'reorder';
      // capture finger offset from window top so we can keep it pinned later
      anchorY = e.clientY - root.getBoundingClientRect().top;
      translateY = 0;
      holdReady = false;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdReady = true;
        holdTimer = 0;
      }, REORDER_HOLD_MS);
    } else {
      mode = 'float';
      startLeft = root.offsetLeft;
      startTop = root.offsetTop;
      snapZone = null;
    }
  });

  handle.addEventListener('pointermove', (e) => {
    if (!pending && !dragging && !reordering) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (mode === 'reorder') {
      if (pending) {
        if (Math.abs(dy) < REORDER_THRESHOLD) return;
        if (!holdReady) {
          // The user moved too soon — they're trying to flick/scroll, not
          // reorder. Bail out so the touch can do its normal thing.
          pending = false;
          mode = null;
          if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = 0;
          }
          return;
        }
        pending = false;
        reordering = true;
        handle.setPointerCapture(e.pointerId);
        root.classList.add('reordering');
        document.body.classList.add('napp-dragging');
        const parent = root.parentElement;
        if (parent) parent.classList.add('reordering');
        // The classes above shrink every napp to 20vh, which reflows the
        // static stack and would visually jerk the dragged window away from
        // the finger. Pin it back under the finger immediately.
        pinToFinger(e.clientY);
      }
      const stage = root.parentElement;
      if (!stage) return;
      const all = Array.from(stage.children).filter(
        (c) => c.classList?.contains('napp-window'),
      );
      const siblings = all.filter((c) => c !== root);
      let insertBefore = null;
      for (const sib of siblings) {
        const rect = sib.getBoundingClientRect();
        const threshold = rect.top + rect.height * 0.2;
        if (e.clientY < threshold) {
          insertBefore = sib;
          break;
        }
      }
      const wantsMove = insertBefore
        ? root.nextElementSibling !== insertBefore
        : stage.lastElementChild !== root;

      if (wantsMove) {
        // FLIP: snapshot, mutate, animate non-dragged siblings into new positions
        const beforeTops = new Map();
        for (const item of siblings) {
          beforeTops.set(item, item.getBoundingClientRect().top);
        }
        if (insertBefore) {
          stage.insertBefore(root, insertBefore);
        } else {
          stage.appendChild(root);
        }
        // Re-establish pointer capture: re-parenting the captured element
        // can drop the implicit capture in Chromium, after which pointermove
        // would route to whichever (cross-origin) iframe sits under the
        // cursor and we'd stop receiving events.
        try {
          if (!handle.hasPointerCapture?.(e.pointerId)) {
            handle.setPointerCapture(e.pointerId);
          }
        } catch {
          // capture not available; fall back silently
        }
        for (const item of siblings) {
          const oldTop = beforeTops.get(item);
          const newTop = item.getBoundingClientRect().top;
          const dy2 = oldTop - newTop;
          if (Math.abs(dy2) < 1) continue;
          item.style.transition = 'none';
          item.style.transform = `translateY(${dy2}px)`;
          void item.offsetWidth;
          item.style.transition = 'transform 180ms ease';
          item.style.transform = '';
        }
      }

      // Always keep the dragged window under the finger — even when no DOM
      // change happened this frame, the finger may have moved. Throttle to
      // rAF so we coalesce bursts of touch events into one paint.
      schedulePin(e.clientY);
      return;
    }

    // Float drag — threshold check, then schedule a rAF to apply the move
    if (pending && !dragging) {
      if (Math.abs(dx) < FLOAT_THRESHOLD && Math.abs(dy) < FLOAT_THRESHOLD)
        return;
      dragging = true;
      pending = false;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('napp-dragging');
      // Cache stage geometry once so the per-frame loop is layout-free.
      const stage = root.parentElement;
      if (stage) {
        cachedStageRect = stage.getBoundingClientRect();
        cachedStageWidth = stage.clientWidth;
        cachedStageHeight = stage.clientHeight;
        cachedMaxLeft = Math.max(0, cachedStageWidth - root.offsetWidth);
      }
    }
    if (!dragging) return;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    if (!dragRaf) dragRaf = requestAnimationFrame(applyFloatDrag);
  });

  function applyFloatDrag() {
    dragRaf = 0;
    if (!dragging || !cachedStageRect) return;
    const dx = lastClientX - startX;
    const dy = lastClientY - startY;
    // Clamp the translate so the rendered position respects bounds without
    // touching `left` / `top` (no layout pass).
    const targetLeft = Math.max(0, Math.min(cachedMaxLeft, startLeft + dx));
    const targetTop = Math.max(0, startTop + dy);
    const tx = targetLeft - startLeft;
    const ty = targetTop - startTop;
    root.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;

    // Snap detection — pure math against cached stage rect.
    const relX = lastClientX - cachedStageRect.left;
    const relY = lastClientY - cachedStageRect.top;
    const zone = detectSnapZone(
      relX,
      relY,
      cachedStageWidth,
      cachedStageHeight,
    );
    pendingZone = zone;
    // Any movement (this rAF tick only fires because the cursor moved)
    // cancels a pending arm AND disarms a previously-armed preview. The
    // user has to be still for SNAP_HOVER_MS to re-arm it.
    if (snapTimer) {
      clearTimeout(snapTimer);
      snapTimer = 0;
    }
    if (snapZone) {
      snapZone = null;
      updateSnapPreview(null, root.parentElement, cachedStageRect);
    }
    if (zone) {
      // Schedule arm after the cursor has been still for SNAP_HOVER_MS.
      // The next applyFloatDrag tick (= next pointermove) will clear this
      // timer at the top, so it only ever fires when the cursor stops.
      snapTimer = setTimeout(() => {
        snapTimer = 0;
        if (pendingZone === zone) {
          snapZone = zone;
          updateSnapPreview(zone, root.parentElement, cachedStageRect);
        }
      }, SNAP_HOVER_MS);
    }
  }

  const end = (e) => {
    const wasDragging = dragging;
    const wasReordering = reordering;
    const finalZone = snapZone;
    pending = false;
    dragging = false;
    reordering = false;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
    holdReady = false;
    if (snapTimer) {
      clearTimeout(snapTimer);
      snapTimer = 0;
    }
    pendingZone = null;
    snapZone = null;
    snapPreview?.remove();
    snapPreview = null;
    root.classList.remove('reordering');
    document.body.classList.remove('napp-dragging');
    const parent = root.parentElement;
    if (parent) parent.classList.remove('reordering');
    mode = null;
    if (handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    if (wasReordering) {
      // drop the pin-to-finger transform; the window settles into its new
      // natural position in the static stack
      if (pinRaf) {
        cancelAnimationFrame(pinRaf);
        pinRaf = 0;
      }
      root.style.transform = '';
      translateY = 0;
      onReorder?.();
      return;
    }
    if (!wasDragging) return;
    // Cancel any queued rAF and commit the final position to left/top.
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
    }
    if (finalZone) {
      const stage = root.parentElement;
      if (stage) {
        const layout = snapLayout(
          finalZone,
          stage.clientWidth,
          stage.clientHeight,
        );
        if (layout) {
          // Offset by the stage's scroll so the snap targets the *visible*
          // half/quadrant rather than the absolute top of the stage content.
          root.style.left = `${layout.left + stage.scrollLeft}px`;
          root.style.top = `${layout.top + stage.scrollTop}px`;
          root.style.width = `${layout.width}px`;
          root.style.height = `${layout.height}px`;
          // A snap is a deliberate sizing — drop the 420px starter cap so
          // the window can fully fill its half/quadrant.
          root.classList.add('user-sized');
        }
      }
    } else if (cachedStageRect) {
      // Translate-based drag never updated left/top — commit the final
      // position now so future layout queries return correct values.
      const dx = lastClientX - startX;
      const dy = lastClientY - startY;
      const finalLeft = Math.max(0, Math.min(cachedMaxLeft, startLeft + dx));
      const finalTop = Math.max(0, startTop + dy);
      root.style.left = `${finalLeft}px`;
      root.style.top = `${finalTop}px`;
    }
    root.style.transform = '';
    cachedStageRect = null;
    onDone?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function setupResize(root, handle, dir, onDone) {
  const MIN_W = 240;
  // Just a soft floor for drag-resize; the window's CSS `min-height:
  // fit-content` is what actually clamps the rendered size to the napp's
  // own content (header + body content for system napps; just header for
  // cross-origin iframes since they don't propagate intrinsic size).
  const MIN_H = 0;
  const hasN = dir.includes('n');
  const hasS = dir.includes('s');
  const hasE = dir.includes('e');
  const hasW = dir.includes('w');
  const purelyVertical = !hasE && !hasW;

  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let startW = 0;
  let startH = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (root.classList.contains('maximized')) return;
    if (root.classList.contains('minimized') && purelyVertical) return;
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = root.offsetLeft;
    startTop = root.offsetTop;
    startW = root.offsetWidth;
    startH = root.offsetHeight;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const minimized = root.classList.contains('minimized');
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newLeft = startLeft;
    let newTop = startTop;
    let newW = startW;
    let newH = startH;

    if (hasW) {
      const proposedW = startW - dx;
      if (proposedW < MIN_W) {
        newW = MIN_W;
        newLeft = startLeft + (startW - MIN_W);
      } else {
        newW = proposedW;
        newLeft = Math.max(0, startLeft + dx);
      }
    } else if (hasE) {
      newW = Math.max(MIN_W, startW + dx);
    }

    if (!minimized) {
      if (hasN) {
        const proposedH = startH - dy;
        if (proposedH < MIN_H) {
          newH = MIN_H;
          newTop = startTop + (startH - MIN_H);
        } else {
          newH = proposedH;
          newTop = Math.max(0, startTop + dy);
        }
      } else if (hasS) {
        newH = Math.max(MIN_H, startH + dy);
      }
    }

    root.style.left = `${newLeft}px`;
    root.style.width = `${newW}px`;
    if (!minimized) {
      root.style.top = `${newTop}px`;
      root.style.height = `${newH}px`;
    }
  });

  const end = (e) => {
    if (!resizing) return;
    resizing = false;
    if (handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    // User has manually sized this window — drop the 420px starter cap so
    // they can freely grow it. Persisted via state on the next notify.
    root.classList.add('user-sized');
    onDone?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
