/**
 * SABUN PWA — app.js (v2)
 **/

import * as pdfjsLib from './lib/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.mjs';

// ─────────────────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────────────────
// ハイライト感度 → pixelmatch threshold
const HIGHLIGHT_THRESHOLDS = { high: 0.02, mid: 0.06, low: 0.12 };
// 領域枠(差分領域オーバーレイ)を表示する対象タブ (A/B単独表示は対象外)
const DIFF_TABS = ['highlight', 'absdiff', 'aori', 'split'];
// スキャン感度 → グレー差しきい値 (0-255)
const SCAN_GRAY_THRESHOLDS = { high: 4, mid: 8, low: 15 };
const THUMB_SCALE = 0.12;
const DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1.0), 2.0);
// レンダリング解像度(固定)。ズームに依存しないため差分結果が常に一定。
const QUALITY_SCALES = { std: 2.0, high: 3.0 };
// 1キャンバスの画素数上限 (約16.7MP) — 大判PDFでのメモリ爆発/クラッシュを防ぐ
const MAX_CANVAS_PIXELS = 4096 * 4096;
// キャッシュ上限(片側あたり): 搭載メモリに応じて 64MB / 128MB
const DEVICE_GB = navigator.deviceMemory || 4;
const MAX_CACHE_BYTES = (DEVICE_GB >= 8 ? 128 : 64) * 1024 * 1024;

// cMap / 標準フォントはローカル同梱版を使用(オフライン動作)
// ※ 相対パスは pdf.js worker 基準で解決されるため、ページ基準の絶対URLにする
// ※ useSystemFonts: true — 非埋め込みフォント(特に日本語)をOSのフォントで描画。
//   false だと CJK グリフを持たない代替フォントに落ちて文字が表示されない。
const PDF_LOAD_OPTS = {
  cMapUrl: new URL('lib/cmaps/', document.baseURI).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('lib/standard_fonts/', document.baseURI).href,
  useSystemFonts: true,
  isEvalSupported: false,
  verbosity: 0,
};

// ─────────────────────────────────────────────────────────
// アプリ状態
// ─────────────────────────────────────────────────────────
const state = {
  docA: null, docB: null,
  fileA: null, fileB: null,
  nameA: '', nameB: '',
  pageA: 0, pageB: 0,
  totalA: 0, totalB: 0,
  diffPages: new Set(),
  textDiffPages: new Set(),
  fpA: null, fpB: null,

  // Pan & Zoom
  zoomFactor: 1.0,
  renderScale: 0,
  panX: 0,
  panY: 0,
  quality: 'high', // 'std' | 'high'

  // インタラクションモード
  persistentMode: 'cursor',
  activeMode: 'cursor',
  tempModeActive: false,
  keysDown: new Set(),

  // マウス関連
  panPointer: null,
  offsetDragStart: null,
  marqueeStart: null,
  splitDragging: false,

  // オフセット (PDF CSS px 単位)
  offsetDx: 0,
  offsetDy: 0,
  isOffsetDragging: false,

  // あおり
  aoriTimer: null, aoriFlag: false,
  aoriInterval: 300,
  aoriSpeeds: [600, 300, 150],
  aoriSpeedIdx: 1,

  // ペア表示モード共有ビットマップ (あおり/スプリット/ブレンド)
  pair: null,
  splitPos: 0.5,

  // タブ
  activeSubTab: 'a',

  // テキスト差分パネル (タブ非依存の独立機能)
  textPanelOpen: false,

  // ページ対応マッピング: B = A + pageBOffset
  pageBOffset: 0,

  // オフセット自動位置合わせ
  autoAlign: false,
  autoAlignPrev: null,

  // 差分検出
  sensitivity: 'mid',
  emphasize: true,
  showRegions: true,
  regions: null,
  regionIdx: -1,
  diffPixels: 0,
  lastDiffView: null,
  lastTextDiff: null,

  // 注釈 (Acrobat風スタイル設定 — 新規作成と自動注釈化の既定値)
  annotTool: null, // null|'select'|'rect'|'ellipse'|'line'|'arrow'|'text'
  annotStroke: '#ff2d2d',   // 線色
  annotFill: null,          // 塗り色 (null = 塗りなし)
  annotWidth: 1,            // 線幅 (pt)
  annotDash: 'solid',       // 'solid'|'dashed'|'dotted'
  annotTarget: 'b',         // 注釈対象 'a'|'b'|'both'
  annotAuthor: 'ADP',       // 記入者名 (T フィールド)
  annotKeepTool: false,     // 描画後もツールを維持 (Acrobat「選択したツールを維持」)
  selectedAnnot: null, // shape object
  annotDraft: null,
  annotDraftSide: 'a', // ドラフトの座標系サイド
  annotDrag: null,
  annotResize: null, // { shape, handle, orig, t }

  // 差分フィルター / PDF埋め込み注釈表示 (A/Bタブのみ反映)
  diffFilterOnly: false,
  showAnnA: false,
  showAnnB: false,
};

// 注釈データ: side → Map(pageIndex → [shape])
// shape: { id, type:'rect'|'ellipse'|'arrow'|'text',
//          stroke, fill(null=なし), thickness(pt), dash('solid'|'dashed'|'dotted'),
//          x1,y1,x2,y2 (PDF pt 左下原点), text?, fontSize? }
const annots = { a: new Map(), b: new Map() };
let annotIdSeq = 1;
// 注釈クリップボード (Ctrl/Cmd+C → V で複製)
let _annotClipboard = null;

// ─────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const viewContainer = $('view-container');
const viewCanvas = $('view-canvas');
const annotCanvas = $('annot-canvas');
const viewPlaceholder = $('view-placeholder');
const marqueeBox = $('marquee-box');
const scanProgress = $('scan-progress');
const zoomLabel = $('zoom-label');
const statusZoom = $('status-zoom');
const statusCache = $('status-cache');
const statusMsg = $('status-msg');
const pageInfo = $('page-info');
const thumbListA = $('thumb-list-a');
const thumbListB = $('thumb-list-b');
const filenameA = $('sidebar-filename-a');
const filenameB = $('sidebar-filename-b');
const diffPanel = $('diff-summary-panel');
const diffList = $('diff-summary-list');
const dropOverlay = $('drop-overlay');
const busyIndicator = $('busy-indicator');
const textView = $('text-view');
const textDiffBody = $('text-diff-body');
const textStats = $('text-stats');
const textPickup = $('text-pickup');
const btnTextPanel = $('btn-text-panel');
const locateMarker = $('locate-marker');

const btnDragMode = $('btn-drag-mode');
const btnOffsetMode = $('btn-offset-mode');
const btnOffsetReset = $('btn-offset-reset');
const btnMarqueeZoom = $('btn-marquee-zoom');
const btnDiffList = $('btn-diff-list');
const zoomCombo = $('zoom-combo');
const qualitySelect = $('quality-select');

const aoriControls = $('aori-controls');
const aoriSpeedSlider = $('aori-speed-slider');
const aoriSpeedLabel = $('aori-speed-label');
const highlightControls = $('highlight-controls');
const splitControls = $('split-controls');
const regionControls = $('region-controls');
const sensSelect = $('sens-select');
const toggleRegions = $('toggle-regions');
const toggleEmphasize = $('toggle-emphasize');
const diffPixelLabel = $('diff-pixel-label');

const annotBar = $('annot-bar');
const btnAnnot = $('btn-annot');
const annotStrokeInput = $('annot-stroke');
const annotFillEnable = $('annot-fill-enable');
const annotFillInput = $('annot-fill');
const annotWidthSelect = $('annot-width');
const annotDashSelect = $('annot-dash');
const annotTargetSelect = $('annot-target');

const btnHelp = $('btn-help');
const helpModal = $('help-modal');
const btnCloseHelp = $('btn-close-help');
const toggleAnnA = $('toggle-annotations-a');
const toggleAnnB = $('toggle-annotations-b');

// ─────────────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────────────
let statusTimer = null;
function setStatus(msg, duration = 0) {
  statusMsg.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  if (duration > 0) statusTimer = setTimeout(() => { statusMsg.textContent = ''; }, duration);
}

let _busyCount = 0;
let _busyTimer = null;
function busyShow() {
  _busyCount++;
  if (!_busyTimer) {
    _busyTimer = setTimeout(() => { busyIndicator.classList.add('visible'); }, 150);
  }
}
function busyHide() {
  _busyCount = Math.max(0, _busyCount - 1);
  if (_busyCount === 0) {
    if (_busyTimer) { clearTimeout(_busyTimer); _busyTimer = null; }
    busyIndicator.classList.remove('visible');
  }
}

// ─────────────────────────────────────────────────────────
// DIFF WORKER
// ─────────────────────────────────────────────────────────
let _worker = null;
let _workerFailed = false;
let _wseq = 0;
const _wpending = new Map();

function ensureWorker() {
  if (_worker || _workerFailed) return _worker;
  try {
    _worker = new Worker('./lib/diff-worker.js');
    _worker.onmessage = e => {
      const m = e.data;
      const p = _wpending.get(m.id);
      if (!p) return;
      _wpending.delete(m.id);
      if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
    };
    _worker.onerror = () => {
      _workerFailed = true;
      try { _worker.terminate(); } catch { /* ignore */ }
      _worker = null;
      for (const p of _wpending.values()) p.reject(new Error('worker error'));
      _wpending.clear();
    };
  } catch {
    _workerFailed = true;
    _worker = null;
  }
  return _worker;
}

function workerCall(op, imgA, imgB, params, copy = true) {
  const w = ensureWorker();
  if (!w) return null;
  const id = ++_wseq;
  const a = copy ? imgA.data.slice().buffer : imgA.data.buffer;
  const b = copy ? imgB.data.slice().buffer : imgB.data.buffer;
  return new Promise((resolve, reject) => {
    _wpending.set(id, { resolve, reject });
    w.postMessage({ id, op, width: imgA.width, height: imgA.height, a, b, params }, [a, b]);
  });
}

// ─────────────────────────────────────────────────────────
// PDF RENDERING
// ─────────────────────────────────────────────────────────
function clampScaleForPage(page, scale) {
  const vp1 = page.getViewport({ scale: 1 });
  const px = vp1.width * vp1.height * scale * scale;
  if (px <= MAX_CANVAS_PIXELS) return scale;
  return Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (vp1.width * vp1.height)));
}

async function renderPageData(page, scale, annotations) {
  const vp = page.getViewport({ scale });
  const w = Math.ceil(vp.width);
  const h = Math.ceil(vp.height);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  await page.render({
    canvasContext: ctx,
    viewport: vp,
    annotationMode: annotations ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE,
    intent: 'print',
  }).promise;

  const imgData = ctx.getImageData(0, 0, w, h);
  canvas.width = 0; canvas.height = 0;
  return imgData;
}

async function scanRenderPage(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const scale = clampScaleForPage(page, 1.0);
  return renderPageData(page, scale, false);
}

async function renderThumbBlobURL(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: THUMB_SCALE * DPR });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.75));
  canvas.width = 0; canvas.height = 0;
  if (!blob) throw new Error('thumb encode failed');
  return URL.createObjectURL(blob);
}

// ─────────────────────────────────────────────────────────
// CACHE — バイト上限ベースの LRU
// ─────────────────────────────────────────────────────────
const cacheA = new Map();
const cacheB = new Map();
const cacheBytes = { a: 0, b: 0 };

function clearCache(side) {
  (side === 'a' ? cacheA : cacheB).clear();
  cacheBytes[side] = 0;
  updateCacheLabel();
}

function cacheGet(map, key) {
  if (!map.has(key)) return null;
  const entry = map.get(key);
  map.delete(key); map.set(key, entry);
  return entry;
}

function cacheSet(side, key, entry) {
  const map = side === 'a' ? cacheA : cacheB;
  if (map.has(key)) {
    cacheBytes[side] -= map.get(key).bytes;
    map.delete(key);
  }
  entry.bytes = entry.img.data.byteLength;
  map.set(key, entry);
  cacheBytes[side] += entry.bytes;
  while (cacheBytes[side] > MAX_CACHE_BYTES && map.size > 1) {
    const oldestKey = map.keys().next().value;
    cacheBytes[side] -= map.get(oldestKey).bytes;
    map.delete(oldestKey);
  }
  updateCacheLabel();
}

// 画質変更時に旧スケールのエントリをまとめて破棄
function evictOtherScales(keepScale) {
  for (const [side, map] of [['a', cacheA], ['b', cacheB]]) {
    for (const [k, v] of map) {
      if (v.reqScale === keepScale) continue;
      cacheBytes[side] -= v.bytes;
      map.delete(k);
    }
  }
  updateCacheLabel();
}

function updateCacheLabel() {
  if (!statusCache) return;
  const mb = Math.round((cacheBytes.a + cacheBytes.b) / 1048576);
  statusCache.textContent = `キャッシュ ${mb}MB`;
  statusCache.title = `A: ${Math.round(cacheBytes.a / 1048576)}MB / B: ${Math.round(cacheBytes.b / 1048576)}MB (上限 各${Math.round(MAX_CACHE_BYTES / 1048576)}MB)`;
}

/**
 * ページの ImageData をキャッシュ付きで取得。
 * annOverride: PDF埋め込み注釈の描画指定。null なら A/B タブの表示設定に従う。
 * 差分計算系は常に false を渡す(注釈を差分判定から除外)。
 */
async function getOrRender(side, idx, scale, annOverride = null) {
  const doc = side === 'a' ? state.docA : state.docB;
  const ann = annOverride !== null ? annOverride : (side === 'a' ? state.showAnnA : state.showAnnB);
  const key = `${idx}|${scale}|${ann ? 1 : 0}`;
  const map = side === 'a' ? cacheA : cacheB;
  const hit = cacheGet(map, key);
  if (hit) return hit;
  const page = await doc.getPage(idx + 1);
  const actual = clampScaleForPage(page, scale);
  const img = await renderPageData(page, actual, ann);
  const entry = { img, reqScale: scale, scale: actual };
  cacheSet(side, key, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────
// IMAGE PROCESSING HELPERS
// ─────────────────────────────────────────────────────────
const _offsetCanvas = document.createElement('canvas');
const _offsetCanvasTmp = document.createElement('canvas');

function alignBToA(eb, ea) {
  const dx = Math.round(state.offsetDx * ea.scale);
  const dy = Math.round(state.offsetDy * ea.scale);
  const sameScale = Math.abs(ea.scale - eb.scale) < 1e-6;
  if (sameScale && dx === 0 && dy === 0 &&
      ea.img.width === eb.img.width && ea.img.height === eb.img.height) {
    return eb.img;
  }
  const w = ea.img.width, h = ea.img.height;
  _offsetCanvas.width = w; _offsetCanvas.height = h;
  const ctx = _offsetCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = !sameScale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  _offsetCanvasTmp.width = eb.img.width; _offsetCanvasTmp.height = eb.img.height;
  _offsetCanvasTmp.getContext('2d').putImageData(eb.img, 0, 0);
  const k = ea.scale / eb.scale;
  ctx.drawImage(_offsetCanvasTmp, dx, dy, eb.img.width * k, eb.img.height * k);
  const out = ctx.getImageData(0, 0, w, h);
  _offsetCanvas.width = 0; _offsetCanvas.height = 0;
  _offsetCanvasTmp.width = 0; _offsetCanvasTmp.height = 0;
  return out;
}

// ── 同期フォールバック(Worker が使えない環境用) ──
function computeHighlightSync(imgA, imgB, threshold) {
  const w = imgA.width, h = imgA.height;
  const out = new ImageData(w, h);
  const a = imgA.data, b = imgB.data, o = out.data;
  const pmOut = new Uint8Array(w * h * 4);
  window.pixelmatch(a, b, pmOut, w, h, { threshold, includeAA: false, diffMask: true });
  let count = 0;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4;
    if (pmOut[p + 3] !== 0) {
      count++;
      const ya = a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114;
      const yb = b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114;
      if (ya > yb) { o[p] = 255; o[p + 1] = 75; o[p + 2] = 0; }
      else { o[p] = 0; o[p + 1] = 196; o[p + 2] = 255; }
      o[p + 3] = 255;
    } else {
      o[p] = (a[p] * 0.3) | 0; o[p + 1] = (a[p + 1] * 0.3) | 0; o[p + 2] = (a[p + 2] * 0.3) | 0; o[p + 3] = 255;
    }
  }
  return { img: out, count, regions: [] };
}

function computeAbsDiffSync(imgA, imgB) {
  const w = imgA.width, h = imgA.height;
  const out = new ImageData(w, h);
  const a = imgA.data, b = imgB.data, o = out.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4;
    const d = Math.abs(
      (a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114) -
      (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114)) | 0;
    o[p] = d; o[p + 1] = d; o[p + 2] = d; o[p + 3] = 255;
  }
  return out;
}

function hasDiffSync(imgA, imgB, threshold, minPx) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) return true;
  const w = imgA.width, h = imgA.height;
  const a = imgA.data, b = imgB.data;
  const W = Math.floor(w / 2), H = Math.floor(h / 2);
  let cnt = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ga = 0, gb = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
          ga += a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114;
          gb += b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114;
        }
      }
      if (Math.abs(ga - gb) / 4 > threshold) {
        if (++cnt > minPx) return true;
      }
    }
  }
  return false;
}

async function computeDiffImage(op, imgA, imgB) {
  const threshold = HIGHLIGHT_THRESHOLDS[state.sensitivity];
  const call = workerCall(op, imgA, imgB, { threshold, emphasize: state.emphasize });
  if (call) {
    try {
      const m = await call;
      const img = new ImageData(new Uint8ClampedArray(m.buf), imgA.width, imgA.height);
      return { img, count: m.count || 0, regions: m.regions || [] };
    } catch { /* 同期フォールバックへ */ }
  }
  if (op === 'absdiff') return { img: computeAbsDiffSync(imgA, imgB), count: 0, regions: [] };
  return computeHighlightSync(imgA, imgB, threshold);
}

// ─────────────────────────────────────────────────────────
// PAN & ZOOM
// ─────────────────────────────────────────────────────────
function setupCanvas(w, h, rs) {
  if (viewCanvas.width !== w) viewCanvas.width = w;
  if (viewCanvas.height !== h) viewCanvas.height = h;
  viewCanvas.style.width = (w / DPR) + 'px';
  viewCanvas.style.height = (h / DPR) + 'px';
  // 注釈オーバーレイを本体キャンバスと同サイズに同期
  if (annotCanvas.width !== w) annotCanvas.width = w;
  if (annotCanvas.height !== h) annotCanvas.height = h;
  annotCanvas.style.width = viewCanvas.style.width;
  annotCanvas.style.height = viewCanvas.style.height;
  annotCanvas.style.display = 'block';
  state.renderScale = rs;
  viewCanvas.style.display = 'block';
  viewPlaceholder.style.display = 'none';
  const hud = $('viewer-hud');
  if (hud) hud.style.display = 'flex';
  applyTransform();
  drawAnnotsOverlay();
  return viewCanvas.getContext('2d');
}

function displayImageData(imgData, rs, withRegions = false) {
  if (!imgData) { showPlaceholder(); return; }
  const ctx = setupCanvas(imgData.width, imgData.height, rs || DPR);
  ctx.putImageData(imgData, 0, 0);
  if (withRegions && state.showRegions && state.regions && state.regions.list.length) {
    drawRegionOverlay(ctx);
  }
}

function drawRegionOverlay(ctx) {
  const list = state.regions.list.slice(0, 100);
  ctx.save();
  const fs = Math.round(9 * DPR);
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textBaseline = 'top';
  list.forEach((r, i) => {
    // 半透明の塗り + 破線枠で領域を示す (控えめ)
    ctx.fillStyle = 'rgba(255, 212, 0, 0.09)';
    ctx.fillRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    ctx.strokeStyle = i === state.regionIdx ? 'rgba(255, 80, 80, 0.95)' : 'rgba(255, 212, 0, 0.8)';
    ctx.lineWidth = Math.max(1.25, Math.round(DPR * (i === state.regionIdx ? 1.6 : 0.9) * 2) / 2);
    ctx.setLineDash([6 * DPR, 4 * DPR]);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    const label = String(i + 1);
    const tw = ctx.measureText(label).width + fs * 0.6;
    const lx = Math.max(0, r.x);
    const ly = Math.max(0, r.y - fs * 1.3);
    ctx.setLineDash([]);
    ctx.fillStyle = i === state.regionIdx ? 'rgba(255, 80, 80, 1)' : 'rgba(255, 212, 0, 0.95)';
    ctx.fillRect(lx, ly, tw, fs * 1.25);
    ctx.fillStyle = '#000';
    ctx.fillText(label, lx + fs * 0.3, ly + fs * 0.12);
  });
  ctx.restore();
}

function showPlaceholder() {
  viewCanvas.style.display = 'none';
  annotCanvas.style.display = 'none';
  viewPlaceholder.style.display = 'flex';
  const hud = $('viewer-hud');
  if (hud) hud.style.display = 'none';
}

function showTextView(on) {
  textView.style.display = on ? 'flex' : 'none';
}

function applyTransform() {
  if (viewCanvas.style.display === 'none') return;
  const rs = state.renderScale || DPR;
  const compensate = state.zoomFactor / (rs / DPR);
  const tf = `translate(${Math.round(state.panX)}px, ${Math.round(state.panY)}px) scale(${compensate})`;
  viewCanvas.style.transform = tf;
  annotCanvas.style.transform = tf;
  if (locateMarker) locateMarker.classList.remove('visible');
  const pct = Math.round(state.zoomFactor * 100) + '%';
  zoomLabel.textContent = pct;
  statusZoom.textContent = pct;
  // 入力欄: 編集中でなければ現在の倍率を常に正しく表示
  if (zoomCombo && document.activeElement !== zoomCombo) zoomCombo.value = pct;
}

function fitToView() {
  const rs = state.renderScale || DPR;
  const cw = (viewCanvas.width || 1) / rs;
  const ch = (viewCanvas.height || 1) / rs;
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

function computeVisualScale() {
  return QUALITY_SCALES[state.quality];
}

// 画像px の矩形へズーム(差分領域/テキスト箇所ジャンプ共用)
function zoomToImageRect(x, y, w, h, maxZoom = 8) {
  const rs = state.renderScale || DPR;
  const vw = viewContainer.clientWidth;
  const vh = viewContainer.clientHeight;
  const z = Math.max(0.05, Math.min((vw * 0.7) * rs / Math.max(w, 1), (vh * 0.7) * rs / Math.max(h, 1), maxZoom));
  state.zoomFactor = z;
  state.panX = vw / 2 - (x + w / 2) * z / rs;
  state.panY = vh / 2 - (y + h / 2) * z / rs;
  applyTransform();
}

function zoomToRegion(r) {
  if (!state.regions) return;
  zoomToImageRect(r.x, r.y, r.w, r.h);
}

// 領域ナビゲーション (前/次)
function navigateRegion(dir) {
  if (!state.regions || !state.regions.list.length) return;
  const n = Math.min(state.regions.list.length, 100);
  state.regionIdx = ((state.regionIdx + dir) % n + n) % n;
  const r = state.regions.list[state.regionIdx];
  zoomToRegion(r);
  updateRegionList();
  // 枠の選択色を反映するため再描画
  if (state.activeSubTab === 'highlight' || state.activeSubTab === 'absdiff') {
    if (state.lastDiffView) displayImageData(state.lastDiffView.img, state.regions.rs, true);
  } else if (state.activeSubTab === 'aori') {
    drawPairFrame(state.aoriFlag);
  } else if (state.activeSubTab === 'split') {
    compositeSplit();
  }
  setStatus(`差分領域 ${state.regionIdx + 1} / ${n}`, 2000);
}

// 一時的な位置マーカー(テキスト→PDF 連動時)
let _markerTimer = null;
function showLocateMarker(ix, iy, iw, ih) {
  if (!locateMarker) return;
  const rs = state.renderScale || DPR;
  const z = state.zoomFactor;
  const pad = 6;
  locateMarker.style.left = (state.panX + ix * z / rs - pad) + 'px';
  locateMarker.style.top = (state.panY + iy * z / rs - pad) + 'px';
  locateMarker.style.width = (iw * z / rs + pad * 2) + 'px';
  locateMarker.style.height = (ih * z / rs + pad * 2) + 'px';
  locateMarker.classList.add('visible');
  if (_markerTimer) clearTimeout(_markerTimer);
  _markerTimer = setTimeout(() => locateMarker.classList.remove('visible'), 2400);
}

// ─────────────────────────────────────────────────────────
// INTERACTION MODE
// ─────────────────────────────────────────────────────────
const CURSORS = {
  cursor: 'default',
  drag: 'grab',
  offset: 'move',
  zoom_in: 'zoom-in',
  zoom_out: 'zoom-out',
  marquee: 'crosshair',
};

function updateModeFromKeys() {
  const isCtrl = state.keysDown.has('Control') || state.keysDown.has('Meta');
  const isAlt = state.keysDown.has('Alt');
  const isSpace = state.keysDown.has(' ');
  const isShift = state.keysDown.has('Shift');

  let newMode = state.persistentMode;
  let isTemp = false;

  if (isShift && !isSpace && !isCtrl && !isAlt && state.persistentMode !== 'offset') {
    newMode = 'marquee'; isTemp = true;
  } else if (isSpace) {
    if (isCtrl && isAlt) { newMode = 'zoom_out'; isTemp = true; }
    else if (isCtrl) { newMode = 'zoom_in'; isTemp = true; }
    else { newMode = 'drag'; isTemp = true; }
  }

  state.tempModeActive = isTemp;
  if (state.activeMode !== newMode) {
    state.activeMode = newMode;
    applyModeCursor();
  }
}

function applyModeCursor() {
  let cur = CURSORS[state.activeMode] || 'default';
  // 注釈ツールはカーソルモード時のみ有効なので、他モード中はそのカーソルを優先
  if (state.annotTool && state.annotTool !== 'select' && state.activeMode === 'cursor') cur = 'crosshair';
  else if (state.activeMode === 'cursor' && state.activeSubTab === 'split') cur = 'col-resize';
  viewCanvas.style.cursor = cur;
  btnDragMode.classList.toggle('active', state.persistentMode === 'drag');
  btnDragMode.setAttribute('aria-pressed', state.persistentMode === 'drag');
  btnOffsetMode.classList.toggle('active', state.persistentMode === 'offset');
  btnOffsetMode.setAttribute('aria-pressed', state.persistentMode === 'offset');
  btnMarqueeZoom.classList.toggle('active', state.persistentMode === 'marquee');
  btnMarqueeZoom.setAttribute('aria-pressed', state.persistentMode === 'marquee');
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
// オフセットドラッグの高速プレビュー
// ─────────────────────────────────────────────────────────
let _offsetPreview = null;

function closeDrawable(d) {
  if (d && typeof d.close === 'function') { try { d.close(); } catch { /* ignore */ } }
}

async function toDrawable(imgData) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(imgData); } catch { /* fallback below */ }
  }
  const c = document.createElement('canvas');
  c.width = imgData.width; c.height = imgData.height;
  c.getContext('2d').putImageData(imgData, 0, 0);
  return c;
}

function clearOffsetPreview() {
  if (!_offsetPreview) return;
  closeDrawable(_offsetPreview.bmpA);
  closeDrawable(_offsetPreview.bmpB);
  _offsetPreview = null;
}

async function ensureOffsetPreview() {
  if (_offsetPreview) return _offsetPreview;
  if (!state.docA || !state.docB) return null;
  const sc = computeVisualScale();
  const [ea, eb] = await Promise.all([
    getOrRender('a', state.pageA, sc, false),
    getOrRender('b', state.pageB, sc, false),
  ]);
  const [bmpA, bmpB] = await Promise.all([toDrawable(ea.img), toDrawable(eb.img)]);
  _offsetPreview = { bmpA, bmpB, w: ea.img.width, h: ea.img.height, rsA: ea.scale, rsB: eb.scale };
  return _offsetPreview;
}

function compositeOffsetPreview() {
  const p = _offsetPreview;
  if (!p) return;
  const ctx = setupCanvas(p.w, p.h, p.rsA);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, p.w, p.h);
  ctx.drawImage(p.bmpA, 0, 0);
  ctx.globalAlpha = 0.55;
  const k = p.rsA / p.rsB;
  ctx.drawImage(p.bmpB, state.offsetDx * p.rsA, state.offsetDy * p.rsA, p.bmpB.width * k, p.bmpB.height * k);
  ctx.globalAlpha = 1;
}

let _previewRaf = 0;
function schedulePreviewComposite() {
  if (_previewRaf) return;
  _previewRaf = requestAnimationFrame(() => {
    _previewRaf = 0;
    compositeOffsetPreview();
  });
}

// ─────────────────────────────────────────────────────────
// 注釈 (SABUN独自レイヤー → Acrobat互換出力)
// ─────────────────────────────────────────────────────────
// 注釈の対象PDF: 注釈バーの「対象」設定 (A / B / A+B) に従う。
// タブに依存しないため、どちらのPDFへ描き込むかが常に明確。
function annotTargetSides() {
  return state.annotTarget === 'both' ? ['a', 'b'] : [state.annotTarget];
}
function annotPage(side) { return side === 'b' ? state.pageB : state.pageA; }
// ページ対応マッピング: Aのページ番号に対応するBのページ番号
function bPageFor(aIdx) { return aIdx + state.pageBOffset; }
// 図形をあるサイドの座標系から別サイドのPDF座標系へ変換 (オフセット補正)
function shapeToSideSpace(s, fromSpace, side) {
  if (fromSpace === side) return { ...s, id: annotIdSeq++ };
  const sx = side === 'b' ? -state.offsetDx : state.offsetDx;
  const sy = side === 'b' ? state.offsetDy : -state.offsetDy;
  return { ...s, id: annotIdSeq++, x1: s.x1 + sx, x2: s.x2 + sx, y1: s.y1 + sy, y2: s.y2 + sy };
}

function annotListFor(side, page, create = false) {
  const m = annots[side];
  if (!m.has(page)) {
    if (!create) return null;
    m.set(page, []);
  }
  return m.get(page);
}

function containerToImage(cssX, cssY) {
  const rs = state.renderScale || DPR;
  return {
    ix: (cssX - state.panX) * rs / state.zoomFactor,
    iy: (cssY - state.panY) * rs / state.zoomFactor,
  };
}

// ── サイド別座標変換 ──
// 各サイドのPDF座標(pt,左下原点) ↔ キャンバス画像px。
// 並列タブではB側が右半分にオフセットされ、比較系タブではBにオフセット補正が乗る。
function sideTransform(side) {
  const tab = state.activeSubTab;
  const rs = state.renderScale || DPR;
  const pageH = viewCanvas.height / rs;
  if (side === 'b' && tab !== 'b' && tab !== 'a') {
    return { rs, pageH, dx: state.offsetDx * rs, dy: state.offsetDy * rs };
  }
  return { rs, pageH, dx: 0, dy: 0 };
}
function pdfToImageT(t, x, y) {
  return { ix: x * t.rs + t.dx, iy: (t.pageH - y) * t.rs + t.dy };
}
function imageToPdfT(t, ix, iy) {
  return { x: (ix - t.dx) / t.rs, y: t.pageH - (iy - t.dy) / t.rs };
}
// 図形が属するサイドを特定
function shapeSide(shape) {
  for (const side of ['a', 'b']) {
    for (const [, list] of annots[side]) {
      if (list.includes(shape)) return side;
    }
  }
  return 'a';
}
// 描画開始位置からサイドを決定 (並列タブは左右で自動判定)
function pickDrawSide() {
  return state.activeSubTab === 'b' ? 'b' : 'a';
}
// 表示中の注釈サイド一覧
function visibleAnnotSides() {
  const tab = state.activeSubTab;
  return tab === 'a' ? ['a'] : tab === 'b' ? ['b'] : ['b', 'a'];
}

function drawAnnotsOverlay() {
  if (!annotCanvas || annotCanvas.style.display === 'none') return;
  const ctx = annotCanvas.getContext('2d');
  ctx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  for (const side of visibleAnnotSides()) {
    const list = annotListFor(side, annotPage(side));
    if (!list) continue;
    const t = sideTransform(side);
    for (const s of list) drawShape(ctx, s, t, s === state.selectedAnnot);
  }
  if (state.annotDraft) {
    drawShape(ctx, state.annotDraft, sideTransform(state.annotDraftSide || 'a'), false);
  }
}

function dashPattern(dash, lwPx) {
  const u = Math.max(2, lwPx);
  if (dash === 'dashed') return [u * 3, u * 2];
  if (dash === 'dotted') return [Math.max(1, u * 0.5), u * 1.6];
  return [];
}

function drawShape(ctx, s, t, selected) {
  const p1 = pdfToImageT(t, s.x1, s.y1);
  const p2 = pdfToImageT(t, s.x2, s.y2);
  const x = Math.min(p1.ix, p2.ix);
  const y = Math.min(p1.iy, p2.iy);
  const w = Math.abs(p2.ix - p1.ix);
  const h = Math.abs(p2.iy - p1.iy);
  const rs = t.rs;
  const stroke = s.stroke || s.color || '#ff2d2d';
  const lwPx = Math.max(0.75, (s.thickness ?? 1) * rs);
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lwPx;
  ctx.lineJoin = 'round';
  ctx.lineCap = s.dash === 'dotted' ? 'round' : 'butt';
  ctx.setLineDash(dashPattern(s.dash, lwPx));

  if (s.type === 'rect') {
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fillRect(x, y, w, h); }
    ctx.strokeRect(x, y, w, h);
  } else if (s.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
    ctx.stroke();
  } else if (s.type === 'line' || s.type === 'arrow') {
    const ax = p1.ix, ay = p1.iy;
    const bx = p2.ix, by = p2.iy;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    if (s.type === 'arrow') {
      const ang = Math.atan2(by - ay, bx - ax);
      const L = Math.max(10, (s.thickness ?? 1) * 6 * rs / 2 + 8);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(bx - L * Math.cos(ang - 0.5), by - L * Math.sin(ang - 0.5));
      ctx.lineTo(bx, by);
      ctx.lineTo(bx - L * Math.cos(ang + 0.5), by - L * Math.sin(ang + 0.5));
      ctx.stroke();
    }
  } else if (s.type === 'text') {
    const fontPx = (s.fontSize || 14) * rs;
    ctx.setLineDash([]);
    ctx.font = `${fontPx}px sans-serif`;
    ctx.textBaseline = 'top';
    const lines = (s.text || '').split('\n');
    if (s.fill) {
      const bb = shapeBBoxImage(s, t);
      ctx.fillStyle = s.fill;
      ctx.fillRect(bb.x - 2, bb.y - 2, bb.w + 4, bb.h + 4);
    }
    ctx.fillStyle = stroke;
    lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * fontPx * 1.25));
  }

  if (selected) {
    ctx.setLineDash([5 * rs / 2, 4 * rs / 2]);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)';
    ctx.lineWidth = Math.max(1.5, rs * 0.8);
    const bb = shapeBBoxImage(s, t);
    ctx.strokeRect(bb.x - 4, bb.y - 4, bb.w + 8, bb.h + 8);
    // リサイズハンドル
    ctx.setLineDash([]);
    for (const hd of shapeHandles(s, t)) {
      const r = Math.max(4, 4.5 * rs / 2);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
      ctx.lineWidth = Math.max(1.2, rs * 0.7);
      ctx.fillRect(hd.ix - r, hd.iy - r, r * 2, r * 2);
      ctx.strokeRect(hd.ix - r, hd.iy - r, r * 2, r * 2);
    }
  }
  ctx.restore();
}

// 選択中図形のリサイズハンドル位置 (画像px)。線/矢印は両端点、その他はバウンディング4隅。
function shapeHandles(s, t) {
  if (s.type === 'line' || s.type === 'arrow') {
    const p1 = pdfToImageT(t, s.x1, s.y1);
    const p2 = pdfToImageT(t, s.x2, s.y2);
    return [
      { handle: 'p1', ix: p1.ix, iy: p1.iy },
      { handle: 'p2', ix: p2.ix, iy: p2.iy },
    ];
  }
  const bb = shapeBBoxImage(s, t);
  return [
    { handle: 'nw', ix: bb.x, iy: bb.y },
    { handle: 'ne', ix: bb.x + bb.w, iy: bb.y },
    { handle: 'sw', ix: bb.x, iy: bb.y + bb.h },
    { handle: 'se', ix: bb.x + bb.w, iy: bb.y + bb.h },
  ];
}

// ハンドルのヒットテスト (選択中図形のみ)
function handleHitTest(ix, iy) {
  if (!state.selectedAnnot) return null;
  const t = sideTransform(shapeSide(state.selectedAnnot));
  const tol = Math.max(8, 9 * t.rs / 2);
  for (const hd of shapeHandles(state.selectedAnnot, t)) {
    if (Math.abs(ix - hd.ix) <= tol && Math.abs(iy - hd.iy) <= tol) return hd.handle;
  }
  return null;
}

function shapeBBoxImage(s, t) {
  const p1 = pdfToImageT(t, s.x1, s.y1);
  const p2 = pdfToImageT(t, s.x2, s.y2);
  let x = Math.min(p1.ix, p2.ix);
  let y = Math.min(p1.iy, p2.iy);
  let w = Math.abs(p2.ix - p1.ix);
  let h = Math.abs(p2.iy - p1.iy);
  if (s.type === 'text') {
    const fontPx = (s.fontSize || 14) * t.rs;
    const lines = (s.text || '').split('\n');
    const ctx = annotCanvas.getContext('2d');
    ctx.font = `${fontPx}px sans-serif`;
    w = Math.max(...lines.map(ln => ctx.measureText(ln).width), 10);
    h = lines.length * fontPx * 1.25;
  }
  return { x, y, w, h };
}

function annotHitTest(ix, iy) {
  // 表示中のサイドの注釈を上から順にヒットテスト (drawAnnotsOverlay と同じ表示規則)
  for (const side of visibleAnnotSides()) {
    const list = annotListFor(side, annotPage(side));
    if (!list) continue;
    const t = sideTransform(side);
    const slop = 8 * t.rs / 2;
    for (let i = list.length - 1; i >= 0; i--) {
      const bb = shapeBBoxImage(list[i], t);
      if (ix >= bb.x - slop && ix <= bb.x + bb.w + slop && iy >= bb.y - slop && iy <= bb.y + bb.h + slop) {
        return { shape: list[i], side };
      }
    }
  }
  return null;
}

function updateAnnotToolButtons() {
  document.querySelectorAll('[data-annot-tool]').forEach(btn => {
    const active = btn.dataset.annotTool === state.annotTool;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
  });
}

function setAnnotTool(tool) {
  state.annotTool = state.annotTool === tool ? null : tool;
  if (state.annotTool !== 'select') state.selectedAnnot = null;
  updateAnnotToolButtons();
  applyModeCursor();
  drawAnnotsOverlay();
}

// 描画ツールを明示的にセット (トグルしない / Acrobat風ショートカット・自動復帰用)
function selectAnnotTool(tool) {
  state.annotTool = tool;
  if (tool !== 'select') state.selectedAnnot = null;
  updateAnnotToolButtons();
  applyModeCursor();
  drawAnnotsOverlay();
}

function deleteSelectedAnnot() {
  if (!state.selectedAnnot) return;
  for (const side of ['a', 'b']) {
    for (const [, list] of annots[side]) {
      const i = list.indexOf(state.selectedAnnot);
      if (i >= 0) { list.splice(i, 1); state.selectedAnnot = null; drawAnnotsOverlay(); updateAnnotListPanel(); setStatus('注釈を削除しました', 2000); return; }
    }
  }
}

function annotCount(side) {
  let n = 0;
  for (const [, list] of annots[side]) n += list.length;
  return n;
}

// テキストコメントの入力UI — Acrobat「テキストコメントを追加」(タイプライター)風。
// クリック位置にその場で入力でき、複数行対応 (Shift+Enterで改行 / Enter確定 / Esc取消)。
function openAnnotTextInput(cssX, cssY, ix, iy) {
  const existing = $('annot-text-input');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'annot-text-input';
  wrap.style.cssText = `position:absolute;left:${cssX}px;top:${cssY - 4}px;z-index:80;`;
  const ta = document.createElement('textarea');
  ta.placeholder = 'テキストコメントを入力\n(Enter確定 / Shift+Enter改行 / Esc取消)';
  ta.rows = 1;
  ta.setAttribute('aria-label', 'テキストコメント');
  // 入力欄の見た目をタイプライター風に: 枠なしテキストに近いプレビュー
  const fontCss = Math.max(11, 14 * state.zoomFactor);
  ta.style.cssText = [
    `min-width:240px`, `font-size:${fontCss}px`, 'line-height:1.3',
    `color:${state.annotStroke}`, 'font-family:sans-serif',
    'padding:2px 6px', 'border:1px dashed var(--accent)', 'border-radius:4px',
    'background:rgba(255,255,255,0.92)', 'outline:none', 'resize:both', 'overflow:hidden',
  ].join(';');
  wrap.appendChild(ta);
  viewContainer.appendChild(wrap);
  ta.focus();

  const autoGrow = () => {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  };
  ta.addEventListener('input', autoGrow);

  const commit = () => {
    const txt = ta.value.replace(/\s+$/, '');
    wrap.remove();
    if (!txt.trim()) return;
    const draftSide = state.annotDraftSide || 'a';
    const pt = imageToPdfT(sideTransform(draftSide), ix, iy);
    const fontSize = 14;
    const lines = txt.split('\n');
    const wPt = Math.max(...lines.map(l => l.length)) * fontSize * 0.95 + 8;
    const hPt = lines.length * fontSize * 1.3 + 4;
    const base = {
      id: 0, type: 'text',
      stroke: state.annotStroke, fill: state.annotFill,
      thickness: state.annotWidth, dash: state.annotDash,
      x1: pt.x, y1: pt.y, x2: pt.x + wPt, y2: pt.y - hPt,
      text: txt, fontSize,
    };
    const targets = annotTargetSides();
    const added = [];
    let lastShape = null;
    for (const side of targets) {
      if (!(side === 'a' ? state.docA : state.docB)) continue;
      lastShape = shapeToSideSpace(base, draftSide, side);
      annotListFor(side, annotPage(side), true).push(lastShape);
      added.push(side.toUpperCase());
    }
    drawAnnotsOverlay();
    updateAnnotListPanel();
    setStatus(added.length ? `${added.join('・')} にテキストコメントを追加しました` : '対象のPDFが読み込まれていません', 2500);
    if (added.length && !state.annotKeepTool) {
      selectAnnotTool('select');
      state.selectedAnnot = lastShape;
      drawAnnotsOverlay();
    }
  };
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') wrap.remove();
    else setTimeout(autoGrow, 0);
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (wrap.isConnected) commit(); }, 120));
}

// ── XFDF 書き出し (Acrobat: コメント > 読み込み で取り込み可能) ──
function buildXFDF(side) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const out = [];
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (const [page, list] of annots[side]) {
    for (const s of list) {
      const x1 = Math.min(s.x1, s.x2), y1 = Math.min(s.y1, s.y2);
      const x2 = Math.max(s.x1, s.x2), y2 = Math.max(s.y1, s.y2);
      const rect = `${(x1 - 2).toFixed(2)},${(y1 - 2).toFixed(2)},${(x2 + 2).toFixed(2)},${(y2 + 2).toFixed(2)}`;
      const lw = s.thickness ?? 1;
      // 線種: Acrobat互換の style / dashes 属性
      let borderStyle = '';
      if (s.dash === 'dashed') borderStyle = ` style="dash" dashes="${lw * 3},${lw * 2}"`;
      else if (s.dash === 'dotted') borderStyle = ` style="dash" dashes="${Math.max(0.5, lw)},${lw * 2}"`;
      const fillAttr = s.fill ? ` interior-color="${s.fill}"` : '';
      const author = esc(state.annotAuthor || 'ADP');
      const common = `page="${page}" color="${s.stroke || '#ff2d2d'}"${fillAttr} date="${date}" title="${author}" flags="print" width="${lw}"${borderStyle}`;
      if (s.type === 'rect') {
        out.push(`<square ${common} rect="${rect}"/>`);
      } else if (s.type === 'ellipse') {
        out.push(`<circle ${common} rect="${rect}"/>`);
      } else if (s.type === 'line') {
        out.push(`<line ${common} rect="${rect}" start="${s.x1.toFixed(2)},${s.y1.toFixed(2)}" end="${s.x2.toFixed(2)},${s.y2.toFixed(2)}" head="None" tail="None"/>`);
      } else if (s.type === 'arrow') {
        out.push(`<line ${common} IT="LineArrow" rect="${rect}" start="${s.x1.toFixed(2)},${s.y1.toFixed(2)}" end="${s.x2.toFixed(2)},${s.y2.toFixed(2)}" head="None" tail="OpenArrow"/>`);
      } else if (s.type === 'text') {
        out.push(`<freetext ${common} IT="FreeTextTypeWriter" rect="${rect}"><contents>${esc(s.text || '')}</contents>` +
          `<defaultappearance>${(s.fontSize || 14)} TL /Helv ${(s.fontSize || 14)} Tf</defaultappearance></freetext>`);
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<annots>\n${out.join('\n')}\n</annots>\n</xfdf>\n`;
}

function exportXFDF() {
  let exported = 0;
  // 「対象」設定のPDFのみ書き出す
  for (const side of annotTargetSides()) {
    if (annotCount(side) === 0) continue;
    const xfdf = buildXFDF(side);
    const base = (side === 'a' ? state.nameA : state.nameB).replace(/\.pdf$/i, '') || side.toUpperCase();
    downloadBlob(new Blob([xfdf], { type: 'application/vnd.adobe.xfdf' }), `${base}_注釈.xfdf`);
    exported++;
  }
  setStatus(exported ? 'XFDFを書き出しました。Acrobatの「コメントの読み込み」で取り込めます。' : '注釈がありません', 5000);
}

// ── 注釈入りPDF保存 (pdf.js saveDocument / FreeText+Ink として埋め込み) ──
function hexToRgbArr(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) || [];
  return [parseInt(m[1] || 'ff', 16), parseInt(m[2] || '2d', 16), parseInt(m[3] || '2d', 16)];
}

function lineOutline(pts) {
  // pdf.js Ink outline 形式: [NaN×4, x0, y0, (NaN×4, x, y)…] — 直線ポリライン
  const out = [NaN, NaN, NaN, NaN, pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) out.push(NaN, NaN, NaN, NaN, pts[i], pts[i + 1]);
  return out;
}

function ellipseOutline(cx, cy, rx, ry) {
  // 4本のベジェで楕円近似: [NaN×4, x0, y0, (c1x,c1y,c2x,c2y,x,y)×4]
  const k = 0.5522847498;
  const out = [NaN, NaN, NaN, NaN, cx + rx, cy];
  out.push(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
  out.push(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
  out.push(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
  out.push(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy);
  return out;
}

function outlinePoints(outline) {
  // outline から x,y 座標列を抽出 (InkList 用)
  const pts = [];
  for (let i = 4; i < outline.length; i += 6) pts.push(outline[i], outline[i + 1]);
  return pts;
}

function shapeToEditorValue(s, page) {
  // 注: pdf.js のインク注釈は線色/線幅のみ対応。塗り・線種は XFDF 書き出しで保持される。
  const color = hexToRgbArr(s.stroke || s.color || '#ff2d2d');
  const x1 = Math.min(s.x1, s.x2), y1 = Math.min(s.y1, s.y2);
  const x2 = Math.max(s.x1, s.x2), y2 = Math.max(s.y1, s.y2);
  const rect = [x1 - 4, y1 - 4, x2 + 4, y2 + 4];

  if (s.type === 'text') {
    return {
      annotationType: pdfjsLib.AnnotationEditorType.FREETEXT,
      color, fontSize: s.fontSize || 14, value: s.text || '',
      pageIndex: page, rect, rotation: 0,
    };
  }
  let outlines = [];
  if (s.type === 'rect') {
    outlines = [lineOutline([x1, y1, x2, y1, x2, y2, x1, y2, x1, y1])];
  } else if (s.type === 'ellipse') {
    outlines = [ellipseOutline((x1 + x2) / 2, (y1 + y2) / 2, Math.max(1, (x2 - x1) / 2), Math.max(1, (y2 - y1) / 2))];
  } else if (s.type === 'line') {
    outlines = [lineOutline([s.x1, s.y1, s.x2, s.y2])];
  } else if (s.type === 'arrow') {
    const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const L = 12;
    outlines = [
      lineOutline([s.x1, s.y1, s.x2, s.y2]),
      lineOutline([
        s.x2 - L * Math.cos(ang - 0.5), s.y2 - L * Math.sin(ang - 0.5),
        s.x2, s.y2,
        s.x2 - L * Math.cos(ang + 0.5), s.y2 - L * Math.sin(ang + 0.5),
      ]),
    ];
  } else {
    return null;
  }
  return {
    annotationType: pdfjsLib.AnnotationEditorType.INK,
    color, thickness: Math.max(0.5, s.thickness ?? 1), opacity: 1,
    paths: { lines: outlines, points: outlines.map(outlinePoints) },
    pageIndex: page, rect, rotation: 0,
  };
}

// 画像バッファなしの軽量opで差分領域を計算 (ハイライト以外のタブで領域枠を表示するために使用)
async function computeRegionsOnly(imgA, imgB) {
  const threshold = HIGHLIGHT_THRESHOLDS[state.sensitivity];
  const call = workerCall('regions', imgA, imgB, { threshold });
  if (!call) return { count: 0, regions: [] };
  try {
    const m = await call;
    return { count: m.count || 0, regions: m.regions || [] };
  } catch {
    return { count: 0, regions: [] };
  }
}

// ─────────────────────────────────────────────────────────
// 差分領域 → 矩形注釈の自動一括付与
// ─────────────────────────────────────────────────────────
// ページの差分領域を計算。
// 戻り値: { regions: [{x,y,w,h}], rs, pageHA, pageHB } (画像px)
async function computeRegionsForPage(pageIdx) {
  const visualScale = computeVisualScale();
  const [ea, eb] = await Promise.all([
    getOrRender('a', pageIdx, visualScale, false),
    getOrRender('b', bPageFor(pageIdx), visualScale, false),
  ]);
  const imgB = alignBToA(eb, ea);
  const { regions } = await computeRegionsOnly(ea.img, imgB);
  return { regions, rs: ea.scale, pageHA: ea.img.height / ea.scale, pageHB: eb.img.height / eb.scale };
}

function regionToShape(r, rs, pageH, sideShiftX, sideShiftY) {
  // 領域(画像px・A基準) → PDF pt 矩形 (少し余白を持たせる)
  const pad = 3;
  const x1 = (r.x) / rs - pad + sideShiftX;
  const x2 = (r.x + r.w) / rs + pad + sideShiftX;
  const yTop = pageH - (r.y) / rs + pad + sideShiftY;
  const yBottom = pageH - (r.y + r.h) / rs - pad + sideShiftY;
  return {
    id: annotIdSeq++, type: 'rect',
    stroke: state.annotStroke, fill: state.annotFill,
    thickness: state.annotWidth, dash: state.annotDash,
    x1, y1: yBottom, x2, y2: yTop,
  };
}

/**
 * 差分領域を矩形注釈として一括付与。
 * scope: 'page'(現在ページ) | 'all'(全差分ページ)
 * 対象サイドは state.annotTarget ('a'|'b'|'both')。
 * 枠スタイルは注釈バーの設定(線色/塗り/線幅/線種)が適用される。
 */
async function autoAnnotateRegions(scope = 'page') {
  if (!state.docA || !state.docB) { setStatus('A・B両方のPDFが必要です', 3000); return 0; }
  const sides = state.annotTarget === 'both' ? ['a', 'b'] : [state.annotTarget];
  const maxCommon = Math.min(state.totalA, state.totalB);
  let pages;
  if (scope === 'all') {
    pages = [...state.diffPages].filter(p => p < maxCommon).sort((a, b) => a - b);
    if (!pages.length) { setStatus('差分ページがありません(先にスキャンを完了してください)', 4000); return 0; }
  } else {
    pages = [state.pageA];
  }

  busyShow();
  let added = 0;
  try {
    for (let i = 0; i < pages.length; i++) {
      const pageIdx = pages[i];
      if (scope === 'all') setStatus(`差分領域を注釈化中... ${i + 1} / ${pages.length}`);
      // 現在ページで計算済みの領域があれば再利用
      let info;
      if (pageIdx === state.pageA && state.regions && state.regions.list.length && DIFF_TABS.includes(state.activeSubTab)) {
        info = {
          regions: state.regions.list, rs: state.regions.rs,
          pageHA: viewCanvas.height / state.regions.rs,
          pageHB: viewCanvas.height / state.regions.rs,
        };
      } else {
        info = await computeRegionsForPage(pageIdx);
      }
      for (const side of sides) {
        const shiftX = side === 'b' ? -state.offsetDx : 0;
        const shiftY = side === 'b' ? state.offsetDy : 0;
        const pageH = side === 'b' ? info.pageHB : info.pageHA;
        const pageKey = side === 'b' ? bPageFor(pageIdx) : pageIdx;
        if (side === 'b' && (pageKey < 0 || pageKey >= state.totalB)) continue;
        const list = annotListFor(side, pageKey, true);
        for (const r of info.regions) {
          list.push(regionToShape(r, info.rs, pageH, shiftX, shiftY));
          added++;
        }
      }
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    busyHide();
  }
  drawAnnotsOverlay();
  updateAnnotListPanel();
  if (annotBar.hidden) { annotBar.hidden = false; btnAnnot.classList.add('active'); btnAnnot.setAttribute('aria-expanded', 'true'); }
  const sideLabel = state.annotTarget === 'both' ? 'A・B両方' : state.annotTarget.toUpperCase();
  setStatus(`${sideLabel}に矩形注釈を ${added}件 付与しました(${scope === 'all' ? `${pages.length}ページ` : 'このページ'})。注釈入りPDF保存/XFDF書き出しで出力できます。`, 8000);
  return added;
}

// ── ネイティブ注釈の生成 (pdf-lib) ──
// Acrobat の 長方形 / 円 / 線(矢印) / テキストボックス として認識・編集できる
// 標準の Square / Circle / Line / FreeText 注釈を実PDFオブジェクトとして書き込む。
function hexToRgb01(hex) {
  return hexToRgbArr(hex).map(v => Math.round((v / 255) * 1000) / 1000);
}

function n2(v) { return Math.round(v * 100) / 100; }

// 外観ストリーム(AP)を生成 — Acrobat以外のビューアでも見た目を保証する
function buildApOps(s, w, h, pad) {
  const [r, g, b] = hexToRgb01(s.stroke || '#ff2d2d');
  const lw = Math.max(0.5, s.thickness ?? 1);
  let ops = `${r} ${g} ${b} RG ${n2(lw)} w 1 j`;
  if (s.dash === 'dashed') ops += ` [${n2(lw * 3)} ${n2(lw * 2)}] 0 d`;
  else if (s.dash === 'dotted') ops += ` [${n2(Math.max(0.5, lw))} ${n2(lw * 2)}] 0 d 1 J`;
  let paintOp = 'S';
  if (s.fill && s.type !== 'arrow') {
    const [fr, fg, fb] = hexToRgb01(s.fill);
    ops += ` ${fr} ${fg} ${fb} rg`;
    paintOp = 'B';
  }
  const x0 = pad, y0 = pad, iw = w - pad * 2, ih = h - pad * 2;
  if (s.type === 'rect') {
    ops += ` ${n2(x0)} ${n2(y0)} ${n2(iw)} ${n2(ih)} re ${paintOp}`;
  } else if (s.type === 'ellipse') {
    const cx = w / 2, cy = h / 2, rx = iw / 2, ry = ih / 2;
    const k = 0.5522847498;
    ops += ` ${n2(cx + rx)} ${n2(cy)} m`
      + ` ${n2(cx + rx)} ${n2(cy + ry * k)} ${n2(cx + rx * k)} ${n2(cy + ry)} ${n2(cx)} ${n2(cy + ry)} c`
      + ` ${n2(cx - rx * k)} ${n2(cy + ry)} ${n2(cx - rx)} ${n2(cy + ry * k)} ${n2(cx - rx)} ${n2(cy)} c`
      + ` ${n2(cx - rx)} ${n2(cy - ry * k)} ${n2(cx - rx * k)} ${n2(cy - ry)} ${n2(cx)} ${n2(cy - ry)} c`
      + ` ${n2(cx + rx * k)} ${n2(cy - ry)} ${n2(cx + rx)} ${n2(cy - ry * k)} ${n2(cx + rx)} ${n2(cy)} c ${paintOp}`;
  } else if (s.type === 'line' || s.type === 'arrow') {
    // ローカル座標 (Rect 原点基準)
    const rx1 = Math.min(s.x1, s.x2), ry1 = Math.min(s.y1, s.y2);
    const ax = s.x1 - rx1 + pad, ay = s.y1 - ry1 + pad;
    const bx = s.x2 - rx1 + pad, by = s.y2 - ry1 + pad;
    ops += ` ${n2(ax)} ${n2(ay)} m ${n2(bx)} ${n2(by)} l S`;
    if (s.type === 'arrow') {
      const ang = Math.atan2(by - ay, bx - ax);
      const L = Math.max(8, lw * 5 + 6);
      const w1x = bx - L * Math.cos(ang - 0.5), w1y = by - L * Math.sin(ang - 0.5);
      const w2x = bx - L * Math.cos(ang + 0.5), w2y = by - L * Math.sin(ang + 0.5);
      ops += ` ${n2(w1x)} ${n2(w1y)} m ${n2(bx)} ${n2(by)} l ${n2(w2x)} ${n2(w2y)} l S`;
    }
  }
  return ops;
}

function makeNativeAnnot(pdfDoc, s, mDate) {
  const { PDFName, PDFString, PDFHexString } = PDFLib;
  const ctx = pdfDoc.context;
  const lw = Math.max(0.5, s.thickness ?? 1);
  const pad = lw / 2 + 2;
  const x1 = Math.min(s.x1, s.x2) - pad, y1 = Math.min(s.y1, s.y2) - pad;
  const x2 = Math.max(s.x1, s.x2) + pad, y2 = Math.max(s.y1, s.y2) + pad;
  const w = x2 - x1, h = y2 - y1;
  const strokeRgb = hexToRgb01(s.stroke || '#ff2d2d');

  const bs = { W: lw, S: 'S' };
  if (s.dash === 'dashed') { bs.S = 'D'; bs.D = [n2(lw * 3), n2(lw * 2)]; }
  else if (s.dash === 'dotted') { bs.S = 'D'; bs.D = [n2(Math.max(0.5, lw)), n2(lw * 2)]; }

  const author = state.annotAuthor || 'ADP';
  let dict;
  if (s.type === 'text') {
    // Acrobat「テキストコメントを追加」= タイプライター型 FreeText (枠・塗りなし)
    const fontSize = s.fontSize || 14;
    dict = ctx.obj({
      Type: 'Annot', Subtype: 'FreeText',
      IT: 'FreeTextTypeWriter',
      Rect: [n2(x1), n2(y1), n2(x2), n2(y2)],
      Contents: PDFHexString.fromText(s.text || ''),
      DA: PDFString.of(`${strokeRgb.join(' ')} rg /Helv ${fontSize} Tf`),
      BS: { W: 0 },
      F: 4, T: PDFHexString.fromText(author), M: PDFString.of(mDate),
    });
  } else {
    const base = {
      Type: 'Annot',
      Subtype: s.type === 'rect' ? 'Square' : s.type === 'ellipse' ? 'Circle' : 'Line',
      Rect: [n2(x1), n2(y1), n2(x2), n2(y2)],
      C: strokeRgb, CA: 1, F: 4, BS: bs,
      T: PDFHexString.fromText(author), M: PDFString.of(mDate),
    };
    if (s.fill && s.type !== 'arrow' && s.type !== 'line') base.IC = hexToRgb01(s.fill);
    if (s.type === 'line') {
      base.L = [n2(s.x1), n2(s.y1), n2(s.x2), n2(s.y2)];
      base.LE = ['None', 'None'];
    } else if (s.type === 'arrow') {
      base.L = [n2(s.x1), n2(s.y1), n2(s.x2), n2(s.y2)];
      base.LE = ['None', 'OpenArrow'];
      base.IT = 'LineArrow';
    }
    dict = ctx.obj(base);
    // 外観ストリームを添付 (Acrobat 以外のビューアでの表示保証)
    try {
      const apStream = ctx.stream(buildApOps(s, w, h, pad), {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, n2(w), n2(h)],
      });
      dict.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(apStream) }));
    } catch { /* AP無しでも Acrobat は描画できる */ }
  }
  return ctx.register(dict);
}

async function buildNativeAnnotatedPdf(side) {
  if (typeof PDFLib === 'undefined') return null;
  const file = side === 'a' ? state.fileA : state.fileB;
  if (!file) return null;
  // 同レルムの Uint8Array に包む (クロスレルム ArrayBuffer を pdf-lib が拒否するため)
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfDoc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const { PDFName } = PDFLib;
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const mDate = `D:${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  let count = 0;
  for (const [pageIdx, list] of annots[side]) {
    if (pageIdx >= pdfDoc.getPageCount() || !list.length) continue;
    const page = pdfDoc.getPage(pageIdx);
    const refs = list.map(s => makeNativeAnnot(pdfDoc, s, mDate));
    count += refs.length;
    const key = PDFName.of('Annots');
    const existing = page.node.lookup(key);
    if (existing instanceof PDFLib.PDFArray) {
      for (const r of refs) existing.push(r);
    } else {
      page.node.set(key, pdfDoc.context.obj(refs));
    }
  }
  if (!count) return null;
  return pdfDoc.save({ useObjectStreams: false });
}

// フォールバック: pdf.js saveDocument (FreeText/Ink) — pdf-lib で開けないPDF用
async function buildInkAnnotatedPdf(side) {
  const doc = side === 'a' ? state.docA : state.docB;
  if (!doc) return null;
  const keys = [];
  let i = 0;
  for (const [page, list] of annots[side]) {
    for (const s of list) {
      const v = shapeToEditorValue(s, page);
      if (!v) continue;
      const key = `pdfjs_internal_editor_sabun${i++}`;
      keys.push(key);
      doc.annotationStorage.setValue(key, v);
    }
  }
  if (!keys.length) return null;
  try {
    return await doc.saveDocument();
  } finally {
    for (const k of keys) { try { doc.annotationStorage.remove(k); } catch { /* ignore */ } }
  }
}

async function saveAnnotatedPDF(opts = {}) {
  const download = opts.download !== false;
  const results = [];
  let nativeFailed = false;
  // 「対象」設定のPDFのみダウンロードする
  const sides = opts.sides || annotTargetSides();
  for (const side of sides) {
    if (annotCount(side) === 0) continue;
    busyShow();
    try {
      let bytes = null;
      let native = true;
      try {
        bytes = await buildNativeAnnotatedPdf(side);
      } catch (e) {
        console.error('native annot save failed:', e);
        bytes = null;
      }
      if (!bytes) {
        native = false;
        nativeFailed = true;
        try { bytes = await buildInkAnnotatedPdf(side); }
        catch (e) { console.error(e); setStatus(`PDF保存エラー(${side.toUpperCase()}): ${e.message}`, 6000); }
      }
      if (!bytes) continue;
      results.push({ side, native, bytes });
      if (download) {
        const base = (side === 'a' ? state.nameA : state.nameB).replace(/\.pdf$/i, '') || side.toUpperCase();
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${base}_注釈入り.pdf`);
      }
    } finally {
      busyHide();
    }
  }
  if (results.length) {
    setStatus(nativeFailed
      ? '注釈入りPDFを保存しました(一部はインク注釈形式)。'
      : '注釈入りPDFを保存しました。Acrobatで長方形/円/線/テキストとして編集できます。', 6000);
  } else if (annotCount('a') === 0 && annotCount('b') === 0) {
    setStatus('注釈がありません', 3000);
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// オフセット自動位置合わせ (Worker の align op / ON・OFF トグル)
// ─────────────────────────────────────────────────────────
function updateAutoAlignButton() {
  const b = $('btn-auto-align');
  if (!b) return;
  b.classList.toggle('active', state.autoAlign);
  b.setAttribute('aria-pressed', String(state.autoAlign));
}

async function autoAlignOffset() {
  if (!state.docA || !state.docB) { setStatus('A・B両方のPDFが必要です', 3000); return false; }
  const w = ensureWorker();
  if (!w) { setStatus('Workerが利用できないため自動位置合わせは使えません', 4000); return false; }
  busyShow();
  try {
    const ia = await scanRenderPage(state.docA, state.pageA);
    const ib0 = await scanRenderPage(state.docB, state.pageB);
    // オフセット0の状態でAサイズに整列
    const saveDx = state.offsetDx, saveDy = state.offsetDy;
    state.offsetDx = 0; state.offsetDy = 0;
    const ib = alignBToA({ img: ib0, scale: 1 }, { img: ia, scale: 1 });
    state.offsetDx = saveDx; state.offsetDy = saveDy;

    const id = ++_wseq;
    const a = ia.data.buffer;
    const b = (ib === ib0 ? ib0 : ib).data.buffer;
    const m = await new Promise((resolve, reject) => {
      _wpending.set(id, { resolve, reject });
      w.postMessage({ id, op: 'align', width: ia.width, height: ia.height, a, b, params: { range: 48 } }, [a, b]);
    });
    state.offsetDx = m.dx;
    state.offsetDy = m.dy;
    updateOffsetLabel();
    state.lastDiffView = null;
    clearOffsetPreview();
    renderCurrentView();
    const gain = m.baseScore > 0 ? Math.max(0, Math.round((1 - m.score / m.baseScore) * 100)) : 0;
    setStatus(`自動位置合わせ: dx=${m.dx} dy=${m.dy} (差分量 ${gain}% 減)`, 5000);
    return true;
  } catch (e) {
    setStatus('自動位置合わせに失敗しました: ' + ((e && e.message) || e), 5000);
    return false;
  } finally {
    busyHide();
  }
}

// ─────────────────────────────────────────────────────────
// ページ対応マッピング (B = A + Δ を固定/解除)
// ─────────────────────────────────────────────────────────
function updatePageLinkButton() {
  const b = $('btn-page-link');
  if (!b) return;
  const off = state.pageBOffset;
  b.textContent = off === 0 ? '対応固定' : `対応解除 Δ${off > 0 ? '+' : ''}${off}`;
  b.classList.toggle('active', off !== 0);
  b.setAttribute('aria-pressed', String(off !== 0));
}

function togglePageLink() {
  if (!state.docA || !state.docB) { setStatus('A・B両方のPDFが必要です', 3000); return; }
  if (state.pageBOffset === 0) {
    const off = state.pageB - state.pageA;
    state.pageBOffset = off;
    setStatus(`ページ対応を固定: A p${state.pageA + 1} ↔ B p${state.pageB + 1} (Δ${off > 0 ? '+' : ''}${off})。この対応で再スキャンします。`, 6000);
  } else {
    state.pageBOffset = 0;
    state.pageB = Math.max(0, Math.min(state.pageA, state.totalB - 1));
    setStatus('ページ対応を解除しました。再スキャンします。', 4000);
  }
  updatePageLinkButton();
  state.lastDiffView = null;
  syncPageIndex();
  renderCurrentView();
  refreshTextPanel();
  startDiffScan();
}

// ─────────────────────────────────────────────────────────
// 注釈一覧パネル
// ─────────────────────────────────────────────────────────
function toggleAnnotListPanel(force = null) {
  const panel = $('annot-list-panel');
  if (!panel) return;
  const open = force !== null ? force : !panel.classList.contains('visible');
  panel.classList.toggle('visible', open);
  const b = $('btn-annot-list');
  if (b) { b.classList.toggle('active', open); b.setAttribute('aria-pressed', String(open)); }
  if (open) updateAnnotListPanel();
}

async function jumpToAnnot(side, page, shape) {
  if (side === 'a') goToPage(page);
  else goToPage(Math.max(0, Math.min(state.totalA - 1, page - state.pageBOffset)));
  await new Promise(r => setTimeout(r, 250));
  state.selectedAnnot = shape;
  try {
    const t = sideTransform(side);
    const bb = shapeBBoxImage(shape, t);
    zoomToImageRect(bb.x - 30, bb.y - 30, bb.w + 60, bb.h + 60, 4);
  } catch { /* ignore */ }
  drawAnnotsOverlay();
}

function updateAnnotListPanel() {
  const panel = $('annot-list-panel');
  const listEl = $('annot-list');
  const cnt = $('annot-list-count');
  if (!panel || !listEl || !panel.classList.contains('visible')) return;
  listEl.textContent = '';
  const typeIcons = { rect: '▭', ellipse: '◯', line: '／', arrow: '↗', text: 'T' };
  const typeNames = { rect: '矩形', ellipse: '楕円', line: '線', arrow: '矢印', text: 'テキスト' };
  let total = 0;
  const frag = document.createDocumentFragment();
  for (const side of ['a', 'b']) {
    const pages = [...annots[side].keys()].sort((x, y) => x - y);
    for (const pg of pages) {
      for (const sh of annots[side].get(pg)) {
        total++;
        const row = document.createElement('div');
        row.className = 'annot-item' + (sh === state.selectedAnnot ? ' current' : '');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        const sideBadge = document.createElement('span');
        sideBadge.className = `annot-side-badge side-${side}`;
        sideBadge.textContent = side.toUpperCase();
        const chip = document.createElement('span');
        chip.className = 'annot-color-chip';
        chip.style.background = sh.stroke || '#ff2d2d';
        const label = document.createElement('span');
        label.className = 'annot-item-label';
        const desc = sh.type === 'text' ? `「${(sh.text || '').slice(0, 14)}」` : typeNames[sh.type] || sh.type;
        label.textContent = `p${pg + 1}  ${typeIcons[sh.type] || ''} ${desc}`;
        const del = document.createElement('button');
        del.className = 'panel-close-btn annot-item-del';
        del.title = 'この注釈を削除';
        del.setAttribute('aria-label', '注釈を削除');
        del.textContent = '✕';
        del.addEventListener('click', e => {
          e.stopPropagation();
          const list = annots[side].get(pg);
          const i = list.indexOf(sh);
          if (i >= 0) list.splice(i, 1);
          if (state.selectedAnnot === sh) state.selectedAnnot = null;
          drawAnnotsOverlay();
          updateAnnotListPanel();
        });
        row.appendChild(sideBadge);
        row.appendChild(chip);
        row.appendChild(label);
        row.appendChild(del);
        const activate = () => jumpToAnnot(side, pg, sh);
        row.addEventListener('click', activate);
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
        frag.appendChild(row);
      }
    }
  }
  if (!total) {
    const empty = document.createElement('div');
    empty.className = 'pickup-empty';
    empty.textContent = '注釈はまだありません';
    frag.appendChild(empty);
  }
  listEl.appendChild(frag);
  if (cnt) cnt.textContent = total ? `${total}件` : '';
}

// ─────────────────────────────────────────────────────────
// 検版レポート (HTML — ブラウザ印刷でPDF化可能)
// ─────────────────────────────────────────────────────────
const REPORT_SCALE = 1.5;

async function generateReport(opts = {}) {
  const download = opts.download !== false;
  if (!state.docA || !state.docB) { setStatus('A・B両方のPDFが必要です', 3000); return null; }
  const pages = [...new Set([...state.diffPages, ...state.textDiffPages])]
    .filter(p => p >= 0 && p < state.totalA && bPageFor(p) >= 0 && bPageFor(p) < state.totalB)
    .sort((x, y) => x - y);
  if (!pages.length) { setStatus('差分ページがありません(先にスキャンを完了してください)', 4000); return null; }
  if (download && pages.length > 50 &&
      !window.confirm(`差分ページが ${pages.length}ページあります。レポート生成に時間がかかりますが続行しますか？`)) return null;

  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  busyShow();
  const sections = [];
  const summaryRows = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      setStatus(`検版レポート生成中... ${i + 1} / ${pages.length}ページ`);
      const bpg = bPageFor(pg);
      const pA = await state.docA.getPage(pg + 1);
      const scA = clampScaleForPage(pA, REPORT_SCALE);
      const imgA = await renderPageData(pA, scA, false);
      const pB = await state.docB.getPage(bpg + 1);
      const scB = clampScaleForPage(pB, REPORT_SCALE);
      const imgB0 = await renderPageData(pB, scB, false);
      const imgB = alignBToA({ img: imgB0, scale: scB }, { img: imgA, scale: scA });
      const res = await computeDiffImage('highlight', imgA, imgB);

      const c = document.createElement('canvas');
      c.width = res.img.width; c.height = res.img.height;
      c.getContext('2d').putImageData(res.img, 0, 0);
      const dataURL = c.toDataURL('image/jpeg', 0.82);
      c.width = 0; c.height = 0;

      // テキスト差分
      let tIns = 0, tDel = 0, textHtml = '';
      try {
        const [da, db] = await Promise.all([getPageTextData('a', pg), getPageTextData('b', bpg)]);
        if (dmp && (da.text.trim() || db.text.trim())) {
          const diffs = dmp.diff_main(da.text, db.text);
          dmp.diff_cleanupSemantic(diffs);
          textHtml = diffs.map(d => {
            if (d[0] === 0) {
              const full = d[1];
              const t = full.length > 260
                ? esc(full.slice(0, 110)) + '<span class="skip"> …中略… </span>' + esc(full.slice(-110))
                : esc(full);
              return `<span>${t.replace(/\n/g, '<br>')}</span>`;
            }
            const t = esc(d[1]).replace(/\n/g, '<br>');
            if (d[0] === 1) { tIns += d[1].length; return `<ins>${t}</ins>`; }
            tDel += d[1].length; return `<del>${t}</del>`;
          }).join('');
        }
      } catch { /* テキスト抽出不可は無視 */ }

      const pageLabel = state.pageBOffset === 0 ? `Page ${pg + 1}` : `A p${pg + 1} ↔ B p${bpg + 1}`;
      summaryRows.push(`<tr><td>${pageLabel}</td><td>${(res.count || 0).toLocaleString()}</td><td>${(res.regions || []).length}</td><td>+${tIns} / −${tDel}</td></tr>`);

      const regionRows = (res.regions || []).slice(0, 12).map((r, ri) =>
        `<tr><td>#${ri + 1}</td><td>${Math.round(r.x / scA)}, ${Math.round(r.y / scA)}</td><td>${Math.round(r.w / scA)} × ${Math.round(r.h / scA)} pt</td></tr>`).join('');

      sections.push(`
<section class="page-section">
  <h2>${pageLabel} <small>差分 ${(res.count || 0).toLocaleString()}px / ${(res.regions || []).length}領域${(tIns || tDel) ? ` / テキスト +${tIns}字 −${tDel}字` : ''}</small></h2>
  <img src="${dataURL}" alt="${pageLabel} ハイライト差分">
  ${regionRows ? `<table class="regions"><thead><tr><th>領域</th><th>位置(pt)</th><th>サイズ</th></tr></thead><tbody>${regionRows}</tbody></table>` : ''}
  ${(tIns || tDel) ? `<div class="textdiff">${textHtml}</div>` : ''}
</section>`);

      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    busyHide();
  }

  const sensLabel = { high: '高', mid: '標準', low: '低' }[state.sensitivity];
  const now = new Date();
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>SABUN 検版レポート — ${esc(state.nameA)} ↔ ${esc(state.nameB)}</title>
<style>
body{font-family:-apple-system,"Hiragino Sans",Meiryo,sans-serif;color:#1a1a1a;max-width:1100px;margin:0 auto;padding:24px;}
h1{font-size:1.3em;border-bottom:3px solid #3b82f6;padding-bottom:8px;}
h2{font-size:1.05em;border-left:4px solid #3b82f6;padding-left:10px;margin:0 0 10px;}
h2 small{color:#b45309;font-weight:600;margin-left:10px;}
table{border-collapse:collapse;font-size:12px;margin:8px 0 16px;}
th,td{border:1px solid #ccc;padding:4px 10px;text-align:left;}
th{background:#f0f4ff;}
.meta td:first-child{background:#f6f6f6;font-weight:600;}
.page-section{margin:28px 0;padding-top:12px;border-top:1px dashed #bbb;page-break-inside:avoid;}
.page-section img{max-width:100%;border:1px solid #ddd;border-radius:4px;}
.textdiff{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.8;border:1px solid #ddd;border-radius:6px;padding:10px 14px;margin-top:8px;background:#fafafa;}
ins{background:#d2f8d2;text-decoration:none;border-radius:2px;}
del{background:#ffd9d9;border-radius:2px;}
.skip{color:#999;font-size:11px;}
.legend{font-size:12px;color:#555;}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:middle;}
.print-btn{position:fixed;top:14px;right:14px;padding:8px 18px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;}
@media print{.print-btn{display:none;}body{padding:0;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">印刷 / PDF保存</button>
<h1>SABUN 検版レポート</h1>
<table class="meta">
<tr><td>A (旧)</td><td>${esc(state.nameA)} (${state.totalA}ページ)</td></tr>
<tr><td>B (新)</td><td>${esc(state.nameB)} (${state.totalB}ページ)</td></tr>
<tr><td>生成日時</td><td>${now.toLocaleString('ja-JP')}</td></tr>
<tr><td>検出設定</td><td>感度: ${sensLabel} / 強調: ${state.emphasize ? 'ON' : 'OFF'} / オフセット: dx=${Math.round(state.offsetDx)} dy=${Math.round(state.offsetDy)}${state.pageBOffset !== 0 ? ` / ページ対応 Δ${state.pageBOffset > 0 ? '+' : ''}${state.pageBOffset}` : ''}</td></tr>
<tr><td>差分ページ数</td><td>${pages.length} / ${Math.min(state.totalA, state.totalB)}ページ</td></tr>
</table>
<p class="legend">凡例: <i style="background:#ff4b00"></i>B側のみ(追加) <i style="background:#00c4ff"></i>A側のみ(削除) — 一致部分は暗く表示</p>
<h2 style="margin-top:20px;">サマリー</h2>
<table><thead><tr><th>ページ</th><th>差分px</th><th>領域数</th><th>テキスト</th></tr></thead><tbody>${summaryRows.join('')}</tbody></table>
${sections.join('\n')}
</body></html>`;

  if (download) {
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    downloadBlob(new Blob([html], { type: 'text/html' }), `sabun_検版レポート_${stamp}.html`);
    setStatus(`検版レポートを保存しました(${pages.length}ページ)。開いて「印刷/PDF保存」でPDF化できます。`, 8000);
  }
  return html;
}

// 注釈マウス操作 (戻り値: イベントを消費したか)
function annotMouseDown(ix, iy, cssX, cssY, altKey = false) {
  const tool = state.annotTool;
  if (!tool || viewCanvas.style.display === 'none') return false;

  if (tool === 'select') {
    // 1) リサイズハンドル (選択中図形)
    const handle = handleHitTest(ix, iy);
    if (handle) {
      const s = state.selectedAnnot;
      state.annotResize = {
        shape: s, handle, t: sideTransform(shapeSide(s)),
        orig: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, fontSize: s.fontSize || 14 },
      };
      return true;
    }
    // 2) 図形本体 (選択+移動 / Alt+ドラッグで複製して移動)
    const hit = annotHitTest(ix, iy);
    if (hit) {
      let shape = hit.shape;
      if (altKey) {
        shape = { ...hit.shape, id: annotIdSeq++ };
        annotListFor(hit.side, annotPage(hit.side), true).push(shape);
        setStatus('注釈を複製しました (Option+ドラッグ)', 2000);
      }
      state.selectedAnnot = shape;
      state.annotDrag = {
        shape, t: sideTransform(hit.side),
        startIx: ix, startIy: iy,
        ox1: shape.x1, oy1: shape.y1, ox2: shape.x2, oy2: shape.y2,
      };
    } else {
      state.selectedAnnot = null;
    }
    drawAnnotsOverlay();
    return !!hit;
  }
  if (tool === 'text') {
    state.annotDraftSide = pickDrawSide();
    openAnnotTextInput(cssX, cssY, ix, iy);
    return true;
  }
  // rect / ellipse / line / arrow: ドラッグ開始
  const side = pickDrawSide();
  state.annotDraftSide = side;
  const pt = imageToPdfT(sideTransform(side), ix, iy);
  state.annotDraft = {
    id: annotIdSeq++, type: tool,
    stroke: state.annotStroke, fill: state.annotFill,
    thickness: state.annotWidth, dash: state.annotDash,
    x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
  };
  return true;
}

function annotMouseMove(ix, iy) {
  if (state.annotDraft) {
    const pt = imageToPdfT(sideTransform(state.annotDraftSide), ix, iy);
    state.annotDraft.x2 = pt.x;
    state.annotDraft.y2 = pt.y;
    drawAnnotsOverlay();
    return true;
  }
  if (state.annotResize) {
    const { shape, handle, orig, t } = state.annotResize;
    const pt = imageToPdfT(t, ix, iy);
    if (handle === 'p1') {
      shape.x1 = pt.x; shape.y1 = pt.y;
    } else if (handle === 'p2') {
      shape.x2 = pt.x; shape.y2 = pt.y;
    } else {
      // バウンディング4隅 (PDF座標: y は上が大きい)
      const left = Math.min(orig.x1, orig.x2), right = Math.max(orig.x1, orig.x2);
      const bottom = Math.min(orig.y1, orig.y2), top = Math.max(orig.y1, orig.y2);
      let L = left, R = right, T = top, B = bottom;
      if (handle === 'nw' || handle === 'sw') L = Math.min(pt.x, right - 2); else R = Math.max(pt.x, left + 2);
      if (handle === 'nw' || handle === 'ne') T = Math.max(pt.y, bottom + 2); else B = Math.min(pt.y, top - 2);
      shape.x1 = L; shape.x2 = R; shape.y1 = B; shape.y2 = T;
      if (shape.type === 'text') {
        const origH = Math.abs(orig.y2 - orig.y1) || 1;
        shape.fontSize = Math.min(72, Math.max(6, Math.round(orig.fontSize * Math.abs(T - B) / origH * 10) / 10));
      }
    }
    drawAnnotsOverlay();
    return true;
  }
  if (state.annotDrag) {
    const d = state.annotDrag;
    const dxPt = (ix - d.startIx) / d.t.rs;
    const dyPt = -(iy - d.startIy) / d.t.rs;
    d.shape.x1 = d.ox1 + dxPt; d.shape.y1 = d.oy1 + dyPt;
    d.shape.x2 = d.ox2 + dxPt; d.shape.y2 = d.oy2 + dyPt;
    drawAnnotsOverlay();
    return true;
  }
  return false;
}

function annotMouseUp() {
  if (state.annotDraft) {
    const s = state.annotDraft;
    state.annotDraft = null;
    const big = Math.abs(s.x2 - s.x1) > 3 || Math.abs(s.y2 - s.y1) > 3;
    if (big) {
      const draftSide = state.annotDraftSide;
      const targets = annotTargetSides();
      const added = [];
      let lastShape = null;
      for (const side of targets) {
        if (!(side === 'a' ? state.docA : state.docB)) continue;
        lastShape = shapeToSideSpace(s, draftSide, side);
        annotListFor(side, annotPage(side), true).push(lastShape);
        added.push(`${side.toUpperCase()} p${annotPage(side) + 1}`);
      }
      setStatus(added.length ? `注釈を追加: ${added.join(' / ')}` : '対象のPDFが読み込まれていません', 2500);
      // Acrobat風: 描画後は選択ツールに戻る (「ツールを維持」OFF時)
      if (added.length && !state.annotKeepTool) {
        selectAnnotTool('select');
        state.selectedAnnot = lastShape;
      }
      updateAnnotListPanel();
    }
    drawAnnotsOverlay();
    return true;
  }
  if (state.annotResize) {
    state.annotResize = null;
    return true;
  }
  if (state.annotDrag) {
    state.annotDrag = null;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// MOUSE EVENTS
// ─────────────────────────────────────────────────────────
viewContainer.addEventListener('mousedown', e => {
  const mode = state.activeMode;
  const rect = viewContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // 中ボタンは常にパン (Acrobat風 — 注釈ツール中でも移動できる)
  if (e.button === 1) {
    e.preventDefault();
    state.panPointer = { startX: e.clientX, startY: e.clientY, initPanX: state.panX, initPanY: state.panY };
    viewCanvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  // 注釈ツールはカーソルモード時のみ反応 (パン/矩形ズーム/オフセット等のモードが優先)
  if (state.annotTool && !state.tempModeActive && mode === 'cursor') {
    const { ix, iy } = containerToImage(mouseX, mouseY);
    if (annotMouseDown(ix, iy, mouseX, mouseY, e.altKey)) { e.preventDefault(); return; }
  }

  if (mode === 'drag') {
    e.preventDefault();
    state.panPointer = { startX: e.clientX, startY: e.clientY, initPanX: state.panX, initPanY: state.panY };
    viewCanvas.style.cursor = 'grabbing';
  } else if (mode === 'offset') {
    e.preventDefault();
    state.offsetDragStart = { x: e.clientX, y: e.clientY, dx: state.offsetDx, dy: state.offsetDy };
    state.isOffsetDragging = true;
    ensureOffsetPreview().then(() => {
      if (state.isOffsetDragging) schedulePreviewComposite();
    });
  } else if (mode === 'cursor' && state.activeSubTab === 'split' && state.pair) {
    e.preventDefault();
    state.splitDragging = true;
    state.splitPos = Math.max(0, Math.min(1, containerToImage(mouseX, mouseY).ix / state.pair.w));
    compositeSplit();
  } else if (mode === 'marquee' && viewCanvas.style.display !== 'none') {
    e.preventDefault();
    state.marqueeStart = { x: mouseX, y: mouseY };
    marqueeBox.style.left = mouseX + 'px';
    marqueeBox.style.top = mouseY + 'px';
    marqueeBox.style.width = '0px';
    marqueeBox.style.height = '0px';
    marqueeBox.style.display = 'block';
  }
});

viewContainer.addEventListener('mousemove', e => {
  const rect = viewContainer.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (state.annotDraft || state.annotDrag || state.annotResize) {
    const { ix, iy } = containerToImage(mouseX, mouseY);
    if (annotMouseMove(ix, iy)) return;
  }

  if (state.panPointer) {
    const p = state.panPointer;
    state.panX = p.initPanX + (e.clientX - p.startX);
    state.panY = p.initPanY + (e.clientY - p.startY);
    applyTransform();
  } else if (state.offsetDragStart) {
    const d = state.offsetDragStart;
    const newDx = d.dx + (e.clientX - d.x) * (1 / state.zoomFactor);
    const newDy = d.dy + (e.clientY - d.y) * (1 / state.zoomFactor);
    if (e.shiftKey && e.altKey) { state.offsetDx = newDx; state.offsetDy = newDy; }
    else if (e.shiftKey) state.offsetDx = newDx;
    else if (e.altKey) state.offsetDy = newDy;
    else { state.offsetDx = newDx; state.offsetDy = newDy; }
    updateOffsetLabel();
    if (_offsetPreview) schedulePreviewComposite();
  } else if (state.splitDragging && state.pair) {
    state.splitPos = Math.max(0, Math.min(1, containerToImage(mouseX, mouseY).ix / state.pair.w));
    compositeSplit();
  } else if (state.marqueeStart) {
    const x = Math.min(mouseX, state.marqueeStart.x);
    const y = Math.min(mouseY, state.marqueeStart.y);
    const w = Math.abs(mouseX - state.marqueeStart.x);
    const h = Math.abs(mouseY - state.marqueeStart.y);
    marqueeBox.style.left = x + 'px';
    marqueeBox.style.top = y + 'px';
    marqueeBox.style.width = w + 'px';
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

  state.zoomFactor = nz;
  state.panX = (vw - cw * nz) / 2 - cx * nz;
  state.panY = (vh - ch * nz) / 2 - cy * nz;
  applyTransform();
  setPersistentMode('cursor');
}

window.addEventListener('mouseup', e => {
  const rect = viewContainer.getBoundingClientRect();
  if (annotMouseUp()) return;
  if (state.panPointer) {
    state.panPointer = null;
    applyModeCursor();
  }
  if (state.isOffsetDragging) {
    state.isOffsetDragging = false;
    state.offsetDragStart = null;
    clearOffsetPreview();
    renderCurrentView();
  } else {
    state.offsetDragStart = null;
  }
  state.splitDragging = false;
  if (state.marqueeStart) {
    finishMarqueeZoom(e.clientX - rect.left, e.clientY - rect.top);
  }
});

viewContainer.addEventListener('click', e => {
  // 一時モード(Ctrl+Space等)のズームクリックは注釈ツール中でも有効
  if (state.annotTool && !state.tempModeActive && state.activeMode === 'cursor') return;
  if (state.activeMode === 'zoom_in') zoomAtPoint(e.clientX, e.clientY, 1.25);
  else if (state.activeMode === 'zoom_out') zoomAtPoint(e.clientX, e.clientY, 0.8);
});

viewContainer.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9);
  } else if (viewCanvas.style.display !== 'none') {
    e.preventDefault();
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    applyTransform();
  }
}, { passive: false });

// ─────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────
const SUB_TAB_KEYS = ['a', 'b', 'highlight', 'aori', 'absdiff', 'split'];

let _nudgeTimer = null;
function nudgeOffsetRender() {
  updateOffsetLabel();
  if (_nudgeTimer) clearTimeout(_nudgeTimer);
  _nudgeTimer = setTimeout(() => { _nudgeTimer = null; renderCurrentView(); }, 150);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    state.keysDown.add(e.key); updateModeFromKeys(); return;
  }

  state.keysDown.add(e.key);
  updateModeFromKeys();
  if (e.code === 'Space') { e.preventDefault(); return; }

  const ctrl = e.ctrlKey || e.metaKey;
  const alt = e.altKey;

  if (e.key === 'Escape') {
    if (helpModal.classList.contains('visible')) { helpModal.classList.remove('visible'); return; }
    if (state.selectedAnnot) { state.selectedAnnot = null; drawAnnotsOverlay(); return; }
    if (state.annotTool) { setAnnotTool(state.annotTool); return; }
    if (diffPanel.classList.contains('visible')) { diffPanel.classList.remove('visible'); return; }
    if (state.textPanelOpen) { toggleTextPanel(); return; }
  }

  // 選択中の注釈を削除
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnot) {
    e.preventDefault();
    deleteSelectedAnnot();
    return;
  }

  // 注釈ツールショートカット (注釈バー表示中のみ / Acrobat風)
  // 同じキーをもう一度押すとツール解除 (setAnnotTool はトグル動作)
  if (!ctrl && !alt && annotBar && !annotBar.hidden) {
    const toolKeys = { v: 'select', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow' };
    const tk = toolKeys[e.key.toLowerCase()];
    if (tk) {
      e.preventDefault();
      setAnnotTool(tk);
      const labels = { select: '選択', rect: '矩形', ellipse: '楕円', line: '線', arrow: '矢印' };
      setStatus(state.annotTool ? `注釈ツール: ${labels[tk]}` : '注釈ツールを解除しました', 1500);
      return;
    }
  }

  // 注釈のコピー / ペースト (注釈バー表示中)
  if (ctrl && (e.key === 'c' || e.key === 'C') && state.selectedAnnot && annotBar && !annotBar.hidden) {
    e.preventDefault();
    _annotClipboard = { shape: { ...state.selectedAnnot }, side: shapeSide(state.selectedAnnot) };
    setStatus('注釈をコピーしました (Ctrl/Cmd+V で貼り付け)', 2000);
    return;
  }
  if (ctrl && (e.key === 'v' || e.key === 'V') && _annotClipboard && annotBar && !annotBar.hidden) {
    e.preventDefault();
    const c = _annotClipboard;
    const s = { ...c.shape, id: annotIdSeq++, x1: c.shape.x1 + 12, x2: c.shape.x2 + 12, y1: c.shape.y1 - 12, y2: c.shape.y2 - 12 };
    annotListFor(c.side, annotPage(c.side), true).push(s);
    state.selectedAnnot = s;
    if (state.annotTool !== 'select') selectAnnotTool('select');
    drawAnnotsOverlay();
    updateAnnotListPanel();
    setStatus(`${c.side.toUpperCase()} p${annotPage(c.side) + 1} に注釈を貼り付けました`, 2000);
    return;
  }

  // 選択中の注釈を矢印キーで移動 (1pt / Shift+で10pt — Acrobat風)
  if (state.selectedAnnot && !ctrl && !alt &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const s = state.selectedAnnot;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0; // PDF座標は上が正
    s.x1 += dx; s.x2 += dx; s.y1 += dy; s.y2 += dy;
    drawAnnotsOverlay();
    return;
  }

  // オフセットモード: 矢印キーで微調整
  if (state.persistentMode === 'offset' && !ctrl && !alt) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); state.offsetDx -= step; nudgeOffsetRender(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); state.offsetDx += step; nudgeOffsetRender(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); state.offsetDy -= step; nudgeOffsetRender(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); state.offsetDy += step; nudgeOffsetRender(); return; }
  }

  // ページ移動
  if (!ctrl && (e.key === ',' || e.key === 'ArrowUp')) { e.preventDefault(); changePage(-1); return; }
  if (!ctrl && (e.key === '.' || e.key === 'ArrowDown')) { e.preventDefault(); changePage(1); return; }

  // ズーム
  if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomCenterBy(1.25); return; }
  if (ctrl && e.key === '-') { e.preventDefault(); zoomCenterBy(0.8); return; }
  if (ctrl && e.key === '0') { e.preventDefault(); fitToView(); return; }

  // サブタブ切替 1-6
  if (!ctrl && !alt && /^[1-6]$/.test(e.key)) {
    switchSubTab(SUB_TAB_KEYS[parseInt(e.key, 10) - 1]); return;
  }

  // 7: テキスト差分パネル / 8: 差分ページ一覧パネル (どちらもタブ非依存)
  if (!ctrl && !alt && e.key === '7') {
    e.preventDefault();
    toggleTextPanel();
    return;
  }
  if (!ctrl && !alt && e.key === '8') {
    e.preventDefault();
    toggleDiffPanel();
    return;
  }

  // Tab: 差分ページ順ジャンプ
  if (e.key === 'Tab' && !ctrl && !alt) {
    e.preventDefault();
    jumpToDiff(e.shiftKey ? 'prev' : 'next');
    return;
  }

  // N/P: 差分領域ナビゲーション (A/B以外の全タブ)
  if (!ctrl && !alt && DIFF_TABS.includes(state.activeSubTab)) {
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigateRegion(1); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); navigateRegion(-1); return; }
  }

  // F: あおり速度サイクル
  if (!ctrl && !alt && (e.key === 'f' || e.key === 'F') && state.activeSubTab === 'aori') {
    e.preventDefault();
    state.aoriSpeedIdx = (state.aoriSpeedIdx + 1) % state.aoriSpeeds.length;
    state.aoriInterval = state.aoriSpeeds[state.aoriSpeedIdx];
    const labels = ['遅い', '普通', '速い'];
    aoriSpeedSlider.value = state.aoriInterval;
    aoriSpeedLabel.textContent = state.aoriInterval + 'ms';
    setStatus(`あおり速度: ${labels[state.aoriSpeedIdx]} (${state.aoriInterval}ms)`, 2000);
    restartAoriTimer();
    return;
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

window.addEventListener('blur', () => {
  state.keysDown.clear(); updateModeFromKeys();
});

// ─────────────────────────────────────────────────────────
// PDF FINGERPRINT
// ─────────────────────────────────────────────────────────
async function computeFingerprint(ab) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', ab);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────
// LOAD PDF
// ─────────────────────────────────────────────────────────
async function loadPDF(side, file) {
  setStatus(`${side === 'a' ? 'A' : 'B'} を読込中: ${file.name}`);
  try {
    const ab = await file.arrayBuffer();
    const fp = await computeFingerprint(ab);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(ab), ...PDF_LOAD_OPTS }).promise;

    const oldDoc = side === 'a' ? state.docA : state.docB;
    // 注釈入りPDF保存用に File 参照を保持 (バイト列は保持しないのでメモリ負担なし)
    if (side === 'a') state.fileA = file; else state.fileB = file;
    if (side === 'a') {
      state.docA = doc; state.nameA = file.name; state.pageA = 0; state.totalA = doc.numPages;
      state.fpA = fp;
      filenameA.textContent = shortenName(file.name);
      filenameA.title = file.name;
      clearCache('a');
      textCache.a.clear();
      normTextCache.a.clear();
      annots.a.clear();
    } else {
      state.docB = doc; state.nameB = file.name; state.pageB = 0; state.totalB = doc.numPages;
      state.fpB = fp;
      filenameB.textContent = shortenName(file.name);
      filenameB.title = file.name;
      clearCache('b');
      textCache.b.clear();
      normTextCache.b.clear();
      annots.b.clear();
    }
    if (oldDoc) { try { oldDoc.destroy(); } catch { /* ignore */ } }

    state.diffPages.clear();
    state.textDiffPages.clear();
    state.pageBOffset = 0;
    state.autoAlign = false;
    state.autoAlignPrev = null;
    updatePageLinkButton();
    updateAutoAlignButton();
    state.regions = null;
    state.regionIdx = -1;
    state.diffPixels = 0;
    state.lastDiffView = null;
    state.lastTextDiff = null;
    state.selectedAnnot = null;
    clearOffsetPreview();

    buildThumbList(side);
    updateNavButtons();
    updateDiffCountBadge();
    updateOpenChip(side);
    btnDiffList.disabled = !(state.docA && state.docB);

    if (state.docA && state.docB) {
      switchSubTab('highlight', false);
      await renderCurrentView(true);
      startDiffScan();
    } else {
      switchSubTab(side, false);
      await renderCurrentView(true);
    }
    refreshTextPanel();
    setStatus(`${side === 'a' ? 'A' : 'B'} 読込完了: ${file.name}`, 4000);
  } catch (err) {
    const msg = err && err.name === 'PasswordException'
      ? 'パスワード保護されたPDFは開けません'
      : (err && err.message) || String(err);
    setStatus(`読込エラー: ${msg}`, 6000);
    console.error(err);
  }
}

function shortenName(name, max = 26) {
  return name.length <= max ? name : name.slice(0, 11) + '...' + name.slice(-11);
}

// トップバーのファイルチップに読込済みファイル名を表示
function updateOpenChip(side) {
  const nameEl = $('open-name-' + side);
  const chip = $(side === 'a' ? 'btn-open-a' : 'btn-open-b');
  const nm = side === 'a' ? state.nameA : state.nameB;
  if (nameEl) nameEl.textContent = nm ? shortenName(nm, 18) : 'PDFを開く';
  if (chip) chip.classList.toggle('loaded', !!nm);
}

// ─────────────────────────────────────────────────────────
// THUMBNAILS
// ─────────────────────────────────────────────────────────
const thumbObservers = { a: null, b: null };
const thumbURLs = { a: [], b: [] };
let _thumbChain = Promise.resolve();

function buildThumbList(side) {
  const list = side === 'a' ? thumbListA : thumbListB;
  const doc = side === 'a' ? state.docA : state.docB;
  const total = doc ? doc.numPages : 0;

  thumbURLs[side].forEach(u => URL.revokeObjectURL(u));
  thumbURLs[side] = [];
  if (thumbObservers[side]) { thumbObservers[side].disconnect(); thumbObservers[side] = null; }
  list.innerHTML = '';
  if (!doc) return;

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      queueThumb(side, doc, parseInt(en.target.dataset.page, 10), en.target);
    }
  }, { root: list, rootMargin: '300px' });
  thumbObservers[side] = io;

  const curPage = side === 'a' ? state.pageA : state.pageB;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const div = document.createElement('div');
    div.className = 'thumb-item' + (i === curPage ? ' active' : '');
    div.dataset.page = i; div.dataset.side = side;
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', `${side.toUpperCase()} ページ${i + 1}へ移動`);
    div.innerHTML = `
      <div class="thumb-img-placeholder" aria-hidden="true">📄</div>
      <div class="thumb-info">
        <div class="thumb-page-num">
          <span class="diff-dot" id="badge-${side}-${i}" title="差分あり" style="display:${state.diffPages.has(i) ? 'inline-block' : 'none'}"></span>
          Page ${i + 1}
        </div>
      </div>`;
    const activate = () => {
      if (side === 'a') state.pageA = i; else state.pageB = i;
      syncPageIndex(); renderCurrentView(true);
    };
    div.addEventListener('click', activate);
    div.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    frag.appendChild(div);
    io.observe(div);
  }
  list.appendChild(frag);
}

function queueThumb(side, doc, i, itemEl) {
  _thumbChain = _thumbChain.then(async () => {
    const cur = side === 'a' ? state.docA : state.docB;
    if (cur !== doc || !itemEl.isConnected) return;
    try {
      const url = await renderThumbBlobURL(doc, i);
      if (!itemEl.isConnected) { URL.revokeObjectURL(url); return; }
      thumbURLs[side].push(url);
      const ph = itemEl.querySelector('.thumb-img-placeholder');
      if (ph) {
        const img = document.createElement('img');
        img.src = url; img.className = 'thumb-img'; img.alt = '';
        ph.replaceWith(img);
      }
    } catch { /* ignore */ }
  });
}

function updateThumbHighlight(side) {
  const list = side === 'a' ? thumbListA : thumbListB;
  const curPage = side === 'a' ? state.pageA : state.pageB;
  list.querySelectorAll('.thumb-item').forEach(el => {
    const active = parseInt(el.dataset.page, 10) === curPage;
    el.classList.toggle('active', active);
    if (active) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function refreshDiffBadges() {
  ['a', 'b'].forEach(side => {
    const total = side === 'a' ? state.totalA : state.totalB;
    for (let i = 0; i < total; i++) {
      const b = document.getElementById(`badge-${side}-${i}`);
      if (b) b.style.display = state.diffPages.has(i) ? 'inline-block' : 'none';
    }
  });
}

// ─────────────────────────────────────────────────────────
// TEXT EXTRACTION & DIFF
// ─────────────────────────────────────────────────────────
// textCache: side → Map(page → { text, map:[{start,end,x,y,w,h}], pageH, pageW })
const textCache = { a: new Map(), b: new Map() };
const normTextCache = { a: new Map(), b: new Map() };
const dmp = (typeof diff_match_patch !== 'undefined') ? new diff_match_patch() : null;
if (dmp) dmp.Diff_Timeout = 2;

async function extractPageTextData(doc, idx) {
  const page = await doc.getPage(idx + 1);
  const vp1 = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  let text = '';
  const map = [];
  let lastY = null;
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const tr = it.transform;
    const y = tr ? tr[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 3 && text && !text.endsWith('\n')) {
      text += '\n';
    }
    if (it.str) {
      map.push({
        start: text.length,
        end: text.length + it.str.length,
        x: tr ? tr[4] : 0,
        y: y ?? 0,
        w: it.width || 10,
        h: it.height || Math.abs(tr ? tr[3] : 12) || 12,
      });
    }
    text += it.str;
    if (it.hasEOL && !text.endsWith('\n')) text += '\n';
    if (y !== null) lastY = y;
  }
  return { text, map, pageH: vp1.height, pageW: vp1.width };
}

async function getPageTextData(side, idx) {
  const cache = textCache[side];
  if (cache.has(idx)) return cache.get(idx);
  const doc = side === 'a' ? state.docA : state.docB;
  const data = await extractPageTextData(doc, idx);
  cache.set(idx, data);
  return data;
}

async function getPageTextNorm(side, idx) {
  const cache = normTextCache[side];
  if (cache.has(idx)) return cache.get(idx);
  const norm = (await getPageTextData(side, idx)).text.replace(/\s+/g, '');
  cache.set(idx, norm);
  return norm;
}

function findTextItem(data, offset) {
  // map から offset を含む(または直近の)アイテムを二分探索
  const map = data.map;
  if (!map.length) return null;
  let lo = 0, hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].start <= offset) lo = mid; else hi = mid - 1;
  }
  return map[lo];
}

function appendEqualText(frag, txt) {
  const LIMIT = 900, EDGE = 300;
  if (txt.length <= LIMIT) {
    frag.appendChild(document.createTextNode(txt));
    return;
  }
  frag.appendChild(document.createTextNode(txt.slice(0, EDGE)));
  const mid = txt.slice(EDGE, txt.length - EDGE);
  const btn = document.createElement('button');
  btn.className = 'text-skip';
  btn.type = 'button';
  btn.textContent = `… 一致部分 ${mid.length}文字を省略 — クリックで展開 …`;
  btn.addEventListener('click', () => btn.replaceWith(document.createTextNode(mid)), { once: true });
  frag.appendChild(btn);
  frag.appendChild(document.createTextNode(txt.slice(txt.length - EDGE)));
}

function showTextMessage(msg) {
  textDiffBody.textContent = '';
  const div = document.createElement('div');
  div.className = 'text-empty';
  div.textContent = msg;
  textDiffBody.appendChild(div);
}

// テキスト差分パネルはタブ非依存の独立機能。専用トークンで管理する。
let _textToken = 0;

function toggleTextPanel(forceOpen = null) {
  const open = forceOpen !== null ? forceOpen : !state.textPanelOpen;
  state.textPanelOpen = open;
  showTextView(open);
  if (btnTextPanel) {
    btnTextPanel.classList.toggle('active', open);
    btnTextPanel.setAttribute('aria-pressed', String(open));
  }
  if (open) refreshTextPanel();
}

function refreshTextPanel() {
  if (!state.textPanelOpen) return;
  renderTextDiff(++_textToken);
}

function excerpt(s, max = 28) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

async function renderTextDiff(token) {
  state.lastTextDiff = null;
  if (textPickup) textPickup.textContent = '';
  if (!state.docA || !state.docB) {
    showTextMessage('A・B 両方のPDFを読み込むとテキスト差分を表示します。');
    textStats.textContent = '—';
    return;
  }
  if (!dmp) {
    showTextMessage('diff_match_patch ライブラリが読み込まれていません。');
    textStats.textContent = '—';
    return;
  }
  busyShow();
  let da, db;
  try {
    [da, db] = await Promise.all([
      getPageTextData('a', state.pageA),
      getPageTextData('b', state.pageB),
    ]);
  } catch (err) {
    busyHide();
    showTextMessage('テキスト抽出エラー: ' + ((err && err.message) || err));
    textStats.textContent = '—';
    return;
  }
  busyHide();
  if (token !== _textToken || !state.textPanelOpen) return;

  const pageLabel = `A:p${state.pageA + 1} ↔ B:p${state.pageB + 1}`;
  if (!da.text.trim() && !db.text.trim()) {
    showTextMessage('このページにはテキストがありません(画像のみのPDFの可能性があります)。');
    textStats.textContent = `${pageLabel} — テキストなし`;
    return;
  }

  const diffs = dmp.diff_main(da.text, db.text);
  dmp.diff_cleanupSemantic(diffs);

  let ins = 0, del = 0;
  let offA = 0, offB = 0;
  let chunkId = 0;
  const chunks = []; // { kind:'del'|'ins', text, off, spanId }
  const frag = document.createDocumentFragment();
  for (const d of diffs) {
    const opn = d[0], txt = d[1];
    if (opn === 0) {
      appendEqualText(frag, txt);
      offA += txt.length;
      offB += txt.length;
    } else {
      const el = document.createElement(opn === 1 ? 'ins' : 'del');
      el.className = opn === 1 ? 'tx-ins' : 'tx-del';
      el.id = `txd-${chunkId}`;
      el.textContent = txt;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.dataset.side = opn === 1 ? 'b' : 'a';
      el.dataset.offset = String(opn === 1 ? offB : offA);
      el.title = 'クリックでPDF上の該当箇所へズーム';
      frag.appendChild(el);
      chunks.push({
        kind: opn === 1 ? 'ins' : 'del',
        text: txt,
        off: opn === 1 ? offB : offA,
        spanId: `txd-${chunkId}`,
      });
      chunkId++;
      if (opn === 1) { ins += txt.length; offB += txt.length; }
      else { del += txt.length; offA += txt.length; }
    }
  }
  textDiffBody.textContent = '';
  textDiffBody.appendChild(frag);
  state.lastTextDiff = { diffs, ins, del };

  // ── 差分箇所ピックアップ一覧 (隣接する 削除+追加 は「変更」として統合) ──
  const items = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    if (c.kind === 'del' && next && next.kind === 'ins') {
      items.push({ type: 'change', del: c, ins: next });
      i++;
    } else if (c.kind === 'del') {
      items.push({ type: 'del', del: c });
    } else {
      items.push({ type: 'ins', ins: c });
    }
  }
  if (textPickup) {
    textPickup.textContent = '';
    const pfrag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'pickup-item';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      const badge = document.createElement('span');
      badge.className = `pickup-badge pk-${it.type}`;
      badge.textContent = it.type === 'change' ? '変更' : it.type === 'ins' ? '追加' : '削除';
      const label = document.createElement('span');
      label.className = 'pickup-text';
      if (it.type === 'change') label.textContent = `${excerpt(it.del.text, 16)} → ${excerpt(it.ins.text, 16)}`;
      else if (it.type === 'ins') label.textContent = excerpt(it.ins.text);
      else label.textContent = excerpt(it.del.text);
      row.appendChild(badge);
      row.appendChild(label);
      row.title = `差分 ${i + 1}: クリックでPDF上の該当箇所へズーム`;
      const target = it.ins || it.del;
      const activate = () => {
        textPickup.querySelectorAll('.pickup-item.current').forEach(n => n.classList.remove('current'));
        row.classList.add('current');
        const span = document.getElementById(target.spanId);
        if (span) {
          textDiffBody.querySelectorAll('.tx-active').forEach(n => n.classList.remove('tx-active'));
          span.classList.add('tx-active');
          span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        locateTextOnCanvas(target.kind === 'ins' ? 'b' : 'a', target.off);
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
      pfrag.appendChild(row);
    });
    if (!items.length) {
      const none = document.createElement('div');
      none.className = 'pickup-empty';
      none.textContent = 'このページにテキスト差分はありません';
      pfrag.appendChild(none);
    }
    textPickup.appendChild(pfrag);
  }

  const counts = {
    change: items.filter(i => i.type === 'change').length,
    ins: items.filter(i => i.type === 'ins').length,
    del: items.filter(i => i.type === 'del').length,
  };
  textStats.textContent = (ins === 0 && del === 0)
    ? `${pageLabel} — テキスト差分なし`
    : `${pageLabel} — 変更${counts.change}件 / 追加${counts.ins}件 / 削除${counts.del}件 (+${ins}字 −${del}字)`;
}

// 差分テキストのクリック → PDFビューの該当箇所へズーム
async function locateTextOnCanvas(side, offset) {
  try {
    const page = side === 'a' ? state.pageA : state.pageB;
    const data = await getPageTextData(side, page);
    const item = findTextItem(data, offset);
    if (!item) return;
    const rs = state.renderScale || DPR;
    const shift = side === 'b' ? state.offsetDx : 0;
    const shiftY = side === 'b' ? state.offsetDy : 0;
    const ix = (item.x + shift) * rs;
    const iy = (data.pageH - item.y - item.h + shiftY) * rs;
    const iw = Math.max(item.w * rs, 20);
    const ih = Math.max(item.h * rs, 12);
    zoomToImageRect(ix - iw, iy - ih * 2, iw * 3, ih * 5, 4);
    showLocateMarker(ix, iy, iw, ih);
  } catch { /* ignore */ }
}

textDiffBody.addEventListener('click', e => {
  const el = e.target.closest('ins.tx-ins, del.tx-del');
  if (!el) return;
  textDiffBody.querySelectorAll('.tx-active').forEach(n => n.classList.remove('tx-active'));
  el.classList.add('tx-active');
  locateTextOnCanvas(el.dataset.side, parseInt(el.dataset.offset, 10));
});
textDiffBody.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('ins.tx-ins, del.tx-del');
  if (!el) return;
  e.preventDefault();
  el.click();
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportTextReport() {
  if (!state.lastTextDiff) { setStatus('テキスト差分が表示されていません', 3000); return; }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const { diffs, ins, del } = state.lastTextDiff;
  const parts = diffs.map(d =>
    d[0] === 0 ? `<span>${esc(d[1])}</span>` :
    d[0] === 1 ? `<ins>${esc(d[1])}</ins>` :
                 `<del>${esc(d[1])}</del>`);
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>SABUN テキスト差分レポート</title>
<style>
body{font-family:-apple-system,"Hiragino Sans",Meiryo,sans-serif;line-height:1.9;max-width:60em;margin:2em auto;padding:0 1.5em;color:#222;}
h1{font-size:1.05em;border-bottom:2px solid #3b82f6;padding-bottom:.4em;}
.meta{color:#666;font-size:.85em;}
ins{background:#d2f8d2;text-decoration:none;border-radius:2px;}
del{background:#ffd9d9;border-radius:2px;}
.body{white-space:pre-wrap;border:1px solid #ddd;border-radius:8px;padding:1.2em 1.5em;margin-top:1em;}
</style></head><body>
<h1>SABUN テキスト差分レポート</h1>
<p class="meta">A: ${esc(state.nameA)} (p${state.pageA + 1}) ↔ B: ${esc(state.nameB)} (p${state.pageB + 1})<br>
追加 +${ins}字 / 削除 −${del}字 — ${new Date().toLocaleString('ja-JP')}</p>
<div class="body">${parts.join('')}</div>
</body></html>`;
  downloadBlob(new Blob([html], { type: 'text/html' }), `sabun_text_A${state.pageA + 1}_B${state.pageB + 1}.html`);
  setStatus('テキスト差分レポートを保存しました。', 3000);
}

// ─────────────────────────────────────────────────────────
// BACKGROUND DIFF SCAN
// ─────────────────────────────────────────────────────────
let _scanToken = 0;

async function scanComparePixels(ia, ib) {
  const threshold = SCAN_GRAY_THRESHOLDS[state.sensitivity];
  const w = ensureWorker();
  if (w) {
    const id = ++_wseq;
    const a = ia.data.buffer, b = ib.data.buffer;
    try {
      const m = await new Promise((resolve, reject) => {
        _wpending.set(id, { resolve, reject });
        w.postMessage({ id, op: 'compare', width: ia.width, height: ia.height, a, b, params: { threshold, minPx: 0 } }, [a, b]);
      });
      return m.diff;
    } catch {
      return null;
    }
  }
  return hasDiffSync(ia, ib, threshold, 0);
}

async function startDiffScan() {
  if (!state.docA || !state.docB) return;
  const token = ++_scanToken;
  state.diffPages.clear();
  state.textDiffPages.clear();
  refreshDiffBadges();
  updateDiffCountBadge();
  const off = state.pageBOffset;
  const startI = Math.max(0, -off);
  const endI = Math.min(state.totalA, state.totalB - off);
  const total = Math.max(0, endI - startI);
  const maxTotal = Math.max(state.totalA, state.totalB);

  btnDiffList.disabled = false;

  if (state.fpA && state.fpA === state.fpB) {
    setStatus('同一ファイル―差分ゼロです。', 5000);
    refreshDiffBadges(); rebuildDiffSummaryPanel(); updateDiffCountBadge();
    return;
  }

  setStatus('全自動スキャン中...');
  scanProgress.style.width = '0%';
  const hasOffset = Math.round(state.offsetDx) !== 0 || Math.round(state.offsetDy) !== 0;

  for (let i = startI; i < endI; i++) {
    if (token !== _scanToken) return;
    try {
      let ia = await scanRenderPage(state.docA, i);
      if (token !== _scanToken) return;
      let ib = await scanRenderPage(state.docB, bPageFor(i));
      if (token !== _scanToken) return;

      if (hasOffset || ia.width !== ib.width || ia.height !== ib.height) {
        ib = alignBToA({ img: ib, scale: 1 }, { img: ia, scale: 1 });
      }

      let diff = await scanComparePixels(ia, ib);
      if (diff === null) {
        ia = await scanRenderPage(state.docA, i);
        ib = await scanRenderPage(state.docB, i);
        if (hasOffset || ia.width !== ib.width || ia.height !== ib.height) {
          ib = alignBToA({ img: ib, scale: 1 }, { img: ia, scale: 1 });
        }
        diff = hasDiffSync(ia, ib, SCAN_GRAY_THRESHOLDS[state.sensitivity], 0);
      }
      if (diff) state.diffPages.add(i);
    } catch {
      state.diffPages.add(i);
    }

    try {
      const [na, nb] = await Promise.all([getPageTextNorm('a', i), getPageTextNorm('b', bPageFor(i))]);
      if (token !== _scanToken) return;
      if (na !== nb) state.textDiffPages.add(i);
    } catch { /* ignore */ }

    if (token !== _scanToken) return;
    scanProgress.style.width = Math.round((i - startI + 1) / total * 100) + '%';
    setStatus(`スキャン中... ${i - startI + 1} / ${total}  (画像差分: ${state.diffPages.size} / テキスト差分: ${state.textDiffPages.size})`);
    await new Promise(r => setTimeout(r, 0));
  }
  if (token !== _scanToken) return;

  // ページ数不一致: マッピング未使用時のみ、はみ出しページを差分扱い
  if (off === 0) {
    for (let i = total; i < maxTotal; i++) state.diffPages.add(i);
  }

  scanProgress.style.width = '0%';
  const mapNote = off !== 0 ? `(ページ対応 Δ${off > 0 ? '+' : ''}${off}) ` : '';
  const pageCountNote = mapNote + (state.totalA !== state.totalB && off === 0 ? `(ページ数不一致 A:${state.totalA} / B:${state.totalB}) ` : '');
  setStatus(`${pageCountNote}画像差分 ${state.diffPages.size}ページ / テキスト差分 ${state.textDiffPages.size}ページ`, 8000);
  refreshDiffBadges();
  rebuildDiffSummaryPanel();
  updateDiffCountBadge();
}

// ─────────────────────────────────────────────────────────
// ペアビットマップ (あおり / スプリット)
// ─────────────────────────────────────────────────────────
function closePair() {
  if (!state.pair) return;
  closeDrawable(state.pair.bmpA);
  closeDrawable(state.pair.bmpB);
  state.pair = null;
}

async function preparePair(imgA, imgB, rs) {
  closePair();
  const [bmpA, bmpB] = await Promise.all([toDrawable(imgA), toDrawable(imgB)]);
  state.pair = { bmpA, bmpB, w: imgA.width, h: imgA.height, rs };
}

function drawCornerLabel(ctx, txt, side = 'left') {
  const s = Math.round(13 * DPR);
  const pad = Math.round(s * 0.6);
  const w = Math.round(s * 1.7);
  const h = Math.round(s * 1.5);
  const x = side === 'left' ? pad : ctx.canvas.width - pad - w;
  ctx.save();
  ctx.fillStyle = txt === 'A' ? 'rgba(59, 130, 246, 0.92)' : 'rgba(245, 158, 11, 0.92)';
  ctx.fillRect(x, pad, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${s}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(txt, x + w / 2, pad + h / 2 + 1);
  ctx.restore();
}

function drawPairFrame(showB) {
  const pr = state.pair;
  if (!pr) return;
  const ctx = setupCanvas(pr.w, pr.h, pr.rs);
  ctx.drawImage(showB ? pr.bmpB : pr.bmpA, 0, 0);
  if (state.showRegions && state.regions && state.regions.list.length) drawRegionOverlay(ctx);
  drawCornerLabel(ctx, showB ? 'B' : 'A');
}

function compositeSplit() {
  const pr = state.pair;
  if (!pr) return;
  const ctx = setupCanvas(pr.w, pr.h, pr.rs);
  ctx.drawImage(pr.bmpA, 0, 0);
  const sx = Math.max(0, Math.min(pr.w, Math.round(pr.w * state.splitPos)));
  if (sx < pr.w) {
    ctx.drawImage(pr.bmpB, sx, 0, pr.w - sx, pr.h, sx, 0, pr.w - sx, pr.h);
  }
  if (state.showRegions && state.regions && state.regions.list.length) drawRegionOverlay(ctx);
  const lw = Math.max(2, Math.round(DPR * 2));
  ctx.save();
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(sx - lw / 2, 0, lw, pr.h);
  const r = Math.max(11, Math.round(11 * DPR));
  ctx.beginPath();
  ctx.arc(sx, pr.h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(r * 0.9)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⇄', sx, pr.h / 2 + 1);
  ctx.restore();
  drawCornerLabel(ctx, 'A', 'left');
  drawCornerLabel(ctx, 'B', 'right');
}

// ─────────────────────────────────────────────────────────
// あおり
// ─────────────────────────────────────────────────────────
function restartAoriTimer() {
  if (state.aoriTimer) clearInterval(state.aoriTimer);
  state.aoriTimer = setInterval(() => {
    state.aoriFlag = !state.aoriFlag;
    drawPairFrame(state.aoriFlag);
  }, state.aoriInterval);
}

function startAori() {
  state.aoriFlag = false;
  drawPairFrame(false);
  restartAoriTimer();
}

function stopAori() {
  if (state.aoriTimer) { clearInterval(state.aoriTimer); state.aoriTimer = null; }
}

// ─────────────────────────────────────────────────────────
// RENDER CURRENT VIEW
// ─────────────────────────────────────────────────────────
function updateTabControls() {
  const t = state.activeSubTab;
  regionControls.style.display = DIFF_TABS.includes(t) ? 'flex' : 'none';
  aoriControls.style.display = t === 'aori' ? 'flex' : 'none';
  highlightControls.style.display = (t === 'highlight') ? 'flex' : 'none';
  splitControls.style.display = t === 'split' ? 'flex' : 'none';
}

let _renderToken = 0;

// ハイライト/絶対値差の合成と表示 (テキストタブのPDFビューとしても使用)
async function renderDiffComposite(token, op, forceFit) {
  const visualScale = computeVisualScale();
  const [ea, eb] = await Promise.all([
    getOrRender('a', state.pageA, visualScale, false),
    getOrRender('b', state.pageB, visualScale, false),
  ]);
  if (token !== _renderToken) return false;

  const cacheKey = [
    op, state.pageA, state.pageB, ea.scale, state.sensitivity,
    state.emphasize ? 1 : 0,
    Math.round(state.offsetDx * 10), Math.round(state.offsetDy * 10),
  ].join('|');

  let result;
  if (state.lastDiffView && state.lastDiffView.key === cacheKey) {
    result = state.lastDiffView;
  } else {
    const imgB = alignBToA(eb, ea);
    busyShow();
    try {
      // 絶対値差は画像バッファのみを返すため、領域枠は別途軽量opで計算する
      const [imgRes, regionsRes] = await Promise.all([
        computeDiffImage(op, ea.img, imgB),
        op === 'highlight' ? null : computeRegionsOnly(ea.img, imgB),
      ]);
      const regions = op === 'highlight' ? (imgRes.regions || []) : regionsRes.regions;
      const count = op === 'highlight' ? (imgRes.count || 0) : regionsRes.count;
      result = { key: cacheKey, img: imgRes.img, count, regions };
    } finally {
      busyHide();
    }
    if (token !== _renderToken) return false;
    state.lastDiffView = result;
  }

  state.regions = { list: result.regions || [], rs: ea.scale };
  state.diffPixels = result.count || 0;
  state.regionIdx = -1;
  updateRegionList();
  displayImageData(result.img, ea.scale, true);
  if (forceFit) fitToView();
  return true;
}

async function renderCurrentView(forceFit = false) {
  const token = ++_renderToken;
  const tab = state.activeSubTab;

  updateTabControls();
  stopAori();

  const visualScale = computeVisualScale();

  if (tab === 'a' || tab === 'b') {
    const doc = tab === 'a' ? state.docA : state.docB;
    if (!doc) return showPlaceholder();
    closePair();
    const entry = await getOrRender(tab, tab === 'a' ? state.pageA : state.pageB, visualScale);
    if (token !== _renderToken) return;
    state.regions = null;
    updateRegionList();
    displayImageData(entry.img, entry.scale);
    if (forceFit) fitToView();
    return;
  }

  if (!state.docA || !state.docB) return showPlaceholder();

  if (tab === 'highlight' || tab === 'absdiff') {
    closePair();
    await renderDiffComposite(token, tab === 'absdiff' ? 'absdiff' : 'highlight', forceFit);
    return;
  }

  // ペアビットマップモード (あおり / スプリット)
  // PDF埋め込み注釈は表示設定に従う(差分判定には影響しない — スキャン/ハイライトは常に注釈なし)
  const [ea, eb, eaPlain, ebPlain] = await Promise.all([
    getOrRender('a', state.pageA, visualScale, state.showAnnA),
    getOrRender('b', state.pageB, visualScale, state.showAnnB),
    getOrRender('a', state.pageA, visualScale, false),
    getOrRender('b', state.pageB, visualScale, false),
  ]);
  if (token !== _renderToken) return;
  const imgB = alignBToA(eb, ea);
  const imgBPlain = alignBToA(ebPlain, eaPlain);
  const [, regionsRes] = await Promise.all([
    preparePair(ea.img, imgB, ea.scale),
    computeRegionsOnly(eaPlain.img, imgBPlain),
  ]);
  if (token !== _renderToken) { closePair(); return; }
  state.regions = { list: regionsRes.regions, rs: eaPlain.scale };
  state.diffPixels = regionsRes.count;
  state.regionIdx = -1;
  updateRegionList();

  if (tab === 'aori') {
    startAori();
  } else if (tab === 'split') {
    compositeSplit();
  }
  if (forceFit) fitToView();
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
  if (!changed) return;
  state.selectedAnnot = null;
  clearOffsetPreview();
  syncPageIndex();
  renderCurrentView(false);
  refreshTextPanel();
}
function goToPage(idx) {
  let changed = false;
  if (state.docA && idx >= 0 && idx < state.totalA) { state.pageA = idx; changed = true; }
  const bIdx = bPageFor(idx);
  if (state.docB && bIdx >= 0 && bIdx < state.totalB) { state.pageB = bIdx; changed = true; }
  if (changed) {
    state.selectedAnnot = null;
    clearOffsetPreview();
    syncPageIndex();
    renderCurrentView(false);
    refreshTextPanel();
  }
}

// ─────────────────────────────────────────────────────────
// OFFSET ADJUSTMENT
// ─────────────────────────────────────────────────────────
function resetOffset() {
  state.offsetDx = 0; state.offsetDy = 0; updateOffsetLabel();
  state.autoAlign = false;
  updateAutoAlignButton();
  clearOffsetPreview();
  if (['highlight', 'absdiff', 'aori', 'split'].includes(state.activeSubTab)) renderCurrentView();
}
function updateOffsetLabel() {
  const lbl = $('offset-label');
  if (lbl) lbl.textContent = `dx:${Math.round(state.offsetDx)}  dy:${Math.round(state.offsetDy)}`;
}

// ─────────────────────────────────────────────────────────
// DIFF COUNT BADGE
// ─────────────────────────────────────────────────────────
function allDiffPages() {
  return new Set([...state.diffPages, ...state.textDiffPages]);
}

function updateDiffCountBadge() {
  const n = allDiffPages().size;
  const oldBadge = $('diff-count-badge');
  if (oldBadge) {
    oldBadge.textContent = n > 0 ? `${n}件` : '';
    oldBadge.style.display = n > 0 ? 'inline-flex' : 'none';
  }
  const panelBadge = $('diff-panel-badge');
  if (panelBadge) {
    if (n === 0) {
      panelBadge.style.display = 'none';
    } else {
      panelBadge.textContent = `${n}件`;
      panelBadge.style.display = 'inline-block';
    }
  }
}

// ─────────────────────────────────────────────────────────
// DIFF SUMMARY PANEL & REGION LIST
// ─────────────────────────────────────────────────────────
function rebuildDiffSummaryPanel() {
  const total = Math.max(state.totalA, state.totalB);
  diffList.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const pix = state.diffPages.has(i);
    const txt = state.textDiffPages.has(i);
    if (state.diffFilterOnly && !pix && !txt) continue;
    const div = document.createElement('div');
    div.className = `diff-summary-item${(pix || txt) ? ' has-diff' : ''}${i === state.pageA ? ' current' : ''}`;
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    let marks = '';
    if (pix) marks += '<span class="diff-dot" title="画像差分"></span>';
    if (txt) marks += '<span class="diff-dot text" title="テキスト差分"></span>';
    div.innerHTML = marks + `Page ${i + 1}`;
    const activate = () => { goToPage(i); rebuildDiffSummaryPanel(); };
    div.addEventListener('click', activate);
    div.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    frag.appendChild(div);
  }
  diffList.appendChild(frag);
  const fb = $('btn-diff-filter');
  if (fb) {
    fb.textContent = state.diffFilterOnly ? '全て表示' : '絞り込み';
    fb.style.background = state.diffFilterOnly ? 'var(--diff-badge-bg)' : 'none';
    fb.style.color = state.diffFilterOnly ? '#000' : 'var(--text-muted)';
  }
}

function updateRegionList() {
  const wrap = $('region-list-wrap');
  const listEl = $('region-list');
  const cnt = $('region-count');
  const isDiffTab = DIFF_TABS.includes(state.activeSubTab);
  const list = (isDiffTab && state.regions) ? state.regions.list : [];

  if (diffPixelLabel) {
    diffPixelLabel.textContent = (isDiffTab && state.regions)
      ? `差分 ${state.diffPixels.toLocaleString()}px / ${list.length}領域`
      : '';
  }
  if (!wrap) return;
  const resizer = $('diff-panel-resizer');
  if (!list.length) {
    wrap.style.display = 'none';
    if (resizer) resizer.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }
  wrap.style.display = 'flex';
  if (resizer) resizer.style.display = 'block';
  cnt.textContent = `${Math.min(list.length, 100)}件${list.length > 100 ? '+' : ''}`;
  listEl.innerHTML = '';
  const rs = state.regions.rs;
  const frag = document.createDocumentFragment();
  list.slice(0, 100).forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'region-item' + (i === state.regionIdx ? ' current' : '');
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.textContent = `#${i + 1}  ${Math.round(r.w / rs)} × ${Math.round(r.h / rs)} px`;
    item.title = 'クリックで領域へズーム';
    const activate = () => { state.regionIdx = i; zoomToRegion(r); updateRegionList(); };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    frag.appendChild(item);
  });
  listEl.appendChild(frag);
}

function jumpToDiff(dir) {
  const sorted = [...allDiffPages()].sort((a, b) => a - b);
  if (!sorted.length) return;
  const cur = state.pageA;
  const target = dir === 'next'
    ? (sorted.find(p => p > cur) ?? sorted[0])
    : ([...sorted].reverse().find(p => p < cur) ?? sorted[sorted.length - 1]);
  goToPage(target); rebuildDiffSummaryPanel();
}

function toggleDiffPanel() {
  if (!state.docA && !state.docB) return;
  diffPanel.classList.toggle('visible');
  if (diffPanel.classList.contains('visible')) { rebuildDiffSummaryPanel(); updateRegionList(); }
}

// ─────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────
function exportCurrentView() {
  if (viewCanvas.style.display === 'none') {
    if (state.textPanelOpen && state.lastTextDiff) { exportTextReport(); return; }
    setStatus('表示中の画像がありません', 3000);
    return;
  }
  // 注釈オーバーレイも合成して書き出す
  const out = document.createElement('canvas');
  out.width = viewCanvas.width;
  out.height = viewCanvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(viewCanvas, 0, 0);
  if (annotCanvas.style.display !== 'none') ctx.drawImage(annotCanvas, 0, 0);
  out.toBlob(blob => {
    out.width = 0; out.height = 0;
    if (!blob) { setStatus('画像の書き出しに失敗しました', 3000); return; }
    downloadBlob(blob, `sabun_${state.activeSubTab}_A${state.pageA + 1}_B${state.pageB + 1}.png`);
    setStatus('画像を保存しました。', 3000);
  }, 'image/png');
}

// ─────────────────────────────────────────────────────────
// TAB SWITCH
// ─────────────────────────────────────────────────────────
function switchSubTab(subTab, render = true) {
  state.activeSubTab = subTab;
  document.querySelectorAll('[data-sub-tab]').forEach(btn => {
    const active = btn.dataset.subTab === subTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });
  applyModeCursor();
  if (render) renderCurrentView();
}

// ─────────────────────────────────────────────────────────
// DRAG & DROP
// ─────────────────────────────────────────────────────────
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
$('file-input-a').addEventListener('change', e => { if (e.target.files[0]) loadPDF('a', e.target.files[0]); e.target.value = ''; });
$('file-input-b').addEventListener('change', e => { if (e.target.files[0]) loadPDF('b', e.target.files[0]); e.target.value = ''; });

$('btn-zoom-in').addEventListener('click', () => zoomCenterBy(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomCenterBy(0.8));
$('btn-fit').addEventListener('click', fitToView);
btnDragMode.addEventListener('click', () => setPersistentMode('drag'));
if (btnOffsetMode) btnOffsetMode.addEventListener('click', () => setPersistentMode('offset'));
if (btnOffsetReset) btnOffsetReset.addEventListener('click', resetOffset);
if (btnMarqueeZoom) btnMarqueeZoom.addEventListener('click', () => setPersistentMode('marquee'));

$('btn-prev').addEventListener('click', () => changePage(-1));
$('btn-next').addEventListener('click', () => changePage(1));

pageInfo.addEventListener('click', () => {
  if (!state.docA && !state.docB) return;
  const currentPage = state.docA ? state.pageA + 1 : state.pageB + 1;
  const totalMax = Math.max(state.totalA || 0, state.totalB || 0);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = 1;
  input.max = totalMax;
  input.value = currentPage;
  input.setAttribute('aria-label', 'ページ番号');
  input.style.cssText = [
    'width:80px', 'text-align:center', 'font-size:inherit',
    'font-family:inherit', 'background:var(--bg-panel)',
    'color:var(--text-primary)', 'border:1px solid var(--accent)',
    'border-radius:4px', 'padding:2px 6px', 'outline:none',
  ].join(';');
  pageInfo.replaceWith(input);
  input.select();

  const commit = () => {
    const v = parseInt(input.value, 10);
    input.replaceWith(pageInfo);
    if (!isNaN(v) && v >= 1 && v <= totalMax) goToPage(v - 1);
    else updatePageInfo();
  };
  const cancel = () => { input.replaceWith(pageInfo); updatePageInfo(); };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
});

$('btn-export').addEventListener('click', exportCurrentView);
btnDiffList.addEventListener('click', toggleDiffPanel);
$('btn-close-diff-panel').addEventListener('click', () => diffPanel.classList.remove('visible'));
$('btn-diff-prev').addEventListener('click', () => jumpToDiff('prev'));
$('btn-diff-next').addEventListener('click', () => jumpToDiff('next'));

const btnDiffFilter = $('btn-diff-filter');
if (btnDiffFilter) {
  btnDiffFilter.addEventListener('click', () => {
    state.diffFilterOnly = !state.diffFilterOnly;
    rebuildDiffSummaryPanel();
  });
}

const btnRescan = $('btn-rescan');
if (btnRescan) {
  btnRescan.addEventListener('click', () => {
    if (state.docA && state.docB) startDiffScan();
  });
}

if (zoomCombo) {
  const applyZoomInput = () => {
    const val = parseFloat(String(zoomCombo.value).replace(/[%％\s]/g, ''));
    if (val > 0 && isFinite(val)) {
      const rect = viewContainer.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, (val / 100) / state.zoomFactor);
    } else {
      zoomCombo.value = Math.round(state.zoomFactor * 100) + '%';
    }
    zoomCombo.blur();
  };
  zoomCombo.addEventListener('change', applyZoomInput);
  zoomCombo.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); applyZoomInput(); }
    else if (e.key === 'Escape') { zoomCombo.value = Math.round(state.zoomFactor * 100) + '%'; zoomCombo.blur(); }
  });
  zoomCombo.addEventListener('focus', () => zoomCombo.select());
}

if (qualitySelect) {
  qualitySelect.addEventListener('change', () => {
    state.quality = qualitySelect.value;
    state.lastDiffView = null;
    clearOffsetPreview();
    evictOtherScales(computeVisualScale());
    setStatus(`画質: ${state.quality === 'high' ? '高 (3x)' : '標準 (2x)'}`, 3000);
    renderCurrentView();
  });
}

document.querySelectorAll('[data-sub-tab]').forEach(btn => btn.addEventListener('click', () => switchSubTab(btn.dataset.subTab)));

// テーマ切替 (ライト/ダーク — 初期値は head のインラインスクリプトで設定)
const btnTheme = $('btn-theme');
if (btnTheme) {
  btnTheme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sabun_theme', next); } catch { /* ignore */ }
    setStatus(`テーマ: ${next === 'dark' ? 'ダーク' : 'ライト'}`, 2000);
  });
}

if (btnHelp) btnHelp.addEventListener('click', () => helpModal.classList.add('visible'));
if (btnCloseHelp) btnCloseHelp.addEventListener('click', () => helpModal.classList.remove('visible'));
if (helpModal) helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.classList.remove('visible'); });

// PDF埋め込み注釈の表示 (A/Bタブのみ反映。差分判定には影響しない)
if (toggleAnnA) {
  toggleAnnA.addEventListener('change', () => {
    state.showAnnA = !!toggleAnnA.checked;
    setStatus(`A注釈: ${state.showAnnA ? '表示' : '非表示'} (差分判定には影響しません)`, 2500);
    renderCurrentView();
  });
}
if (toggleAnnB) {
  toggleAnnB.addEventListener('change', () => {
    state.showAnnB = !!toggleAnnB.checked;
    setStatus(`B注釈: ${state.showAnnB ? '表示' : '非表示'} (差分判定には影響しません)`, 2500);
    renderCurrentView();
  });
}

if (sensSelect) {
  sensSelect.addEventListener('change', () => {
    state.sensitivity = sensSelect.value;
    state.lastDiffView = null;
    const labels = { high: '高(微差も検出)', mid: '標準', low: '低(ノイズ無視)' };
    setStatus(`感度: ${labels[state.sensitivity]} — 一覧へ反映するには再スキャン(⟳)してください`, 4000);
    renderCurrentView();
  });
}

if (toggleRegions) {
  toggleRegions.addEventListener('change', () => {
    state.showRegions = !!toggleRegions.checked;
    renderCurrentView();
  });
}

if (toggleEmphasize) {
  toggleEmphasize.addEventListener('change', () => {
    state.emphasize = !!toggleEmphasize.checked;
    state.lastDiffView = null;
    renderCurrentView();
  });
}

// 領域ナビゲーション
const btnRegionPrev = $('btn-region-prev');
const btnRegionNext = $('btn-region-next');
if (btnRegionPrev) btnRegionPrev.addEventListener('click', () => navigateRegion(-1));
if (btnRegionNext) btnRegionNext.addEventListener('click', () => navigateRegion(1));

// 注釈バー
if (btnAnnot) {
  btnAnnot.addEventListener('click', () => {
    const show = annotBar.hidden;
    annotBar.hidden = !show;
    btnAnnot.classList.toggle('active', show);
    btnAnnot.setAttribute('aria-expanded', show);
    if (!show) setAnnotTool(state.annotTool); // ツール解除
  });
}
document.querySelectorAll('[data-annot-tool]').forEach(btn => {
  btn.addEventListener('click', () => setAnnotTool(btn.dataset.annotTool));
});

// 注釈スタイル: 変更は既定値に反映し、選択中の注釈にも即適用 (Acrobat風)
function applyStyleToSelection(patch) {
  if (!state.selectedAnnot) return;
  Object.assign(state.selectedAnnot, patch);
  drawAnnotsOverlay();
}
if (annotStrokeInput) {
  annotStrokeInput.addEventListener('input', () => {
    state.annotStroke = annotStrokeInput.value;
    applyStyleToSelection({ stroke: state.annotStroke });
  });
}
function currentFill() {
  return (annotFillEnable && annotFillEnable.checked) ? (annotFillInput ? annotFillInput.value : '#ffe14d') : null;
}
if (annotFillEnable) {
  annotFillEnable.addEventListener('change', () => {
    if (annotFillInput) annotFillInput.disabled = !annotFillEnable.checked;
    state.annotFill = currentFill();
    applyStyleToSelection({ fill: state.annotFill });
  });
}
if (annotFillInput) {
  annotFillInput.addEventListener('input', () => {
    state.annotFill = currentFill();
    applyStyleToSelection({ fill: state.annotFill });
  });
}
if (annotWidthSelect) {
  annotWidthSelect.addEventListener('change', () => {
    state.annotWidth = parseFloat(annotWidthSelect.value) || 1;
    applyStyleToSelection({ thickness: state.annotWidth });
  });
}
if (annotDashSelect) {
  annotDashSelect.addEventListener('change', () => {
    state.annotDash = annotDashSelect.value;
    applyStyleToSelection({ dash: state.annotDash });
  });
}
if (annotTargetSelect) {
  annotTargetSelect.addEventListener('change', () => {
    state.annotTarget = annotTargetSelect.value;
  });
}
// 記入者名 (デフォルト ADP / localStorage に永続化)
const annotAuthorInput = $('annot-author');
try {
  const savedAuthor = localStorage.getItem('sabun_annot_author');
  if (savedAuthor) state.annotAuthor = savedAuthor;
} catch { /* ignore */ }
if (annotAuthorInput) {
  annotAuthorInput.value = state.annotAuthor;
  annotAuthorInput.addEventListener('change', () => {
    state.annotAuthor = annotAuthorInput.value.trim() || 'ADP';
    annotAuthorInput.value = state.annotAuthor;
    try { localStorage.setItem('sabun_annot_author', state.annotAuthor); } catch { /* ignore */ }
    setStatus(`注釈の記入者名: ${state.annotAuthor}`, 2000);
  });
}
// ツールを維持 (Acrobat「選択したツールを維持」)
const annotKeepCheck = $('annot-keep-tool');
if (annotKeepCheck) {
  annotKeepCheck.addEventListener('change', () => {
    state.annotKeepTool = !!annotKeepCheck.checked;
  });
}
const btnAnnotRegionsPage = $('btn-annot-regions-page');
if (btnAnnotRegionsPage) btnAnnotRegionsPage.addEventListener('click', () => autoAnnotateRegions('page'));
const btnAnnotRegionsAll = $('btn-annot-regions-all');
if (btnAnnotRegionsAll) btnAnnotRegionsAll.addEventListener('click', () => autoAnnotateRegions('all'));
const btnAnnotDelete = $('btn-annot-delete');
if (btnAnnotDelete) btnAnnotDelete.addEventListener('click', deleteSelectedAnnot);
const btnAnnotClear = $('btn-annot-clear');
if (btnAnnotClear) {
  // ページ内クリアは A/B 両サイドの現在ページを対象 (確実に消えるように)
  btnAnnotClear.addEventListener('click', () => {
    let n = 0;
    for (const side of ['a', 'b']) {
      const list = annotListFor(side, annotPage(side));
      if (list && list.length) { n += list.length; list.length = 0; }
    }
    if (n) {
      state.selectedAnnot = null;
      drawAnnotsOverlay();
      updateAnnotListPanel();
      setStatus(`このページの注釈を${n}件クリアしました (A/B両方)`, 3000);
    } else {
      setStatus('このページに注釈はありません', 2000);
    }
  });
}
const btnAnnotClearAll = $('btn-annot-clear-all');
if (btnAnnotClearAll) {
  btnAnnotClearAll.addEventListener('click', () => {
    const n = annotCount('a') + annotCount('b');
    if (!n) { setStatus('注釈はありません', 2000); return; }
    if (!window.confirm(`全ページの注釈 ${n}件 をすべて削除します。よろしいですか？`)) return;
    annots.a.clear();
    annots.b.clear();
    state.selectedAnnot = null;
    drawAnnotsOverlay();
    updateAnnotListPanel();
    setStatus(`全ての注釈 ${n}件 を削除しました`, 3000);
  });
}
const btnAnnotSavePdf = $('btn-annot-savepdf');
if (btnAnnotSavePdf) btnAnnotSavePdf.addEventListener('click', saveAnnotatedPDF);
const btnAnnotXfdf = $('btn-annot-xfdf');
if (btnAnnotXfdf) btnAnnotXfdf.addEventListener('click', exportXFDF);

// 注釈一覧パネル
const btnAnnotList = $('btn-annot-list');
if (btnAnnotList) btnAnnotList.addEventListener('click', () => toggleAnnotListPanel());
const btnCloseAnnotList = $('btn-close-annot-list');
if (btnCloseAnnotList) btnCloseAnnotList.addEventListener('click', () => toggleAnnotListPanel(false));

// 検版レポート
const btnReport = $('btn-report');
if (btnReport) btnReport.addEventListener('click', () => generateReport());

// オフセット自動位置合わせ (ON/OFF)
const btnAutoAlign = $('btn-auto-align');
if (btnAutoAlign) {
  btnAutoAlign.addEventListener('click', async () => {
    if (!state.autoAlign) {
      state.autoAlignPrev = { dx: state.offsetDx, dy: state.offsetDy };
      const ok = await autoAlignOffset();
      if (ok) { state.autoAlign = true; updateAutoAlignButton(); }
    } else {
      state.autoAlign = false;
      const p = state.autoAlignPrev || { dx: 0, dy: 0 };
      state.offsetDx = p.dx;
      state.offsetDy = p.dy;
      updateOffsetLabel();
      updateAutoAlignButton();
      state.lastDiffView = null;
      clearOffsetPreview();
      renderCurrentView();
      setStatus('自動位置合わせをOFF (元のオフセットに戻しました)', 3000);
    }
  });
}

// ページ対応マッピング
const btnPageLink = $('btn-page-link');
if (btnPageLink) btnPageLink.addEventListener('click', togglePageLink);

const btnTextReport = $('btn-text-report');
if (btnTextReport) btnTextReport.addEventListener('click', exportTextReport);

// テキスト差分パネル (タブ非依存)
if (btnTextPanel) btnTextPanel.addEventListener('click', () => toggleTextPanel());
const btnCloseText = $('btn-close-text');
if (btnCloseText) btnCloseText.addEventListener('click', () => toggleTextPanel(false));

aoriSpeedSlider.addEventListener('input', () => {
  state.aoriInterval = parseInt(aoriSpeedSlider.value, 10);
  aoriSpeedLabel.textContent = state.aoriInterval + 'ms';
  if (state.activeSubTab === 'aori' && state.aoriTimer) restartAoriTimer();
});

window.addEventListener('resize', () => {
  if (viewCanvas.style.display !== 'none') applyTransform();
});

// テスト/拡張用フック
window.__SABUN__ = {
  state, annots, buildXFDF, renderCurrentView, loadPDF,
  autoAnnotateRegions, saveAnnotatedPDF, toggleTextPanel, buildNativeAnnotatedPdf,
  generateReport, autoAlignOffset, togglePageLink, toggleAnnotListPanel,
};

// ─────────────────────────────────────────────────────────
// パネルリサイザ — サイドバー(Aページ/Bページ) と 差分パネル(ページ一覧/領域一覧)
// ─────────────────────────────────────────────────────────
function makeRowResizer(handleEl, targetEl, opts = {}) {
  if (!handleEl || !targetEl) return;
  const min = opts.min ?? 80;
  handleEl.classList.add('row-resizer');
  handleEl.setAttribute('role', 'separator');
  handleEl.setAttribute('aria-orientation', 'horizontal');
  handleEl.title = 'ドラッグで高さを調整';
  handleEl.addEventListener('mousedown', e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = targetEl.getBoundingClientRect().height;
    const grow = opts.grow !== false; // true: 下にドラッグで拡大
    const onMove = ev => {
      const dy = ev.clientY - startY;
      const h = Math.max(min, startH + (grow ? dy : -dy));
      targetEl.style.flex = `0 0 ${h}px`;
      targetEl.style.maxHeight = 'none';
      if (opts.onResize) opts.onResize(h);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// サイドバー: A ペインの高さを A/B 境界で調整
const sidebarDivider = document.querySelector('.sidebar-divider');
const sidebarPaneA = document.querySelector('#sidebar .sidebar-pane');
makeRowResizer(sidebarDivider, sidebarPaneA, { min: 110 });

// 差分パネル: 領域一覧の高さを調整 (上にドラッグで拡大)
makeRowResizer($('diff-panel-resizer'), $('region-list-wrap'), { min: 70, grow: false });

// サイドパネルの横幅リサイザ (左端をドラッグで幅調整)
function makeColResizer(handleEl, panelEl, opts = {}) {
  if (!handleEl || !panelEl) return;
  const min = opts.min ?? 190;
  handleEl.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelEl.getBoundingClientRect().width;
    const onMove = ev => {
      const w = Math.max(min, Math.min(window.innerWidth * 0.7, startW + (startX - ev.clientX)));
      panelEl.style.flex = `0 0 ${w}px`;
      panelEl.style.maxWidth = 'none';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}
document.querySelectorAll('.col-resizer').forEach(h => makeColResizer(h, h.parentElement));

// A/B サムネイル欄へのドロップで読み込み先を指定
function wireDropTarget(el, side) {
  if (!el) return;
  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    dropOverlay.classList.remove('visible');
    const f = [...e.dataTransfer.files].find(x => x.name.toLowerCase().endsWith('.pdf'));
    if (f) await loadPDF(side, f);
  });
}
wireDropTarget(thumbListA ? thumbListA.closest('.sidebar-pane') : null, 'a');
wireDropTarget(thumbListB ? thumbListB.closest('.sidebar-pane') : null, 'b');

// 初期化
updateTabControls();
updateCacheLabel();
updatePageLinkButton();
updateAutoAlignButton();
ensureWorker();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
