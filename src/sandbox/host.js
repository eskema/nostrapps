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

export function findOpenWindowByNappId(nappId) {
  for (const win of openWindows.values()) {
    if (win.root.dataset.nappId === nappId) return win;
  }
  return null;
}

// Launcher → iframe dispatch calls (handle / action). Each call gets a
// requestId; the iframe replies with that id once `window.napp.onHandle`
// or `window.napp.onAction` has run.
const pendingDispatches = new Map();
const DISPATCH_TIMEOUT_MS = 30_000;

export function callIframe(instanceId, type, data = {}) {
  const win = openWindows.get(instanceId);
  if (!win || !win.iframe) {
    return Promise.reject(new Error(`No iframe for instance ${instanceId}`));
  }
  const origin = nappOriginFor(win.root.dataset.nappId);
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDispatches.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, DISPATCH_TIMEOUT_MS);
    pendingDispatches.set(requestId, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    win.iframe.contentWindow?.postMessage(
      { __nostrapps: type, requestId, ...data },
      origin,
    );
  });
}

function settleDispatch(data) {
  const p = pendingDispatches.get(data.requestId);
  if (!p) return;
  pendingDispatches.delete(data.requestId);
  if (data.__nostrapps === 'napp-dispatch-result') p.resolve(data.result);
  else p.reject(new Error(data.error || 'dispatch failed'));
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
  ensureStageObserver(stageEl);
  clampToStage(win.root, stageEl);
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
      if (!data) return;
      if (data.__nostrapps === 'rpc') {
        handleRpc(data, iframe, signer, nappId, opts.dispatchHandlers);
        return;
      }
      if (
        data.__nostrapps === 'napp-dispatch-result' ||
        data.__nostrapps === 'napp-dispatch-error'
      ) {
        settleDispatch(data);
        return;
      }
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
  ensureStageObserver(stageEl);
  clampToStage(win.root, stageEl);
  return win;
}

// Lay every visible (non-minimized) window out as a non-overlapping
// partition that fills the inner area. Each call shuffles + repartitions,
// so clicking the tile button repeatedly produces fresh layouts.
//
// We work over a fixed 4×3 grid (12 cells). With N windows we recursively
// split that grid at integer cell lines, so each window gets a rectangular
// region of 1+ whole cells — some 1×1, some 2×1, some 2×2, etc. All cells
// are covered (no empty space). For N > 12 we grow the grid in rows so the
// column width stays consistent.
const TILE_GAP = 8;
const TILE_BASE_COLS = 4;
const TILE_BASE_ROWS = 3;

// Snapshot every visible window's current cell. Used at drag start so the
// live-pack can default to the pre-drag layout: as long as the dragged
// window isn't blocking a window's original cell, that window returns to
// where it started. This lets the user "undo" mid-drag by moving back.
export function capturePackSnapshot(stageEl) {
  if (!stageEl) return new Map();
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl);
  if (innerW <= 0 || innerH <= 0) return new Map();
  const COLS = TILE_BASE_COLS;
  const cellW = innerW / COLS;
  const cellH = innerH / TILE_BASE_ROWS;
  const map = new Map();
  for (const w of openWindows.values()) {
    if (!w.root || !w.root.isConnected) continue;
    if (w.root.classList.contains('minimized')) continue;
    if (w.root.classList.contains('maximized')) continue;
    const px = parseFloat(w.root.style.left) || padL;
    const py = parseFloat(w.root.style.top) || padT;
    const pw = w.root.offsetWidth || cellW;
    const ph = w.root.offsetHeight || cellH;
    const col = Math.max(0, Math.min(COLS - 1, Math.round((px - padL) / cellW)));
    const row = Math.max(0, Math.round((py - padT) / cellH));
    const cols = Math.max(1, Math.min(COLS - col, Math.round(pw / cellW)));
    const rows = Math.max(1, Math.round(ph / cellH));
    map.set(w.root, { col, row, cols, rows });
  }
  return map;
}

// Snap an arbitrary pixel rect to the nearest 4×3 cell rect. Returns the
// snap target in BOTH grid units (col/row/cols/rows) and pixel coords
// (left/top/width/height). The drag handler uses the pixels to position
// the placeholder, and the cell coords to drive live-pack reflow.
export function packCellSnap(stageEl, leftPx, topPx, widthPx, heightPx) {
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl);
  if (innerW <= 0 || innerH <= 0) return null;
  const COLS = TILE_BASE_COLS;
  const cellW = innerW / COLS;
  const cellH = innerH / TILE_BASE_ROWS;
  const cols = Math.max(1, Math.min(COLS, Math.round(widthPx / cellW)));
  const rows = Math.max(1, Math.round(heightPx / cellH));
  const col = Math.max(
    0,
    Math.min(COLS - cols, Math.round((leftPx - padL) / cellW)),
  );
  const row = Math.max(0, Math.round((topPx - padT) / cellH));
  const x0 = Math.round(padL + col * cellW);
  const y0 = Math.round(padT + row * cellH);
  const x1 = Math.round(padL + (col + cols) * cellW);
  const y1 = Math.round(padT + (row + rows) * cellH);
  const half = TILE_GAP / 2;
  return {
    col,
    row,
    cols,
    rows,
    left: x0 + half,
    top: y0 + half,
    width: Math.max(0, x1 - x0 - TILE_GAP),
    height: Math.max(0, y1 - y0 - TILE_GAP),
  };
}

// Module-level timer for clearing the .packing class. Reset on every pack
// so a long drag (many live-pack calls) keeps the transition class on.
let packingClearTimer = null;

// Bin-pack windows into a 4-column grid. Used by the optional pack-mode
// toggle.
//
// Without args: regular pack — sort all windows by weight, place each in
// its desired cell (with first-fit fallback if occupied).
//
// With (focusRoot, focusCell): "live-drag" pack — focusRoot is currently
// being dragged; we don't touch its style (the drag controls it via
// transform). Its cell is stamped as occupied so other windows pack
// around it. Neighbors transition smoothly to make room.
//
// With (focusRoot) and no cell: drop-time pack — the dragged window has
// just committed its drop position to style.left/top. It's processed via
// the regular weight-ordered loop with its lastMovedAt freshly bumped,
// so it wins.
//
// With (..., snapshot): each item prefers its snapshot cell over its
// current style-derived cell. Used during a drag so other windows
// default back to their pre-drag positions whenever the dragged window
// isn't blocking them — the user can revert by moving back.
//
//   - Pinned windows are stamps (immovable obstacles).
//   - Maximized windows are skipped entirely.
//   - Minimized windows are skipped.
//   - Grid grows downward as needed; stage scrolls.
export function bestFitPack(
  stageEl,
  focusRoot = null,
  focusCell = null,
  snapshot = null,
) {
  if (!stageEl) return;
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl);
  if (innerW <= 0 || innerH <= 0) return;

  const COLS = TILE_BASE_COLS;
  const cellW = innerW / COLS;
  const cellH = innerH / TILE_BASE_ROWS;

  const all = Array.from(openWindows.values()).filter((w) => {
    if (!w.root || !w.root.isConnected) return false;
    if (w.root.classList.contains('minimized')) return false;
    if (w.root.classList.contains('maximized')) return false;
    if (getComputedStyle(w.root).position === 'static') return false;
    return true;
  });
  if (all.length === 0) return;

  const focused = focusRoot
    ? all.find((w) => w.root === focusRoot) || null
    : null;

  const stamps = all.filter((w) => w.root.classList.contains('pinned'));
  // Items = all non-pinned, non-focused windows. Focused is positioned
  // separately (or not at all, when the drag's transform owns its style).
  let items = all.filter((w) => !w.root.classList.contains('pinned'));
  if (focused) items = items.filter((w) => w !== focused);

  // Sort items by weight (heaviest first) so the most-stamp-like windows
  // get their desired cells first; lighter ones pack around them.
  //   weight = (lastMovedAt, area)  — both descending
  // The most-recently-moved window holds its position; bigger windows
  // beat smaller ones at equal recency. The dragged window itself is
  // either focus (excluded from items, gets stamped first) or — at drop
  // time — included with a freshly-bumped timestamp, so it wins.
  items.sort((a, b) => {
    const ma = parseInt(a.root.dataset.lastMovedAt, 10) || 0;
    const mb = parseInt(b.root.dataset.lastMovedAt, 10) || 0;
    if (ma !== mb) return mb - ma;
    const aa = a.root.offsetWidth * a.root.offsetHeight;
    const ab = b.root.offsetWidth * b.root.offsetHeight;
    return ab - aa;
  });

  // Lazy occupancy grid (rows × COLS), grows as needed.
  const grid = [];
  const ensureRows = (n) => {
    while (grid.length < n) grid.push(new Array(COLS).fill(false));
  };
  const fits = (col, row, w, h) => {
    if (col < 0 || col + w > COLS) return false;
    ensureRows(row + h);
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (grid[r][c]) return false;
      }
    }
    return true;
  };
  const mark = (col, row, w, h) => {
    ensureRows(row + h);
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        grid[r][c] = true;
      }
    }
  };

  const cellFromPx = (w) => {
    const px = parseFloat(w.root.style.left) || padL;
    const py = parseFloat(w.root.style.top) || padT;
    const pw = w.root.offsetWidth || cellW;
    const ph = w.root.offsetHeight || cellH;
    const col = Math.max(0, Math.min(COLS - 1, Math.round((px - padL) / cellW)));
    const row = Math.max(0, Math.round((py - padT) / cellH));
    const cols = Math.max(1, Math.min(COLS - col, Math.round(pw / cellW)));
    const rows = Math.max(1, Math.round(ph / cellH));
    return { col, row, cols, rows };
  };

  // Add the transition class to items so neighbors slide smoothly. The
  // focused window is excluded — during a live drag it's controlled by
  // transform, and we don't want its left/top change on drop to animate
  // (the user expects it to land where they released, not slide there).
  for (const w of items) w.root.classList.add('packing');
  // Force a style flush so the freshly-added transition rule applies
  // before we mutate the transitioned properties below. Without this,
  // a same-tick add+mutate can skip the transition entirely.
  if (items.length) void items[0].root.offsetHeight;

  // Lay down stamps first so items have to flow around them.
  for (const s of stamps) {
    const { col, row, cols, rows } = cellFromPx(s);
    mark(col, row, cols, rows);
    applyCellRect(s, col, row, cols, rows, padL, padT, cellW, cellH);
  }

  // The focused window claims its cell BEFORE other items pack — this is
  // what makes "drag wins collisions" work. focusCell is provided by the
  // live-drag path (cell from packCellSnap of the cursor's hypothetical
  // position); without it, we read the focused window's current
  // style.left/top (the just-committed drop position).
  if (focused) {
    const fCell = focusCell ?? cellFromPx(focused);
    const c = Math.max(0, Math.min(COLS - fCell.cols, fCell.col));
    const r = Math.max(0, fCell.row);
    mark(c, r, fCell.cols, fCell.rows);
    // If we're at drop time (no focusCell hint), commit the focused
    // window's cell-aligned position too. Skip while live-dragging — the
    // transform owns its position then.
    if (!focusCell) {
      applyCellRect(focused, c, r, fCell.cols, fCell.rows, padL, padT, cellW, cellH);
    }
  }

  for (const item of items) {
    // Prefer the snapshot cell (where this window was at drag start) so
    // an item only relocates when the dragged window is actually blocking
    // its original spot. Without snapshot we fall back to its current
    // style-derived cell — that's the regular non-drag pack path.
    const original = snapshot?.get(item.root);
    const desired = original ?? cellFromPx(item);
    let cols = desired.cols;
    // If the desired cell is free, place there. Otherwise scan top→bottom
    // / left→right for the first available rectangle that fits.
    let placed = null;
    if (fits(desired.col, desired.row, cols, desired.rows)) {
      placed = {
        col: desired.col,
        row: desired.row,
        cols,
        rows: desired.rows,
      };
    } else {
      for (let r = 0; r < 1000 && !placed; r++) {
        for (let c = 0; c <= COLS - cols; c++) {
          if (fits(c, r, cols, desired.rows)) {
            placed = { col: c, row: r, cols, rows: desired.rows };
            break;
          }
        }
      }
    }
    if (!placed) continue;
    mark(placed.col, placed.row, placed.cols, placed.rows);
    applyCellRect(
      item,
      placed.col,
      placed.row,
      placed.cols,
      placed.rows,
      padL,
      padT,
      cellW,
      cellH,
    );
  }

  // Reset the clear timer on each pack so an ongoing drag (multiple
  // live-pack calls) keeps .packing on for as long as the drag lasts.
  if (packingClearTimer) clearTimeout(packingClearTimer);
  packingClearTimer = setTimeout(() => {
    document
      .querySelectorAll('.napp-window.packing')
      .forEach((el) => el.classList.remove('packing'));
    packingClearTimer = null;
  }, 260);
}

function applyCellRect(w, col, row, cols, rows, padL, padT, cellW, cellH) {
  const x0 = Math.round(padL + col * cellW);
  const y0 = Math.round(padT + row * cellH);
  const x1 = Math.round(padL + (col + cols) * cellW);
  const y1 = Math.round(padT + (row + rows) * cellH);
  const half = TILE_GAP / 2;
  const newLeft = `${x0 + half}px`;
  const newTop = `${y0 + half}px`;
  const newW = `${Math.max(0, x1 - x0 - TILE_GAP)}px`;
  const newH = `${Math.max(0, y1 - y0 - TILE_GAP)}px`;
  const changed =
    w.root.style.left !== newLeft ||
    w.root.style.top !== newTop ||
    w.root.style.width !== newW ||
    w.root.style.height !== newH;
  w.root.style.left = newLeft;
  w.root.style.top = newTop;
  w.root.style.width = newW;
  w.root.style.height = newH;
  w.root.style.minWidth = '0';
  w.root.style.minHeight = '0';
  w.root.classList.add('user-sized');
  if (changed) w.notifyState?.();
}

export function tileWindows(stageEl) {
  if (!stageEl) return;
  const { width: innerW, height: innerH, padL, padT } = getStageBounds(stageEl);
  if (innerW <= 0 || innerH <= 0) return;

  const wins = Array.from(openWindows.values()).filter((w) => {
    if (!w.root || !w.root.isConnected) return false;
    if (w.root.classList.contains('minimized')) return false;
    // Mobile static layout doesn't honor left/top — tiling makes no sense.
    if (getComputedStyle(w.root).position === 'static') return false;
    return true;
  });
  if (wins.length === 0) return;

  const shuffled = shuffle(wins.slice());
  const n = shuffled.length;

  // Pick grid dimensions: 4×3 base, growing rows so we always have enough
  // cells (one per window minimum). Columns stay at 4 so cell width is
  // predictable.
  const cols = TILE_BASE_COLS;
  const rows = Math.max(TILE_BASE_ROWS, Math.ceil(n / cols));
  const gridRects = partitionGrid(
    { col: 0, row: 0, cols, rows },
    Math.min(n, cols * rows),
  );

  const cellW = innerW / cols;
  const cellH = innerH / rows;

  for (let i = 0; i < shuffled.length && i < gridRects.length; i++) {
    const w = shuffled[i];
    const g = gridRects[i];
    // Convert grid units to pixels (rounded so adjacent cells share an
    // integer boundary — no sub-pixel overlap or gap from rounding).
    const x0 = Math.round(padL + g.col * cellW);
    const y0 = Math.round(padT + g.row * cellH);
    const x1 = Math.round(padL + (g.col + g.cols) * cellW);
    const y1 = Math.round(padT + (g.row + g.rows) * cellH);
    const half = TILE_GAP / 2;
    const left = x0 + half;
    const top = y0 + half;
    const width = Math.max(0, x1 - x0 - TILE_GAP);
    const height = Math.max(0, y1 - y0 - TILE_GAP);
    // Drop maximized state — it'd override our left/top with !important.
    w.root.classList.remove('maximized');
    w.root.style.left = `${left}px`;
    w.root.style.top = `${top}px`;
    w.root.style.width = `${width}px`;
    w.root.style.height = `${height}px`;
    // The 240px CSS min-width would force narrow cells to render oversized
    // and overlap their neighbors. Override it so the partition is honored.
    // (User can still drag the window wider afterward.)
    w.root.style.minWidth = '0';
    w.root.style.minHeight = '0';
    // First-tile marks the window as user-sized so the 420px cap doesn't
    // claw the height back next render.
    w.root.classList.add('user-sized');
    w.notifyState?.();
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Recursively partition a grid `rect` (in integer cell units) into `n`
// non-overlapping sub-rectangles, also in cell units. Splits land on
// integer cell lines so every output rectangle is whole-cell aligned.
//
// Constraints to avoid losing windows:
//   - Only split if the chosen side has ≥ 2 cells.
//   - Each side must end up with at least as many cells as it has windows
//     (otherwise a deeper recursion would hit "no split possible" with
//      n > 1 and silently drop windows).
function partitionGrid(rect, n) {
  if (n <= 1) return [rect];
  const cells = rect.cols * rect.rows;
  // Caller guarantees `cells >= n`; if somehow not, we can't split safely.
  if (cells <= 1 || n > cells) return [rect];

  // Pick a direction we can actually split + satisfy the cell-count
  // constraint. Try the preferred direction first, fall back to the other.
  const canV = canSplitDirection(rect, n, true);
  const canH = canSplitDirection(rect, n, false);
  if (!canV && !canH) return [rect];

  let vertical;
  if (canV && canH) {
    const wide = rect.cols > rect.rows * 1.2;
    const tall = rect.rows > rect.cols * 1.2;
    vertical = wide ? true : tall ? false : Math.random() < 0.5;
  } else {
    vertical = canV;
  }

  const sideCells = vertical ? rect.cols : rect.rows;
  const otherCells = vertical ? rect.rows : rect.cols;

  // Pick how many windows go on each side, then a cut that fits both.
  // leftN must be in [1, n-1]. Then the valid cut range is
  //   [ceil(leftN / otherCells), sideCells - ceil(rightN / otherCells)].
  // We retry leftN a few times if it produces no valid cut range.
  let leftN = 1 + Math.floor(Math.random() * (n - 1));
  let rightN = n - leftN;
  let minCut = Math.ceil(leftN / otherCells);
  let maxCut = sideCells - Math.ceil(rightN / otherCells);
  if (minCut > maxCut) {
    // Random pick produced no fit. Collect every leftN that does fit and
    // pick one of those at random — keeps the layout diverse instead of
    // always biasing to the smallest valid leftN.
    const valid = [];
    for (let i = 1; i < n; i++) {
      const lo = Math.ceil(i / otherCells);
      const hi = sideCells - Math.ceil((n - i) / otherCells);
      if (lo <= hi) valid.push(i);
    }
    if (valid.length === 0) return [rect]; // shouldn't happen
    leftN = valid[Math.floor(Math.random() * valid.length)];
    rightN = n - leftN;
    minCut = Math.ceil(leftN / otherCells);
    maxCut = sideCells - Math.ceil(rightN / otherCells);
  }

  // Bias cut toward the proportional position with ±1 cell jitter.
  const proportional = Math.round((leftN / n) * sideCells);
  const jitter =
    Math.random() < 0.33 ? -1 : Math.random() < 0.5 ? 1 : 0;
  const cut = Math.max(minCut, Math.min(maxCut, proportional + jitter));

  if (vertical) {
    const a = { col: rect.col, row: rect.row, cols: cut, rows: rect.rows };
    const b = {
      col: rect.col + cut,
      row: rect.row,
      cols: rect.cols - cut,
      rows: rect.rows,
    };
    return [...partitionGrid(a, leftN), ...partitionGrid(b, rightN)];
  }
  const a = { col: rect.col, row: rect.row, cols: rect.cols, rows: cut };
  const b = {
    col: rect.col,
    row: rect.row + cut,
    cols: rect.cols,
    rows: rect.rows - cut,
  };
  return [...partitionGrid(a, leftN), ...partitionGrid(b, rightN)];
}

// Can we split this rect along the given axis such that both sides hold at
// least 1 window, with enough cells for SOME valid (leftN, rightN) pair?
//
// The minimum value of `ceil(leftN/O) + ceil(rightN/O)` over leftN ∈ [1, n-1]
// is ceil(n/O) (attained when one side is a multiple of O). So as long as
// ceil(n / otherCells) ≤ sideCells, a balanced leftN exists that fits.
function canSplitDirection(rect, n, vertical) {
  const sideCells = vertical ? rect.cols : rect.rows;
  if (sideCells < 2) return false;
  const otherCells = vertical ? rect.rows : rect.cols;
  return Math.ceil(n / otherCells) <= sideCells;
}

// Read the stage's effective inner bounds. With `position: absolute` children,
// left/top are measured from the padding edge, so the usable region is
// 0 → (clientW - padLeft - padRight). We return both the bounds and the
// padding so callers (clamp + tile) can use them consistently.
export function getStageBounds(stage) {
  const cs = getComputedStyle(stage);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  return {
    width: Math.max(0, stage.clientWidth - padL - padR),
    height: Math.max(0, stage.clientHeight - padT - padB),
    padL,
    padR,
    padT,
    padB,
  };
}

// Make sure the window's header is reachable inside the stage's visible
// area, AND that the window respects the stage's padding gutter.
//
// `position: absolute` children of a padded ancestor ignore the padding —
// `left: 0` is at the padding box's outer edge, which is the same as the
// stage's outer edge here. So the visual 1rem gutter only exists if we
// actively clamp the window's left/top to ≥ padding.
function clampToStage(root, stage) {
  if (!stage) return;
  // Mobile static layout: nothing to clamp (the layout handles position).
  if (getComputedStyle(root).position === 'static') return;
  const { padL, padR, padT, padB } = getStageBounds(stage);
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (W <= 0 || H <= 0) return;
  const left = parseFloat(root.style.left) || 0;
  const top = parseFloat(root.style.top) || 0;
  const width = root.offsetWidth || parseFloat(root.style.width) || 240;
  // Always leave at least this much of the window inside the stage so the
  // user can grab the header. Header height ≈ 28px on desktop, 40px on mobile.
  const minVisibleX = Math.min(80, width);
  const minLeft = padL;
  const minTop = padT;
  const maxLeft = Math.max(minLeft, W - padR - minVisibleX);
  const maxTop = Math.max(minTop, H - padB - 28);
  const newLeft = Math.max(minLeft, Math.min(maxLeft, left));
  const newTop = Math.max(minTop, Math.min(maxTop, top));
  if (newLeft !== left) root.style.left = `${newLeft}px`;
  if (newTop !== top) root.style.top = `${newTop}px`;
}

let stageObserver = null;
function ensureStageObserver(stageEl) {
  if (stageObserver) return;
  stageObserver = new ResizeObserver(() => {
    for (const win of openWindows.values()) {
      clampToStage(win.root, stageEl);
    }
  });
  stageObserver.observe(stageEl);
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

async function handleRpc(data, iframe, signer, nappId, dispatchHandlers) {
  const { id, method, params, instanceId } = data;
  try {
    if (isGated(method)) {
      const allowed = await requireApproval(nappId, method);
      if (!allowed) throw new Error(`Permission denied: ${method}`);
    }
    // Signer can be passed either as an object (legacy) or as a getter
    // (`() => currentSigner()`). The getter form lets the user hot-swap
    // signer types (NIP-07 ↔ NIP-46) without forcing a napp reload.
    const resolvedSigner = typeof signer === 'function' ? signer() : signer;
    const result = await dispatch(
      resolvedSigner,
      method,
      params,
      instanceId,
      nappId,
      dispatchHandlers,
    );
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

function dispatch(signer, method, params, instanceId, callerNappId, dispatchHandlers) {
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
    case 'napp.handle':
      if (!dispatchHandlers?.handle) {
        throw new Error('napp.handle dispatch is not configured');
      }
      return dispatchHandlers.handle(callerNappId, params?.event);
    case 'napp.action':
      if (!dispatchHandlers?.action) {
        throw new Error('napp.action dispatch is not configured');
      }
      return dispatchHandlers.action(callerNappId, params?.name, params?.payload);
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}
