/**
 * SABUN — diff-worker.js
 * ピクセル差分の計算をメインスレッド外で実行し、UIのフリーズを防ぐ。
 *
 * メッセージ形式:
 *   in : { id, op, width, height, a:ArrayBuffer, b:ArrayBuffer, params }
 *   out: { id, ok:true, ... } | { id, ok:false, error }
 *
 * op:
 *   'highlight' — ハイライト差分画像 + 差分px数 + 差分領域(矩形)を返す
 *   'absdiff'   — グレースケール絶対値差画像を返す
 *   'compare'   — 2x2ブロック平均グレー比較による差分有無(boolean)を返す
 */
importScripts('./pixelmatch-browser.js');

// 領域検出に使うブロックサイズ(画像px)。
// 以前の16px/5x5近傍連結では、離れた小さな差分まで一つの注釈枠に
// まとまりやすかったため、細かく分けて隣接ブロックだけを統合する。
const REGION_BLOCK = 16;
// 近接する文字・罫線・数値を、提出時に読める一つの差分領域として扱う。
// 16pxブロックの3つ先までを連結するため、48px未満の切れ目では枠を分断しない。
const REGION_LINK_RADIUS = 3;

// PDFの再書き出しで発生するサブピクセル由来の局所的なズレを扱う設定。
// ページ全体のオフセット補正後に、各タイルで最大1pxだけ再配置を試す。
// タイル全体の誤差が十分減るときだけ採用するので、1文字だけの実変更を
// 「ズレ」として消しにくい。
const LOCAL_ALIGN_TILE = 96;
const LOCAL_ALIGN_RANGE = 1;
const LOCAL_ALIGN_MIN_IMPROVEMENT = 0.18;

/**
 * ブロックグリッド上の連結成分から差分領域のバウンディングボックスを求める。
 * 隣接した差分ブロックは同一領域として統合する。
 */
function findRegions(blocks, bw, bh, w, h) {
  const seen = new Uint8Array(bw * bh);
  const qx = new Int32Array(bw * bh);
  const qy = new Int32Array(bw * bh);
  const regions = [];

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const idx = by * bw + bx;
      if (!blocks[idx] || seen[idx]) continue;

      let head = 0, tail = 0;
      qx[tail] = bx; qy[tail] = by; tail++;
      seen[idx] = 1;
      let minX = bx, maxX = bx, minY = by, maxY = by, cnt = 0;

      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++; cnt++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -REGION_LINK_RADIUS; dy <= REGION_LINK_RADIUS; dy++) {
          for (let dx = -REGION_LINK_RADIUS; dx <= REGION_LINK_RADIUS; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            const ni = ny * bw + nx;
            if (blocks[ni] && !seen[ni]) {
              seen[ni] = 1;
              qx[tail] = nx; qy[tail] = ny; tail++;
            }
          }
        }
      }

      const x = minX * REGION_BLOCK;
      const y = minY * REGION_BLOCK;
      regions.push({
        x, y,
        w: Math.min(w, (maxX + 1) * REGION_BLOCK) - x,
        h: Math.min(h, (maxY + 1) * REGION_BLOCK) - y,
        blocks: cnt,
      });
    }
  }
  regions.sort((p, q) => (p.y - q.y) || (p.x - q.x));
  return regions;
}

function luminance(data, p) {
  return data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
}

function discardSparseBlocks(blocks, minPixels) {
  if (minPixels <= 1) return;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] < minPixels) blocks[i] = 0;
  }
}

// Aのタイルと、(dx,dy)だけ移動したBのタイルの差を測る。
// 白紙部分だけで評価すると差が薄まるため、いずれかが十分に暗い画素を
// 優先する。位置ずれの境界を見落とさないよう、ここは全画素で評価する。
// 探索範囲を1pxに限定しているため、高解像度ページでも負荷を抑えられる。
function tileScore(a, b, width, height, x0, y0, x1, y1, dx, dy) {
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    const by = y - dy;
    if (by < 0 || by >= height) continue;
    for (let x = x0; x < x1; x++) {
      const bx = x - dx;
      if (bx < 0 || bx >= width) continue;
      const pa = (y * width + x) * 4;
      const pb = (by * width + bx) * 4;
      const va = luminance(a, pa), vb = luminance(b, pb);
      if (va > 245 && vb > 245) continue;
      sum += Math.abs(va - vb);
      count++;
    }
  }
  return count >= 24 ? { score: sum / count, count } : null;
}

// Bをタイルごとに局所整列して返す。採用されたタイル数も返し、将来的に
// UIへ「局所ズレを補正」と表示できるようにしておく。
function locallyAlignB(a, b, width, height) {
  let adjustedTiles = 0;
  const shifts = [];
  for (let y0 = 0; y0 < height; y0 += LOCAL_ALIGN_TILE) {
    const y1 = Math.min(height, y0 + LOCAL_ALIGN_TILE);
    for (let x0 = 0; x0 < width; x0 += LOCAL_ALIGN_TILE) {
      const x1 = Math.min(width, x0 + LOCAL_ALIGN_TILE);
      const base = tileScore(a, b, width, height, x0, y0, x1, y1, 0, 0);
      let best = base ? { ...base, dx: 0, dy: 0 } : null;
      if (base) {
        for (let dy = -LOCAL_ALIGN_RANGE; dy <= LOCAL_ALIGN_RANGE; dy++) {
          for (let dx = -LOCAL_ALIGN_RANGE; dx <= LOCAL_ALIGN_RANGE; dx++) {
            if (dx === 0 && dy === 0) continue;
            const candidate = tileScore(a, b, width, height, x0, y0, x1, y1, dx, dy);
            // 同点なら移動量が小さい候補を優先し、不必要な斜め移動を避ける。
            const isBetter = candidate && (
              candidate.score < best.score - 0.01 ||
              (Math.abs(candidate.score - best.score) <= 0.01 &&
                Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))
            );
            if (isBetter) best = { ...candidate, dx, dy };
          }
        }
      }
      const useShift = best && (best.dx !== 0 || best.dy !== 0) &&
        (base.score - best.score) / Math.max(base.score, 1) >= LOCAL_ALIGN_MIN_IMPROVEMENT;
      const dx = useShift ? best.dx : 0;
      const dy = useShift ? best.dy : 0;
      if (useShift) {
        adjustedTiles++;
        shifts.push({ x0, y0, x1, y1, dx, dy });
      }
    }
  }
  // 位置補正が不要なページでは入力バッファをそのまま使う。従来はここでも
  // ページ全体のコピーを作っており、高解像度PDFで大きな一時メモリを消費した。
  if (!adjustedTiles) return { data: b, adjustedTiles: 0 };

  const out = new Uint8ClampedArray(b);
  for (const { x0, y0, x1, y1, dx, dy } of shifts) {
      for (let y = y0; y < y1; y++) {
        const by = y - dy;
        for (let x = x0; x < x1; x++) {
          const bx = x - dx;
          const dst = (y * width + x) * 4;
          if (bx < 0 || bx >= width || by < 0 || by >= height) {
            out[dst] = out[dst + 1] = out[dst + 2] = out[dst + 3] = 255;
            continue;
          }
          const src = (by * width + bx) * 4;
          out[dst] = b[src]; out[dst + 1] = b[src + 1];
          out[dst + 2] = b[src + 2]; out[dst + 3] = b[src + 3];
        }
      }
  }
  return { data: out, adjustedTiles };
}

function opHighlight(a, b, width, height, threshold, minBlockPixels, emphasize, localAlign = true) {
  const aligned = localAlign ? locallyAlignB(a, b, width, height) : { data: b, adjustedTiles: 0 };
  b = aligned.data;
  const n = width * height;
  const mask = new Uint8Array(n * 4);
  // diffMask:true → 差分px のみ不透明で塗られる(AA・一致px は透明のまま)
  pixelmatch(a, b, mask, width, height, { threshold, includeAA: false, diffMask: true });

  const bw = Math.ceil(width / REGION_BLOCK);
  const bh = Math.ceil(height / REGION_BLOCK);
  const blocks = new Uint16Array(bw * bh);
  // 先にブロックごとの差分量を数え、単発のアンチエイリアス由来ノイズを
  // 除外する。差分画素そのものを後段で描画するため、実変更の形状は保つ。
  for (let y = 0; y < height; y++) {
    const rowBlock = ((y / REGION_BLOCK) | 0) * bw;
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3] !== 0) blocks[rowBlock + ((x / REGION_BLOCK) | 0)]++;
    }
  }
  discardSparseBlocks(blocks, minBlockPixels);
  // colorBuf: 0=一致, 1=橙(追加系), 2=水色(削除系)
  const colorBuf = new Uint8Array(n);
  let count = 0;
  // 強調時の膨張半径(px) — 細線の差分も視認できるように (控えめに1px)
  const R = emphasize ? 1 : 0;

  for (let y = 0; y < height; y++) {
    const rowBlock = ((y / REGION_BLOCK) | 0) * bw;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      if (mask[p + 3] === 0 || blocks[rowBlock + ((x / REGION_BLOCK) | 0)] === 0) continue;
      count++;
      const ya = a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114;
      const yb = b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114;
      const col = ya > yb ? 1 : 2; // B側が濃い=追加系→橙 / A側が濃い=削除系→水色
      if (R === 0) {
        colorBuf[i] = col;
      } else {
        const y0 = Math.max(0, y - R), y1 = Math.min(height - 1, y + R);
        const x0 = Math.max(0, x - R), x1 = Math.min(width - 1, x + R);
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * width;
          for (let xx = x0; xx <= x1; xx++) colorBuf[row + xx] = col;
        }
      }
    }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const c = colorBuf[i];
    if (c === 1) {
      out[p] = 255; out[p + 1] = 75; out[p + 2] = 0; out[p + 3] = 255;
    } else if (c === 2) {
      out[p] = 0; out[p + 1] = 196; out[p + 2] = 255; out[p + 3] = 255;
    } else {
      out[p] = (a[p] * 0.3) | 0;
      out[p + 1] = (a[p + 1] * 0.3) | 0;
      out[p + 2] = (a[p + 2] * 0.3) | 0;
      out[p + 3] = 255;
    }
  }

  const regions = count > 0 ? findRegions(blocks, bw, bh, width, height) : [];
  return { out, count, regions, adjustedTiles: aligned.adjustedTiles };
}

function opAbsDiff(a, b, width, height, localAlign = true) {
  if (localAlign) b = locallyAlignB(a, b, width, height).data;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const d = Math.abs(
      (a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114) -
      (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114)
    ) | 0;
    out[p] = d; out[p + 1] = d; out[p + 2] = d; out[p + 3] = 255;
  }
  return out;
}

// 差分領域のみ計算(画像バッファを返さない軽量版 — 自動注釈化などに使用)
function opRegions(a, b, width, height, threshold, minBlockPixels, localAlign = true) {
  const aligned = localAlign ? locallyAlignB(a, b, width, height) : { data: b, adjustedTiles: 0 };
  b = aligned.data;
  const n = width * height;
  const mask = new Uint8Array(n * 4);
  pixelmatch(a, b, mask, width, height, { threshold, includeAA: false, diffMask: true });
  const bw = Math.ceil(width / REGION_BLOCK);
  const bh = Math.ceil(height / REGION_BLOCK);
  const blocks = new Uint16Array(bw * bh);
  for (let y = 0; y < height; y++) {
    const rowBlock = ((y / REGION_BLOCK) | 0) * bw;
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3] === 0) continue;
      blocks[rowBlock + ((x / REGION_BLOCK) | 0)]++;
    }
  }
  discardSparseBlocks(blocks, minBlockPixels);
  let count = 0;
  for (let y = 0; y < height; y++) {
    const rowBlock = ((y / REGION_BLOCK) | 0) * bw;
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3] !== 0 && blocks[rowBlock + ((x / REGION_BLOCK) | 0)] !== 0) count++;
    }
  }
  const regions = count > 0 ? findRegions(blocks, bw, bh, width, height) : [];
  return { count, regions, adjustedTiles: aligned.adjustedTiles };
}

// 自動位置合わせ: B を (dx,dy) ずらした時の差が最小になるオフセットを探索する。
// 1/4 縮小で粗探索 → 原寸で微調整の2段階。戻り値は原寸px(=pt at scale1)。
function toGray(data, width, height, f) {
  const w = Math.floor(width / f), h = Math.floor(height / f);
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y * f) * width + (x * f)) * 4;
      g[y * w + x] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    }
  }
  return { g, w, h };
}

function sad(ga, gb, w, h, dx, dy, stride) {
  let sum = 0, cnt = 0;
  const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx);
  const y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
  for (let y = y0; y < y1; y += stride) {
    const rowA = y * w, rowB = (y - dy) * w;
    for (let x = x0; x < x1; x += stride) {
      sum += Math.abs(ga[rowA + x] - gb[rowB + x - dx]);
      cnt++;
    }
  }
  return cnt > 100 ? sum / cnt : Infinity;
}

function opAlign(a, b, width, height, range) {
  const f = 4;
  const A4 = toGray(a, width, height, f);
  const B4 = toGray(b, width, height, f);
  const r4 = Math.max(2, Math.round(range / f));
  let best = { dx: 0, dy: 0, s: Infinity };
  for (let dy = -r4; dy <= r4; dy++) {
    for (let dx = -r4; dx <= r4; dx++) {
      const s = sad(A4.g, B4.g, A4.w, A4.h, dx, dy, 2);
      if (s < best.s) best = { dx, dy, s };
    }
  }
  // 原寸で微調整 (粗探索結果の周囲 ±f)
  const A1 = toGray(a, width, height, 1);
  const B1 = toGray(b, width, height, 1);
  const cx = best.dx * f, cy = best.dy * f;
  let fine = { dx: cx, dy: cy, s: Infinity };
  for (let dy = cy - f; dy <= cy + f; dy++) {
    for (let dx = cx - f; dx <= cx + f; dx++) {
      const s = sad(A1.g, B1.g, A1.w, A1.h, dx, dy, 2);
      if (s < fine.s) fine = { dx, dy, s };
    }
  }
  // 基準(0,0)との比較で改善があるかも返す
  const base = sad(A1.g, B1.g, A1.w, A1.h, 0, 0, 2);
  return { dx: fine.dx, dy: fine.dy, score: fine.s, baseScore: base };
}

// 2x2ブロック平均グレースケール比較(スキャン用・アンチエイリアス耐性)
function opCompare(a, b, width, height, threshold, minPx, minBlockPixels, localAlign = true) {
  if (localAlign) b = locallyAlignB(a, b, width, height).data;
  const W = Math.floor(width / 2), H = Math.floor(height / 2);
  const bw = Math.ceil(width / REGION_BLOCK);
  const blocks = new Uint16Array(bw * Math.ceil(height / REGION_BLOCK));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ga = 0, gb = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const p = ((y * 2 + dy) * width + (x * 2 + dx)) * 4;
          ga += a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114;
          gb += b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114;
        }
      }
      if (Math.abs(ga - gb) / 4 > threshold) {
        const px = x * 2, py = y * 2;
        blocks[((py / REGION_BLOCK) | 0) * bw + ((px / REGION_BLOCK) | 0)]++;
      }
    }
  }
  for (const count of blocks) {
    if (count >= minBlockPixels && count > minPx) return true;
  }
  return false;
}

self.onmessage = e => {
  const { id, op, width, height, a, b, params = {} } = e.data;
  try {
    const A = new Uint8ClampedArray(a);
    const B = new Uint8ClampedArray(b);
    if (op === 'highlight') {
      const { out, count, regions, adjustedTiles } = opHighlight(A, B, width, height, params.threshold ?? 0.02, params.minBlockPixels ?? 5, params.emphasize !== false, params.localAlign !== false);
      self.postMessage({ id, ok: true, buf: out.buffer, count, regions, adjustedTiles }, [out.buffer]);
    } else if (op === 'absdiff') {
      const out = opAbsDiff(A, B, width, height, params.localAlign !== false);
      self.postMessage({ id, ok: true, buf: out.buffer }, [out.buffer]);
    } else if (op === 'regions') {
      const { count, regions, adjustedTiles } = opRegions(A, B, width, height, params.threshold ?? 0.02, params.minBlockPixels ?? 5, params.localAlign !== false);
      self.postMessage({ id, ok: true, count, regions, adjustedTiles });
    } else if (op === 'align') {
      const r = opAlign(A, B, width, height, params.range ?? 48);
      self.postMessage({ id, ok: true, ...r });
    } else if (op === 'compare') {
      const diff = opCompare(A, B, width, height, params.threshold ?? 15, params.minPx ?? 10, params.minBlockPixels ?? 5, params.localAlign !== false);
      self.postMessage({ id, ok: true, diff });
    } else {
      self.postMessage({ id, ok: false, error: 'unknown op: ' + op });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
