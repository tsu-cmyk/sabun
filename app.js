/**
 * SABUN PWA — app.js (v1)
 **/

import * as pdfjsLib from './lib/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.mjs';

// ─────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────
const DIFF_THRESHOLD  = 15;
const HIGHLIGHT_COLOR = [255, 75, 0];
const THUMB_SCALE     = 0.12;
const MAX_CACHE       = 1; // キャッシュ
const DPR             = 3.0; // レンダリング品質

// テキスト・フォント
const PDF_LOAD_OPTS = {
  cMapUrl: 'https://unpkg.com/pdfjs-dist@4.9.155/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@4.9.155/standard_fonts/',
  useSystemFonts: false,
  isEvalSupported: false,
  verbosity: 0,
};

// ─────────────────────────────────────────────────────────
// アプリ状態
// ─────────────────────────────────────────────────────────
const state = {
  docA: null, docB: null,
  nameA: '', nameB: '',
  pageA: 0, pageB: 0,
  totalA: 0, totalB: 0,
  diffPages: new Set(),

  // Pan & Zoom
  zoomFactor: 1.0,
  panX: 0,
  panY: 0,

  // インタラクションモード
  persistentMode: 'cursor', // 'cursor'|'drag'|'offset'|'zoom_in'|'zoom_out'|'marquee'
  activeMode:     'cursor',
  tempModeActive: false,
  keysDown: new Set(),

  // マウス関連
  panPointer: null,
  offsetDragStart: null,
  marqueeStart: null,

  // オフセット
  offsetDx: 0,
  offsetDy: 0,

  // あおり
  aoriTimer: null, aoriFlag: false, aoriImgA: null, aoriImgB: null,
  aoriInterval: 300,

  // タブ
  activeSubTab: 'a',
};

// LRU キャッシュ
const cacheA = new Map();
const cacheB = new Map();

// ─────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const viewContainer = $('view-container');
const viewCanvas    = $('view-canvas');
const viewPlaceholder = $('view-placeholder');
const marqueeBox    = $('marquee-box');
const scanProgress  = $('scan-progress');
const zoomLabel     = $('zoom-label');
const statusZoom    = $('status-zoom');
const statusMsg     = $('status-msg');
const pageInfo      = $('page-info');
const thumbListA    = $('thumb-list-a');
const thumbListB    = $('thumb-list-b');
const filenameA     = $('sidebar-filename-a');
const filenameB     = $('sidebar-filename-b');
const diffPanel     = $('diff-summary-panel');
const diffList      = $('diff-summary-list');
const dropOverlay   = $('drop-overlay');

const btnDragMode    = $('btn-drag-mode');
const btnOffsetMode  = $('btn-offset-mode');
const btnOffsetReset = $('btn-offset-reset');
const btnMarqueeZoom = $('btn-marquee-zoom');
const btnDiffList    = $('btn-diff-list');
const zoomCombo      = $('zoom-combo');

const aoriControls   = $('aori-controls');
const aoriSpeedSlider= $('aori-speed-slider');
const aoriSpeedLabel = $('aori-speed-label');

const btnHelp        = $('btn-help');
const helpModal      = $('help-modal');
const btnCloseHelp   = $('btn-close-help');

// ─────────────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────────────
let statusTimer = null;
function setStatus(msg, duration = 0) {
  statusMsg.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  if (duration > 0) statusTimer = setTimeout(() => { statusMsg.textContent = ''; }, duration);
}

// ─────────────────────────────────────────────────────────
// PDF RENDERING
// ─────────────────────────────────────────────────────────
async function renderPage(doc, pageIndex, scale = DPR) {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  const w  = Math.ceil(vp.width);
  const h  = Math.ceil(vp.height);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  await page.render({
    canvasContext: ctx,
    viewport: vp,
    annotationMode: pdfjsLib.AnnotationMode.DISABLE
  }).promise;

  return ctx.getImageData(0, 0, w, h);
}

async function renderThumb(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: THUMB_SCALE * DPR });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  return canvas.toDataURL('image/jpeg', 0.75);
}

// ─────────────────────────────────────────────────────────
// CACHE (軽量化のためLRU削減)
// ─────────────────────────────────────────────────────────
function cacheGet(map, key) {
  if (!map.has(key)) return null;
  const v = map.get(key); map.delete(key); map.set(key, v);
  return v;
}
function cacheSet(map, key, val) {
  map.delete(key); map.set(key, val);
  if (map.size > MAX_CACHE) map.delete(map.keys().next().value);
}
async function getOrRenderA(idx) {
  let c = cacheGet(cacheA, idx);
  if (c) return c;
  c = await renderPage(state.docA, idx);
  cacheSet(cacheA, idx, c); return c;
}
async function getOrRenderB(idx) {
  let c = cacheGet(cacheB, idx);
  if (c) return c;
  c = await renderPage(state.docB, idx);
  cacheSet(cacheB, idx, c); return c;
}

// ─────────────────────────────────────────────────────────
// IMAGE PROCESSING HELPERS
// ─────────────────────────────────────────────────────────
function applyOffsetAndMatchSize(imgB, imgA) {
  const tw = imgA.width, th = imgA.height;
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, th);
  const tmp = document.createElement('canvas');
  tmp.width = imgB.width; tmp.height = imgB.height;
  tmp.getContext('2d').putImageData(imgB, 0, 0);
  ctx.drawImage(tmp, state.offsetDx, state.offsetDy, imgB.width, imgB.height);
  return ctx.getImageData(0, 0, tw, th);
}

function computeHighlightDiff(imgA, imgB) {
  const w = imgA.width, h = imgA.height;
  const out = new ImageData(w, h);
  const a = imgA.data, b = imgB.data, o = out.data;
  const thr = DIFF_THRESHOLD;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4;
    const ya = a[p]*0.299 + a[p+1]*0.587 + a[p+2]*0.114;
    const yb = b[p]*0.299 + b[p+1]*0.587 + b[p+2]*0.114;
    const diff = ya - yb;
    if (Math.abs(diff) > thr) {
      if (diff > 0) {
        o[p]=255; o[p+1]=75; o[p+2]=0; o[p+3]=255;
      } else {
        o[p]=0; o[p+1]=196; o[p+2]=255; o[p+3]=255;
      }
    } else {
      o[p]=(a[p]*0.3)|0; o[p+1]=(a[p+1]*0.3)|0; o[p+2]=(a[p+2]*0.3)|0; o[p+3]=255;
    }
  }
  return out;
}

function computeAbsDiff(imgA, imgB) {
  const w = imgA.width, h = imgA.height;
  const out = new ImageData(w, h);
  const a = imgA.data, b = imgB.data, o = out.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4;
    const d = Math.abs((a[p]*0.299+a[p+1]*0.587+a[p+2]*0.114) - (b[p]*0.299+b[p+1]*0.587+b[p+2]*0.114))|0;
    o[p]=d; o[p+1]=d; o[p+2]=d; o[p+3]=255;
  }
  return out;
}

function hasDiff(imgA, imgB, threshold=10, minPx=10) {
  const a = imgA.data, b = imgB.data;
  if (a.length !== b.length) return true;
  let cnt = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ya = (a[i]*0.299 + a[i+1]*0.587 + a[i+2]*0.114) | 0;
    const yb = (b[i]*0.299 + b[i+1]*0.587 + b[i+2]*0.114) | 0;
    if (Math.abs(ya - yb) > threshold) {
      if (++cnt > minPx) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// PAN & ZOOM (Transform Based for Infinite Panning)
// ─────────────────────────────────────────────────────────
function displayImageData(imgData) {
  if (!imgData) { showPlaceholder(); return; }
  viewCanvas.width  = imgData.width;
  viewCanvas.height = imgData.height;
  viewCanvas.getContext('2d').putImageData(imgData, 0, 0);
  viewCanvas.style.display = 'block';
  viewPlaceholder.style.display = 'none';
  applyTransform();
}

function showPlaceholder() {
  viewCanvas.style.display = 'none';
  viewPlaceholder.style.display = 'flex';
}

function applyTransform() {
  if (viewCanvas.style.display === 'none') return;
  viewCanvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoomFactor})`;
  const pct = Math.round(state.zoomFactor * 100) + '%';
  zoomLabel.textContent = pct;
  statusZoom.textContent = pct;
  if (zoomCombo) zoomCombo.value = pct;
}

function fitToView() {
  const cw = viewCanvas.width || 1;
  const ch = viewCanvas.height || 1;
  const vw = viewContainer.clientWidth;
  const vh = viewContainer.clientHeight;
  const margin = 40;
  state.zoomFactor = Math.min((vw - margin) / cw, (vh - margin) / ch, 1.0);
  state.panX = (vw - cw * state.zoomFactor) / 2;
  state.panY = (vh - ch * state.zoomFactor) / 2;
  applyTransform();
}

function zoomAtPoint(px, py, factor) {
  const oz = state.zoomFactor;
  const nz = Math.min(10, Math.max(0.01, oz * factor));
  const rect = viewContainer.getBoundingClientRect();
  const relX = px - rect.left;
  const relY = py - rect.top;

  const cx = (relX - state.panX) / oz;
  const cy = (relY - state.panY) / oz;

  state.zoomFactor = nz;
  state.panX = relX - cx * nz;
  state.panY = relY - cy * nz;
  applyTransform();
}

function zoomCenterBy(factor) {
  const rect = viewContainer.getBoundingClientRect();
  zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

// ─────────────────────────────────────────────────────────
// INTERACTION MODE
// ─────────────────────────────────────────────────────────
const CURSORS = {
  cursor:   'default',
  drag:     'grab',
  offset:   'move',
  zoom_in:  'zoom-in',
  zoom_out: 'zoom-out',
  marquee:  'crosshair',
};

function updateModeFromKeys() {
  const isCtrl  = state.keysDown.has('Control') || state.keysDown.has('Meta');
  const isAlt   = state.keysDown.has('Alt');
  const isSpace = state.keysDown.has(' ');
  const isShift = state.keysDown.has('Shift');

  let newMode = state.persistentMode;
  let isTemp  = false;

  // オフセットモード中じゃない場合のみ、Shiftでの短形ズームを許可する
  if (isShift && !isSpace && !isCtrl && !isAlt && state.persistentMode !== 'offset') {
    newMode = 'marquee'; isTemp = true;
  } else if (isSpace) {
    if (isCtrl && isAlt) { newMode = 'zoom_out'; isTemp = true; }
    else if (isCtrl)     { newMode = 'zoom_in';  isTemp = true; }
    else                 { newMode = 'drag';      isTemp = true; }
  }

  state.tempModeActive = isTemp;
  if (state.activeMode !== newMode) {
    state.activeMode = newMode;
    applyModeCursor();
  }
}

function applyModeCursor() {
  viewCanvas.style.cursor = CURSORS[state.activeMode] || 'default';
  btnDragMode.classList.toggle('active', state.persistentMode === 'drag');
  btnOffsetMode.classList.toggle('active', state.persistentMode === 'offset');
  btnMarqueeZoom.classList.toggle('active', state.persistentMode === 'marquee');
}

function setPersistentMode(mode) {
  if (state.persistentMode === mode) mode = 'cursor';
  state.persistentMode = mode;
  if (!state.tempModeActive) {
    state.activeMode = mode;
    applyModeCursor();
  }
}

// ─────────────────────────────────────────────────────────
// MOUSE EVENTS
// ─────────────────────────────────────────────────────────
viewContainer.addEventListener('mousedown', e => {
  const mode = state.activeMode;
  const rect = viewContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (mode === 'drag') {
    e.preventDefault();
    state.panPointer = { startX: e.clientX, startY: e.clientY, initPanX: state.panX, initPanY: state.panY };
    viewCanvas.style.cursor = 'grabbing';
  } else if (mode === 'offset') {
    e.preventDefault();
    state.offsetDragStart = { x: e.clientX, y: e.clientY, dx: state.offsetDx, dy: state.offsetDy };
  } else if (mode === 'marquee' && viewCanvas.style.display !== 'none') {
    e.preventDefault();
    state.marqueeStart = { x: mouseX, y: mouseY };
    marqueeBox.style.left = mouseX + 'px';
    marqueeBox.style.top  = mouseY + 'px';
    marqueeBox.style.width  = '0px';
    marqueeBox.style.height = '0px';
    marqueeBox.style.display = 'block';
  }
});

viewContainer.addEventListener('mousemove', e => {
  const rect = viewContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (state.panPointer) {
    const p = state.panPointer;
    state.panX = p.initPanX + (e.clientX - p.startX);
    state.panY = p.initPanY + (e.clientY - p.startY);
    applyTransform();
  } else if (state.offsetDragStart) {
    const d = state.offsetDragStart;
    const newDx = d.dx + (e.clientX - d.x) * (1/state.zoomFactor);
    const newDy = d.dy + (e.clientY - d.y) * (1/state.zoomFactor);
    if (e.shiftKey && e.altKey) { state.offsetDx = newDx; state.offsetDy = newDy; } 
    else if (e.shiftKey) state.offsetDx = newDx;
    else if (e.altKey) state.offsetDy = newDy;
    else { state.offsetDx = newDx; state.offsetDy = newDy; }
    updateOffsetLabel(); renderCurrentView();
  } else if (state.marqueeStart) {
    const x = Math.min(mouseX, state.marqueeStart.x);
    const y = Math.min(mouseY, state.marqueeStart.y);
    const w = Math.abs(mouseX - state.marqueeStart.x);
    const h = Math.abs(mouseY - state.marqueeStart.y);
    marqueeBox.style.left = x + 'px';
    marqueeBox.style.top  = y + 'px';
    marqueeBox.style.width  = w + 'px';
    marqueeBox.style.height = h + 'px';
  }
});

function finishMarqueeZoom(mouseX, mouseY) {
  marqueeBox.style.display = 'none';
  if (!state.marqueeStart) return;
  const x = Math.min(mouseX, state.marqueeStart.x);
  const y = Math.min(mouseY, state.marqueeStart.y);
  const w = Math.abs(mouseX - state.marqueeStart.x);
  const h = Math.abs(mouseY - state.marqueeStart.y);
  state.marqueeStart = null;
  if (w < 10 || h < 10) return;

  const cx = (x - state.panX) / state.zoomFactor;
  const cy = (y - state.panY) / state.zoomFactor;
  const cw = w / state.zoomFactor;
  const ch = h / state.zoomFactor;

  const vw = viewContainer.clientWidth;
  const vh = viewContainer.clientHeight;
  const nz = Math.min(vw / cw, vh / ch, 10);
  
  const newPanX = (vw - cw * nz) / 2 - cx * nz;
  const newPanY = (vh - ch * nz) / 2 - cy * nz;

  state.zoomFactor = nz;
  state.panX = newPanX;
  state.panY = newPanY;
  applyTransform();
  setPersistentMode('cursor');
}

window.addEventListener('mouseup', e => {
  const rect = viewContainer.getBoundingClientRect();
  if (state.panPointer) {
    state.panPointer = null;
    viewCanvas.style.cursor = CURSORS[state.activeMode] || 'default';
  }
  state.offsetDragStart = null;
  if (state.marqueeStart) {
    finishMarqueeZoom(e.clientX - rect.left, e.clientY - rect.top);
  }
});

viewContainer.addEventListener('click', e => {
  if (state.activeMode === 'zoom_in') zoomAtPoint(e.clientX, e.clientY, 1.25);
  else if (state.activeMode === 'zoom_out') zoomAtPoint(e.clientX, e.clientY, 0.8);
});

viewContainer.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9);
  }
}, { passive: false });

// ─────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  state.keysDown.add(e.key);
  updateModeFromKeys();
  if (e.code === 'Space') { e.preventDefault(); return; }

  const ctrl = e.ctrlKey || e.metaKey;
  const alt  = e.altKey;

  // ページ移動
  if (!ctrl && (e.key === ',' || e.key === 'ArrowUp'))   { e.preventDefault(); changePage(-1); return; }
  if (!ctrl && (e.key === '.' || e.key === 'ArrowDown')) { e.preventDefault(); changePage(1);  return; }

  // ズーム
  if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomCenterBy(1.25); return; }
  if (ctrl && e.key === '-')  { e.preventDefault(); zoomCenterBy(0.8); return; }
  if (ctrl && e.key === '0')  { e.preventDefault(); fitToView(); return; }

  // 丸ボタン/サブタブ切替
  if (!ctrl && !alt && /^[1-5]$/.test(e.key)) {
    const tabMap = ['a','b','highlight','absdiff','aori'];
    switchSubTab(tabMap[parseInt(e.key) - 1]); return;
  }

  // モード切替
  if (ctrl && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setPersistentMode('drag'); return; }
  if (!ctrl && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); setPersistentMode('marquee'); return; }

  // UI
  if (ctrl && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); toggleDiffPanel(); return; }
  if (ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); exportCurrentView(); return; }

  // PDF
  if (ctrl && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); $('file-input-a').click(); return; }
  if (ctrl && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); $('file-input-b').click(); return; }
});

document.addEventListener('keyup', e => {
  state.keysDown.delete(e.key); updateModeFromKeys();
});

// ─────────────────────────────────────────────────────────
// LOAD PDF
// ─────────────────────────────────────────────────────────
async function loadPDF(side, file) {
  setStatus(`${side === 'a' ? 'A' : 'B'} を読込中: ${file.name}`);
  try {
    const ab  = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: ab, ...PDF_LOAD_OPTS }).promise;
    if (side === 'a') {
      state.docA = doc; state.nameA = file.name; state.pageA = 0; state.totalA = doc.numPages;
      filenameA.textContent = shortenName(file.name); cacheA.clear();
    } else {
      state.docB = doc; state.nameB = file.name; state.pageB = 0; state.totalB = doc.numPages;
      filenameB.textContent = shortenName(file.name); cacheB.clear();
    }
    state.diffPages.clear(); buildThumbList(side); updateNavButtons();

    if (state.docA && state.docB) {
      switchSubTab('highlight');
      await renderCurrentView(true);
      startDiffScan();
    } else {
      await renderCurrentView(true);
    }
    setStatus(`${side === 'a' ? 'A' : 'B'} 読込完了: ${file.name}`, 4000);
  } catch (err) {
    setStatus(`読込エラー: ${err.message}`, 6000); console.error(err);
  }
}

function shortenName(name, max = 26) {
  return name.length <= max ? name : name.slice(0, 11) + '...' + name.slice(-11);
}

// ─────────────────────────────────────────────────────────
// THUMBNAILS
// ─────────────────────────────────────────────────────────
function buildThumbList(side) {
  const list  = side === 'a' ? thumbListA : thumbListB;
  const doc   = side === 'a' ? state.docA  : state.docB;
  const total = doc ? doc.numPages : 0;
  list.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const curPage = side === 'a' ? state.pageA : state.pageB;
    const div = document.createElement('div');
    div.className = 'thumb-item' + (i === curPage ? ' active' : '');
    div.dataset.page = i; div.dataset.side = side;
    div.innerHTML = `
      <div class="thumb-img-placeholder" id="th-${side}-${i}">📄</div>
      <div class="thumb-info">
        <div class="thumb-page-num">
          <span class="thumb-diff-badge" id="badge-${side}-${i}">${state.diffPages.has(i) ? '⚡️' : ''}</span>
          Page ${i + 1}
        </div>
      </div>`;
    div.addEventListener('click', () => {
      if (side === 'a') state.pageA = i; else state.pageB = i;
      syncPageIndex(); renderCurrentView(true);
    });
    list.appendChild(div);
  }
  if (doc) generateThumbs(side, doc, total);
}
async function generateThumbs(side, doc, total) {
  for (let i = 0; i < total; i++) {
    try {
      const url = await renderThumb(doc, i);
      const ph  = document.getElementById(`th-${side}-${i}`);
      if (ph) {
        const img = document.createElement('img');
        img.src = url; img.className = 'thumb-img';
        ph.replaceWith(img);
      }
    } catch { /* ignore */ }
  }
}
function updateThumbHighlight(side) {
  const list    = side === 'a' ? thumbListA : thumbListB;
  const curPage = side === 'a' ? state.pageA : state.pageB;
  list.querySelectorAll('.thumb-item').forEach(el => {
    const active = parseInt(el.dataset.page) === curPage;
    el.classList.toggle('active', active);
    if (active) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}
function refreshDiffBadges() {
  ['a', 'b'].forEach(side => {
    const total = side === 'a' ? state.totalA : state.totalB;
    for (let i = 0; i < total; i++) {
      const b = document.getElementById(`badge-${side}-${i}`);
      if (b) b.textContent = state.diffPages.has(i) ? '⚡️' : '';
    }
  });
}

// ─────────────────────────────────────────────────────────
// BACKGROUND DIFF SCAN
// ─────────────────────────────────────────────────────────
async function startDiffScan() {
  if (!state.docA || !state.docB) return;
  state.diffPages.clear();
  const total = Math.min(state.totalA, state.totalB);
  setStatus(`全自動スキャン中...`);
  scanProgress.style.width = '0%';
  for (let i = 0; i < total; i++) {
    try {
      // スキャン用は低解像度でOK(メモリ節約のため scale=1.0)
      const [ia, ib] = await Promise.all([renderPage(state.docA, i, 1.0), renderPage(state.docB, i, 1.0)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        state.diffPages.add(i);
      } else if (hasDiff(ia, ib)) {
        state.diffPages.add(i);
      }
    } catch { state.diffPages.add(i); }
    scanProgress.style.width = Math.round((i + 1) / total * 100) + '%';
    await new Promise(r => setTimeout(r, 0));
  }
  scanProgress.style.width = '0%';
  setStatus(`${state.diffPages.size}ページに差分があります。`, 5000);
  btnDiffList.disabled = false;
  refreshDiffBadges(); rebuildDiffSummaryPanel();
}
function applyOffsetAndMatchSizeSimple(imgA, imgB) {
  if (imgA.width === imgB.width && imgA.height === imgB.height && state.offsetDx === 0 && state.offsetDy === 0) return imgB;
  const c = document.createElement('canvas');
  c.width = imgA.width; c.height = imgA.height;
  const ctx = c.getContext('2d', {alpha:false});
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height);
  const tmp = document.createElement('canvas');
  tmp.width = imgB.width; tmp.height = imgB.height;
  tmp.getContext('2d').putImageData(imgB, 0, 0);
  ctx.drawImage(tmp, state.offsetDx, state.offsetDy, imgB.width, imgB.height);
  return ctx.getImageData(0,0,imgA.width,imgA.height);
}

// ─────────────────────────────────────────────────────────
// RENDER CURRENT VIEW
// ─────────────────────────────────────────────────────────
let _renderToken = 0;
async function renderCurrentView(forceFit = false) {
  const token = ++_renderToken;
  const tab = state.activeSubTab;
  
  stopAori(); 
  if (tab === 'aori') aoriControls.style.display = 'flex';
  else aoriControls.style.display = 'none';

  // A のみ / B のみ
  if (tab === 'a') {
    if (!state.docA) return showPlaceholder();
    const img = await getOrRenderA(state.pageA);
    if (token !== _renderToken) return;
    displayImageData(img); if (forceFit) fitToView(); return;
  }
  if (tab === 'b') {
    if (!state.docB) return showPlaceholder();
    const img = await getOrRenderB(state.pageB);
    if (token !== _renderToken) return;
    displayImageData(img); if (forceFit) fitToView(); return;
  }

  // A, B 必須
  if (!state.docA || !state.docB) return showPlaceholder();
  const [imgA, imgBRaw] = await Promise.all([getOrRenderA(state.pageA), getOrRenderB(state.pageB)]);
  if (token !== _renderToken) return;
  const imgB = applyOffsetAndMatchSize(imgBRaw, imgA);

  let res;
  switch (tab) {
    case 'highlight': res = computeHighlightDiff(imgA, imgB); break;
    case 'absdiff':   res = computeAbsDiff(imgA, imgB); break;
    case 'aori':      displayImageData(imgA); if (forceFit) fitToView(); startAori(imgA, imgB); return;
    default:          res = imgA;
  }
  displayImageData(res);
  if (forceFit) fitToView();
}

function startAori(imgA, imgB) {
  state.aoriImgA = imgA; state.aoriImgB = imgB; state.aoriFlag = false;
  state.aoriTimer = setInterval(() => {
    displayImageData(state.aoriFlag ? state.aoriImgB : state.aoriImgA);
    state.aoriFlag = !state.aoriFlag;
  }, state.aoriInterval);
}
function stopAori() {
  if (state.aoriTimer) { clearInterval(state.aoriTimer); state.aoriTimer = null; }
  state.aoriImgA = null; state.aoriImgB = null;
}

// ─────────────────────────────────────────────────────────
// PAGE NAVIGATION
// ─────────────────────────────────────────────────────────
function syncPageIndex() {
  updateThumbHighlight('a'); updateThumbHighlight('b');
  updateNavButtons(); updatePageInfo();
  if (diffPanel.classList.contains('visible')) rebuildDiffSummaryPanel();
}
function updatePageInfo() {
  const la = state.docA ? `A: ${state.pageA + 1}/${state.totalA}` : 'A: —';
  const lb = state.docB ? `B: ${state.pageB + 1}/${state.totalB}` : 'B: —';
  pageInfo.textContent = `${la}  ${lb}`;
}
function updateNavButtons() {
  $('btn-prev').disabled = state.pageA <= 0 && state.pageB <= 0;
  $('btn-next').disabled = (!state.docA || state.pageA >= state.totalA - 1) && (!state.docB || state.pageB >= state.totalB - 1);
  updatePageInfo();
}
function changePage(delta) {
  let changed = false;
  if (state.docA && state.pageA + delta >= 0 && state.pageA + delta < state.totalA) { state.pageA += delta; changed = true; }
  if (state.docB && state.pageB + delta >= 0 && state.pageB + delta < state.totalB) { state.pageB += delta; changed = true; }
  if (changed) { syncPageIndex(); renderCurrentView(true); } 
}
function goToPage(idx) {
  let changed = false;
  if (state.docA && idx >= 0 && idx < state.totalA) { state.pageA = idx; changed = true; }
  if (state.docB && idx >= 0 && idx < state.totalB) { state.pageB = idx; changed = true; }
  if (changed) { syncPageIndex(); renderCurrentView(true); }
}

// ─────────────────────────────────────────────────────────
// OFFSET ADJUSTMENT
// ─────────────────────────────────────────────────────────
function resetOffset() {
  state.offsetDx = 0; state.offsetDy = 0; updateOffsetLabel();
  if (['highlight','absdiff','aori'].includes(state.activeSubTab)) renderCurrentView();
}
function updateOffsetLabel() {
  const lbl = document.getElementById('offset-label');
  if (lbl) lbl.textContent = `dx:${Math.round(state.offsetDx)}  dy:${Math.round(state.offsetDy)}`;
}

// ─────────────────────────────────────────────────────────
// DIFF SUMMARY PANEL
// ─────────────────────────────────────────────────────────
function rebuildDiffSummaryPanel() {
  const total = Math.max(state.totalA, state.totalB);
  diffList.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const hasDiff = state.diffPages.has(i);
    const div = document.createElement('div');
    div.className = `diff-summary-item${hasDiff?' has-diff':''}${i === state.pageA?' current':''}`;
    div.textContent = (hasDiff ? '⚡️ ' : '') + `Page ${i + 1}`;
    div.addEventListener('click', () => { goToPage(i); rebuildDiffSummaryPanel(); });
    diffList.appendChild(div);
  }
}
function jumpToDiff(dir) {
  const sorted = [...state.diffPages].sort((a,b) => a - b);
  if (!sorted.length) return;
  const cur = state.pageA;
  const target = dir === 'next' ? (sorted.find(p => p > cur) ?? sorted[0]) : ([...sorted].reverse().find(p => p < cur) ?? sorted[sorted.length - 1]);
  goToPage(target); rebuildDiffSummaryPanel();
}
function toggleDiffPanel() {
  if (!state.docA && !state.docB) return;
  diffPanel.classList.toggle('visible');
  if (diffPanel.classList.contains('visible')) rebuildDiffSummaryPanel();
}

// ─────────────────────────────────────────────────────────
// OTHERS
// ─────────────────────────────────────────────────────────
function exportCurrentView() {
  if (viewCanvas.style.display === 'none') { setStatus('表示中の画像がありません', 3000); return; }
  const link = document.createElement('a');
  link.download = `sabun_${state.activeSubTab}_A${state.pageA+1}_B${state.pageB+1}.png`;
  link.href = viewCanvas.toDataURL('image/png');
  link.click();
  setStatus('画像を保存しました。', 3000);
}

function switchSubTab(subTab) {
  state.activeSubTab = subTab;
  document.querySelectorAll('[data-sub-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.subTab === subTab));
  renderCurrentView();
}

document.addEventListener('dragover', e => { e.preventDefault(); dropOverlay.classList.add('visible'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) dropOverlay.classList.remove('visible'); });
document.addEventListener('drop', async e => {
  e.preventDefault(); dropOverlay.classList.remove('visible');
  const files = [...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) return;
  if (files.length >= 2) { await loadPDF('a', files[0]); await loadPDF('b', files[1]); }
  else { const side = !state.docA ? 'a' : !state.docB ? 'b' : 'a'; await loadPDF(side, files[0]); }
});

// ─────────────────────────────────────────────────────────
// EVENT WIRING
// ─────────────────────────────────────────────────────────
$('btn-open-a').addEventListener('click', () => $('file-input-a').click());
$('btn-open-b').addEventListener('click', () => $('file-input-b').click());
$('file-input-a').addEventListener('change', e => { if (e.target.files[0]) loadPDF('a', e.target.files[0]); e.target.value=''; });
$('file-input-b').addEventListener('change', e => { if (e.target.files[0]) loadPDF('b', e.target.files[0]); e.target.value=''; });

$('btn-zoom-in').addEventListener('click',  () => zoomCenterBy(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomCenterBy(0.8));
$('btn-fit').addEventListener('click', fitToView);
$('btn-drag-mode').addEventListener('click', () => setPersistentMode('drag'));
if (btnOffsetMode)  btnOffsetMode.addEventListener('click', () => setPersistentMode('offset'));
if (btnOffsetReset) btnOffsetReset.addEventListener('click', resetOffset);
if (btnMarqueeZoom) btnMarqueeZoom.addEventListener('click', () => setPersistentMode('marquee'));

$('btn-prev').addEventListener('click', () => changePage(-1));
$('btn-next').addEventListener('click', () => changePage(1));
$('btn-export').addEventListener('click', exportCurrentView);
$('btn-diff-list').addEventListener('click', toggleDiffPanel);
$('btn-close-diff-panel').addEventListener('click', () => diffPanel.classList.remove('visible'));
$('btn-diff-prev').addEventListener('click', () => jumpToDiff('prev'));
$('btn-diff-next').addEventListener('click', () => jumpToDiff('next'));

if (zoomCombo) {
  zoomCombo.addEventListener('change', () => {
    const val = parseFloat(zoomCombo.value);
    if (val > 0) {
      const rect = viewContainer.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, (val / 100) / state.zoomFactor);
    }
  });
}

document.querySelectorAll('[data-sub-tab]').forEach(btn => btn.addEventListener('click', () => switchSubTab(btn.dataset.subTab)));

// ヘルプモーダル
if (btnHelp) btnHelp.addEventListener('click', () => helpModal.classList.add('visible'));
if (btnCloseHelp) btnCloseHelp.addEventListener('click', () => helpModal.classList.remove('visible'));
if (helpModal) helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.classList.remove('visible'); });

// Aori timer speed binding
aoriSpeedSlider.addEventListener('input', () => {
  state.aoriInterval = parseInt(aoriSpeedSlider.value);
  aoriSpeedLabel.textContent = state.aoriInterval + 'ms';
  if (state.activeSubTab === 'aori' && state.aoriTimer) {
    clearInterval(state.aoriTimer);
    state.aoriTimer = setInterval(() => {
      displayImageData(state.aoriFlag ? state.aoriImgB : state.aoriImgA);
      state.aoriFlag = !state.aoriFlag;
    }, state.aoriInterval);
  }
});

window.addEventListener('resize', () => { if (viewCanvas.style.display !== 'none') applyTransform(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
