// Free path, automatic recognition (browser only):
// image quality → OCR (Tesseract.js, global `Tesseract`) → objects + names
// → anchor candidates → corridor inference → graph → quality gate.
import { inferCorridors, connectedComponents, keepLargestComponent } from './corridors.js';
import { kmeans, closing, opening, dilate, erode, removeWide, skeletonCorridors, distanceTransform, fillSmallHoles, shrinkRGBA, coverageMask } from './paths.js';
import { buildGraph, nearestLine, isConnected, anchorsReachable, largestPart, components, hLine, vLine, isH } from './geometry.js';
import { buildNetwork, nearestOnNetwork, pathLength } from './curves.js';
import { extractMap, labelsFor, splitAtNames, BUILDING_END, BUILDING_WORDS } from './buildings.js';

export const MAX_EDGE = 2000;
export const GATE = { minAvgConf: 60, minObjects: 3, minAnchors: 2, minCover: 0.1, maxEdge: 0.2 };
const MASK_EDGE = 400;
const ANCHOR_WORDS =
  /入口|出口|大門|門口|服務台|服務處|詢問|櫃台|廁所|洗手間|化妝室|電梯|樓梯|手扶梯|Entrance|Exit|Info|WC|Toilet|Lift|Elevator|Stair/i;

/** Draw a File/Blob/canvas into a canvas whose long edge ≤ MAX_EDGE. */
export async function loadToCanvas(src) {
  const bmp = src instanceof HTMLCanvasElement ? src : await createImageBitmap(src);
  const s = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  // Keep the full-resolution original: tiled OCR reads small text from it.
  c.source = bmp;
  c.sourceScale = 1 / s;
  return c;
}

/**
 * RGBA pixels of a canvas shrunk so the long edge ≤ maxEdge (shrinkRGBA: average to twice the
 * size, then sample), the same on every browser. Used for finding walkways: thin roads must stay road-coloured.
 */
function shrunkPixels(canvas, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s)), h = Math.max(1, Math.round(canvas.height * s));
  const full = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  return { d: shrinkRGBA(full, canvas.width, canvas.height, w, h), w, h, s };
}

/** Grayscale of a canvas, downscaled so the long edge ≤ maxEdge (sample = true: shrunkPixels). */
function gray(canvas, maxEdge, sample = false) {
  if (sample) {
    const { d, w, h, s } = shrunkPixels(canvas, maxEdge);
    const g = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    return { g, w, h, s };
  }
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return { g, w, h, s };
}

function otsu(g) {
  const hist = new Array(256).fill(0);
  for (const v of g) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/** Sharpness (Laplacian variance) and glare checks. */
export function checkQuality(canvas) {
  const { g, w, h } = gray(canvas, 800);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  const lapVar = sum2 / n - (sum / n) ** 2;
  const sorted = Uint8Array.from(g).sort();
  const median = sorted[sorted.length >> 1];
  // Glare = blown-out white patches *inside* the picture. White page margins / backgrounds
  // touch the image edge and are not glare (the official campus map has wide white margins).
  const bright = Uint8Array.from(g, (v) => (v >= 252 ? 1 : 0));
  const { label, comps } = connectedComponents(bright, w, h);
  const edgeIds = new Set();
  for (let x = 0; x < w; x++) { edgeIds.add(label[x]); edgeIds.add(label[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { edgeIds.add(label[y * w]); edgeIds.add(label[y * w + w - 1]); }
  let clipped = 0;
  for (const c of comps) if (!edgeIds.has(c.id)) clipped += c.size;
  const clippedRatio = clipped / g.length;
  // A digital/printed-white map has median ≈ 255; glare only matters on photos of paper.
  const glare = median < 230 && clippedRatio > 0.03;
  const issues = [];
  if (lapVar < 100) issues.push({ code: 'blur', msg: '照片模糊：請拿穩手機、靠近一點再拍' });
  if (glare) issues.push({ code: 'glare', msg: '偵測到反光：請換個角度，避開燈光直射' });
  return { lapVar: Math.round(lapVar), clippedRatio, glare, issues };
}

let workerPromise = null;
function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(['chi_tra', 'eng'], 1, {
      logger: (m) => getWorker.onProgress?.(m),
    });
    workerPromise.catch(() => (workerPromise = null));
  }
  getWorker.onProgress = onProgress;
  return workerPromise;
}

const cleanText = (t) =>
  t
    .replace(/\s+/g, ' ')
    .replace(/(?<=[㐀-鿿])\s+(?=[㐀-鿿])/g, '')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/\b([A-Z])[lI|]\b/g, '$11') // booth codes: "Bl" → "B1"
    .replace(/(?<=[㐀-鿿])\s+[A-Za-z]$/, '') // stray icon letter after a name ("宏觀樓 P")
    .trim();
const meaningful = (t) => /[㐀-鿿]/.test(t) || /[A-Za-z0-9]{3,}/.test(t) || /^[A-Z]\d+$/.test(t);

/**
 * Sparse-text OCR of the whole page. Returns {texts, boxes}: texts = meaningful lines
 * [{name, conf, bbox}] in canvas pixels; boxes = every text-like box (for erasing).
 */
async function ocrPage(worker, canvas) {
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const maxH = canvas.height * 0.15;
  const boxes = lines
    .filter((l) => l.confidence >= 10 && l.bbox.y1 - l.bbox.y0 < maxH && l.text.trim())
    .map((l) => l.bbox);
  const texts = lines
    .flatMap(splitAtGaps)
    .map((l) => ({ name: cleanText(l.text), conf: l.confidence, bbox: l.bbox }))
    .filter((l) => l.name && (meaningful(l.name) || isSingleCJK(l.name)));
  return { texts, boxes };
}

const isSingleCJK = (t) => /^[\u3400-\u9fff]$/.test(t);

/** Join text lines: no space between Chinese characters, a space otherwise. */
export function joinLines(parts) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (!out) { out = p; continue; }
    const cjk = /[\u3400-\u9fff]/;
    out += cjk.test(out.at(-1)) && cjk.test(p[0]) ? p : ' ' + p;
  }
  return out;
}

/**
 * Tesseract sometimes puts two labels that sit side by side on one "line"
 * (生活科 … 美術館). Split a line wherever the gap between words is wider than about one
 * character height.
 */
export function splitAtGaps(line) {
  const words = (line.words || []).filter((w) => w.text && w.text.trim());
  if (words.length < 2) return [line];
  const h = line.bbox.y1 - line.bbox.y0;
  const groups = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > h * 1.1) groups.push([words[i]]);
    else groups[groups.length - 1].push(words[i]);
  }
  if (groups.length === 1) return [line];
  return groups.map((g) => ({
    text: g.map((w) => w.text).join(' '),
    confidence: g.reduce((s, w) => s + w.confidence, 0) / g.length,
    bbox: {
      x0: Math.min(...g.map((w) => w.bbox.x0)), y0: Math.min(...g.map((w) => w.bbox.y0)),
      x1: Math.max(...g.map((w) => w.bbox.x1)), y1: Math.max(...g.map((w) => w.bbox.y1)),
    },
  }));
}

// ---------- OCR preprocessing ----------
/**
 * Erase long straight dark lines (booth borders, walls, table rules) from an OCR input, in
 * place. Tesseract often returns nothing for a small label boxed in by a thick border.
 * Text strokes are short, so runs longer than minRun pixels are safe to remove.
 */
export function stripLines(canvas, minRun = 60) {
  const W = canvas.width, H = canvas.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) dark[i] = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2] < 330 ? 1 : 0;
  const kill = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = -1;
    for (let x = 0; x <= W; x++) {
      const v = x < W && dark[y * W + x];
      if (v && s < 0) s = x;
      if (!v && s >= 0) { if (x - s >= minRun) kill.fill(1, y * W + s, y * W + x); s = -1; }
    }
  }
  for (let x = 0; x < W; x++) {
    let s = -1;
    for (let y = 0; y <= H; y++) {
      const v = y < H && dark[y * W + x];
      if (v && s < 0) s = y;
      if (!v && s >= 0) { if (y - s >= minRun) for (let k = s; k < y; k++) kill[k * W + x] = 1; s = -1; }
    }
  }
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!kill[i]) continue;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    n++;
  }
  if (n) g.putImageData(img, 0, 0);
  return n;
}

// ---------- tiled OCR ----------
export const TILE = { enabled: true, textPx: 32, tilePx: 1000, overlap: 0.2, minZoom: 1.8, maxZoom: 3, maxTiles: 24, minConf: 60 };

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return inter / Math.max(1, Math.min(area(a), area(b)));
};

/** Merge OCR readings; overlapping boxes keep the more confident (then longer) reading. */
export function mergeReadings(list) {
  const out = [];
  for (const t of [...list].sort((a, b) => b.conf - a.conf || b.name.length - a.name.length)) {
    if (out.some((o) => iou(o.bbox, t.bbox) > 0.5)) continue;
    out.push(t);
  }
  return out;
}

/** Plan overlapping tiles (canvas coordinates) so each tile is ~tilePx after zooming. */
export function planTiles(W, H, zoom, opt = TILE) {
  const size = opt.tilePx / zoom;
  const step = size * (1 - opt.overlap);
  const xs = [], ys = [];
  for (let x = 0; ; x += step) { xs.push(Math.min(x, Math.max(0, W - size))); if (x + size >= W) break; }
  for (let y = 0; ; y += step) { ys.push(Math.min(y, Math.max(0, H - size))); if (y + size >= H) break; }
  const tiles = [];
  for (const y of ys) for (const x of xs) tiles.push({ x0: x, y0: y, x1: Math.min(W, x + size), y1: Math.min(H, y + size) });
  return tiles;
}

/**
 * Second OCR pass on zoomed, overlapping tiles so small text is read at a fixed size
 * (~32 px tall) — from the full-resolution original when the canvas was downscaled.
 * Skipped when the text is already large enough.
 */
async function ocrTiles(worker, canvas, texts, boxes, onProgress) {
  const src = canvas.source || canvas;
  const ss = canvas.sourceScale || 1;
  const good = texts.filter((t) => t.conf >= 60);
  const hs = good.map((t) => t.bbox.y1 - t.bbox.y0).sort((a, b) => a - b);
  // Too little readable text to measure: assume it is small and read at the original's detail.
  const textH = hs.length >= 5 ? hs[Math.floor(hs.length * 0.3)] : TILE.textPx / Math.max(ss, 2);
  const zoom = Math.min(TILE.maxZoom * Math.max(1, ss), Math.max(TILE.textPx / Math.max(6, textH), Math.min(ss, TILE.maxZoom)));
  // Only worth it when small text can be read bigger: either the original photo has more
  // detail than the working canvas, or the text is clearly below the size OCR likes.
  // Measured on the regression maps: tiling only helps when the original photo has more detail
  // than the working canvas (large phone photos). On normal-size images it adds time, not accuracy.
  if (!TILE.enabled || (!TILE.always && ss <= 1.05) || zoom < TILE.minZoom) return { texts, boxes };
  const z = Math.max(zoom, 1);
  let tiles = planTiles(canvas.width, canvas.height, z);
  // Skip empty tiles (flat colour: sky, grass, blank paper).
  const g = canvas.getContext('2d', { willReadFrequently: true });
  tiles = tiles.filter((t) => {
    const d = g.getImageData(t.x0, t.y0, Math.max(1, t.x1 - t.x0), Math.max(1, t.y1 - t.y0)).data;
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 16) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sum2 += v * v; n++; }
    return sum2 / n - (sum / n) ** 2 > 60;
  }).slice(0, TILE.maxTiles);

  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  const found = [], foundBoxes = [];
  for (let i = 0; i < tiles.length; i++) {
    onProgress?.({ status: `放大辨識 ${i + 1}/${tiles.length}`, progress: (i + 1) / tiles.length });
    const t = tiles[i];
    const c = document.createElement('canvas');
    c.width = Math.round((t.x1 - t.x0) * z);
    c.height = Math.round((t.y1 - t.y0) * z);
    const cg = c.getContext('2d');
    cg.imageSmoothingQuality = 'high';
    cg.drawImage(src, t.x0 * ss, t.y0 * ss, (t.x1 - t.x0) * ss, (t.y1 - t.y0) * ss, 0, 0, c.width, c.height);
    stripLines(c, Math.round(TILE.textPx * 3));
    const { data } = await worker.recognize(c, {}, { blocks: true });
    const lines = (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
    const margin = 4; // px in the tile: text touching an inner tile edge is probably cut off
    for (const l of lines) {
      const b = l.bbox;
      const cut = (b.x0 < margin && t.x0 > 0) || (b.y0 < margin && t.y0 > 0) ||
        (b.x1 > c.width - margin && t.x1 < canvas.width) || (b.y1 > c.height - margin && t.y1 < canvas.height);
      if (cut) continue;
      const bbox = { x0: t.x0 + b.x0 / z, y0: t.y0 + b.y0 / z, x1: t.x0 + b.x1 / z, y1: t.y0 + b.y1 / z };
      if (l.confidence >= 10 && l.text.trim()) foundBoxes.push(bbox);
      const name = cleanText(l.text);
      if (name && meaningful(name) && l.confidence >= TILE.minConf) found.push({ name, conf: l.confidence, bbox, tiled: true });
    }
  }
  return { texts: mergeReadings([...texts, ...found]), boxes: [...boxes, ...foundBoxes] };
}

// ---------- OCR refinement ----------
/** Crop a text box, enlarge it so the text is ~64 px tall, grayscale + contrast stretch. */
function preparedCrop(canvas, b) {
  const h = b.y1 - b.y0, w = b.x1 - b.x0;
  const pad = Math.round(h * 0.25);
  const x0 = Math.max(0, Math.floor(b.x0 - pad)), y0 = Math.max(0, Math.floor(b.y0 - pad));
  const x1 = Math.min(canvas.width, Math.ceil(b.x1 + pad)), y1 = Math.min(canvas.height, Math.ceil(b.y1 + pad));
  const k = Math.max(1, Math.min(4, 64 / Math.max(8, h)));
  const c = document.createElement('canvas');
  c.width = Math.round((x1 - x0) * k);
  c.height = Math.round((y1 - y0) * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let lo = 255, hi = 0;
  const gray = new Uint8Array(c.width * c.height);
  for (let i = 0; i < gray.length; i++) {
    const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    gray[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Light text on a dark badge → invert so text is always dark on light.
  let sum = 0;
  for (const v of gray) sum += v;
  const invert = sum / gray.length < (lo + hi) / 2;
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < gray.length; i++) {
    let v = ((gray[i] - lo) * 255) / range;
    if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, vertical: h > 2.2 * w };
}

/** Re-read weak labels one by one at higher resolution; keep the better reading. */
async function refineTexts(worker, canvas, texts, onProgress) {
  const weak = texts.filter((t) => t.conf < 85).sort((a, b) => a.conf - b.conf).slice(0, 25);
  for (let i = 0; i < weak.length; i++) {
    onProgress?.({ status: `加強辨識文字 ${i + 1}/${weak.length}`, progress: (i + 1) / weak.length });
    const t = weak[i];
    const crop = preparedCrop(canvas, t.bbox);
    await worker.setParameters({
      tessedit_pageseg_mode: crop.vertical ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT : Tesseract.PSM.SINGLE_LINE,
    });
    const { data } = await worker.recognize(crop.canvas);
    const name = cleanText(data.text.replace(/\n/g, ' '));
    if (name && meaningful(name) && data.confidence > t.conf + 5) {
      t.name = name;
      t.conf = data.confidence;
      t.refined = true;
    }
  }
  return texts;
}

/** Common words on event / campus / building maps, used to fix one-character OCR slips. */
const VOCAB = [
  '洗手間', '化妝室', '服務台', '服務處', '詢問處', '售票亭', '售票處', '停車場', '醫護站', '急救站',
  '美食廣場', '美食區', '野餐區', '遊樂區', '展覽區', '舞台區', '主舞台', '觀眾席', '體育館', '圖書館',
  '游泳池', '籃球場', '排球場', '網球場', '電梯', '樓梯', '手扶梯', '出入口', '入口區', '垃圾桶',
  '回收場', '垃圾分類站', '公共設施', '哺乳室', '無障礙', '吸菸區', '集合點', '休息區', '寄物處',
  '失物招領', '活動中心', '行政大樓', '教學大樓', '學生餐廳', '會議室', '演講廳', '音樂館', '美術館',
  '科學館', '博物館', '紀念館', '大禮堂', '操場', '司令台', '警衛室', '便利商店', '文創市集', '手作體驗區',
  // general campus terms
  '車棚', '自行車棚', '學生社團', '活動中心', '學生宿舍', '行政大樓', '進修部大樓', '東側門', '西側門', '南側門',
  '北側門', '運動場', '游泳池', '體育館', '音樂館', '美術館', '網球場', '籃球場', '排球場', '好漢坡', '樓梯',
];
/** Visually similar characters seen at the end of building names. */
const SUFFIX_FIX = { 党: '堂', 鎊: '鐘', 吝: '亭', 鍛: '館', 舘: '館' };

/** Fix single-character OCR slips against the vocabulary (e.g. 先手間 → 洗手間, 樹人党 → 樹人堂). */
export function correctName(name) {
  let out = name;
  const words = VOCAB.filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  // Spans already spelled correctly (or fixed) are not touched again.
  const locked = [];
  const lock = (i, n) => locked.push([i, i + n]);
  for (const w of words) {
    let k = out.indexOf(w);
    while (k >= 0) { lock(k, w.length); k = out.indexOf(w, k + 1); }
  }
  const free = (i, n) => locked.every(([a, b]) => i + n <= a || i >= b);
  for (const w of words) {
    for (let i = 0; i + w.length <= out.length; i++) {
      if (!free(i, w.length)) continue;
      const seg = out.slice(i, i + w.length);
      let diff = 0;
      for (let k = 0; k < w.length; k++) if (seg[k] !== w[k]) diff++;
      if (diff === 1 && [...seg].every((ch) => /[㐀-鿿]/.test(ch))) {
        out = out.slice(0, i) + w + out.slice(i + w.length);
        lock(i, w.length);
        break;
      }
    }
  }
  return out.replace(/([㐀-鿿])([党鎊吝鍛舘])(?=$|\s)/g, (_, a, b) => a + SUFFIX_FIX[b]);
}

/**
 * Erase text from the image before looking for paths: each text box is filled with the
 * median colour of a thin ring around it, so labels on roads no longer break the road.
 */
export function eraseText(canvas, boxes) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const W = c.width, H = c.height;
  const unknown = [];
  for (const b of boxes) {
    // Only text-sized boxes. OCR sometimes reports huge boxes around illustrations; treating
    // those as text would erase (or exclude) whole stretches of path.
    if (b.y1 - b.y0 > H * 0.08 || b.x1 - b.x0 > W * 0.4) continue;
    const pad = Math.max(2, Math.round((b.y1 - b.y0) * 0.15));
    const x0 = Math.max(0, Math.floor(b.x0 - pad)), y0 = Math.max(0, Math.floor(b.y0 - pad));
    const x1 = Math.min(W - 1, Math.ceil(b.x1 + pad)), y1 = Math.min(H - 1, Math.ceil(b.y1 + pad));
    const ring = [[], [], []];
    const sample = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
    };
    for (let x = x0; x <= x1; x += 2) { sample(x, y0 - 2); sample(x, y1 + 2); }
    for (let y = y0; y <= y1; y += 2) { sample(x0 - 2, y); sample(x1 + 2, y); }
    if (!ring[0].length) continue;
    const pts = ring[0].map((_, k) => [ring[0][k], ring[1][k], ring[2][k]]);
    const med = ring.map((a) => [...a].sort((p, q) => p - q)[a.length >> 1]);
    const same = pts.filter((p) => Math.hypot(p[0] - med[0], p[1] - med[1], p[2] - med[2]) <= 30).length / pts.length;
    // Text sitting on one colour (a road, a badge, the background) is replaced by that colour.
    // Text on mixed surroundings is marked unknown: it must not become walkable by accident.
    if (same < 0.6 && (x1 - x0) * (y1 - y0) <= W * H * 0.005) unknown.push({ x0, y0, x1, y1 });
    // Inpaint instead of painting the whole box: text strokes and outlines (pixels whose
    // 5×5 neighbourhood is not a solid colour) are filled from their nearest solid
    // neighbours. Text on a building takes the building's colour, text on the ground takes
    // the ground's — a box that reaches over a building no longer repaints it as walkway.
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const col = new Uint8ClampedArray(bw * bh * 3);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((y + y0) * W + x + x0) * 4, k = (y * bw + x) * 3;
        col[k] = d[i]; col[k + 1] = d[i + 1]; col[k + 2] = d[i + 2];
      }
    }
    const hole = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const k = (y * bw + x) * 3;
        let same = 0, tot = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const q = (yy * bw + xx) * 3;
            tot++;
            if (Math.abs(col[q] - col[k]) + Math.abs(col[q + 1] - col[k + 1]) + Math.abs(col[q + 2] - col[k + 2]) <= 24) same++;
          }
        }
        if (same < tot * 0.9) hole[y * bw + x] = 1;
      }
    }
    let left = hole.reduce((s, v) => s + v, 0);
    for (let pass = 0; pass < 40 && left; pass++) {
      const fill = [];
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const p = y * bw + x;
          if (!hole[p]) continue;
          let r0 = 0, g0 = 0, b0 = 0, n = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const q = yy * bw + xx;
            if (hole[q]) continue;
            r0 += col[q * 3]; g0 += col[q * 3 + 1]; b0 += col[q * 3 + 2]; n++;
          }
          if (n) fill.push([p, r0 / n, g0 / n, b0 / n]);
        }
      }
      if (!fill.length) break;
      for (const [p, rr, gg, bb] of fill) {
        col[p * 3] = rr; col[p * 3 + 1] = gg; col[p * 3 + 2] = bb;
        hole[p] = 0;
      }
      left -= fill.length;
    }
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((y + y0) * W + x + x0) * 4, k = (y * bw + x) * 3;
        // anything never reached (a box made only of strokes) falls back to the ring colour
        const p = y * bw + x;
        d[i] = hole[p] ? med[0] : col[k];
        d[i + 1] = hole[p] ? med[1] : col[k + 1];
        d[i + 2] = hole[p] ? med[2] : col[k + 2];
      }
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, unknown };
}

/**
 * OCR inside one rectangle (a booth/room) as a single block of text. The booth is cut from
 * the full-resolution original when available and enlarged (up to ~1600 px wide), so small
 * booth labels are read at a comfortable size.
 */
async function ocrRegion(worker, canvas, r) {
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
  const src = canvas.source || canvas;
  const ss = canvas.sourceScale || 1;
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  // Use the original's extra detail, but don't upscale beyond it (upscaling misreads big text).
  const k = TILE.enabled ? Math.max(1, Math.min(ss, 1600 / Math.max(1, w))) : 1;
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.round(w * k));
  crop.height = Math.max(1, Math.round(h * k));
  const cg = crop.getContext('2d');
  cg.imageSmoothingQuality = 'high';
  cg.drawImage(src, r.x0 * ss, r.y0 * ss, w * ss, h * ss, 0, 0, crop.width, crop.height);
  const read = async (c) => {
    const { data } = await worker.recognize(c);
    const lines = data.text.split('\n').map(cleanText).filter((t) => t && meaningful(t));
    return { name: joinLines(lines), conf: lines.length ? data.confidence : 0 };
  };
  const plain = await read(crop);
  if (!TILE.enabled || plain.conf >= 90) return plain;
  // Second reading with the booth's border lines erased; keep the more confident one.
  if (!stripLines(crop, Math.round(Math.min(crop.width, crop.height) * 0.5))) return plain;
  const stripped = await read(crop);
  return stripped.conf > plain.conf ? stripped : plain;
}

/** Light pixels (Otsu) at ≤ maxEdge px; `s` = mask scale relative to the canvas. */
export function lightMask(canvas, maxEdge = 400) {
  const { g, w, h, s } = gray(canvas, maxEdge, true);
  // Cap the threshold: on an almost all-white plan Otsu would split white from light grey
  // (booth fill) instead of light from dark (walls, text).
  const t = Math.min(otsu(g), 200);
  const light = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) light[i] = g[i] > t ? 1 : 0;
  return { light, w, h, s };
}

/**
 * Enclosed light regions = booths/rooms: every connected light component except
 * the corridor network (largest), not touching the image border, reasonably sized
 * and roughly rectangular. Returned in canvas pixels.
 */
function findRooms(m) {
  const { comps } = connectedComponents(m.light, m.w, m.h);
  if (!comps.length) return [];
  const largest = comps.reduce((b, c) => (c.size > b.size ? c : b));
  const area = m.w * m.h;
  return comps
    .filter((c) => {
      if (c === largest) return false;
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      const boxArea = bw * bh;
      const touchesBorder = c.x0 === 0 || c.y0 === 0 || c.x1 === m.w - 1 || c.y1 === m.h - 1;
      return !touchesBorder && boxArea > area * 0.003 && boxArea < area * 0.2 && c.size / boxArea > 0.5;
    })
    .map((c) => ({
      x0: (c.x0 + 1) / m.s, y0: (c.y0 + 1) / m.s,
      x1: c.x1 / m.s, y1: c.y1 / m.s, open: false,
    }));
}

/** Corridors from the light mask, with text boxes removed. Lines in canvas pixels. */
export function corridorsFrom(m, texts) {
  const free = Uint8Array.from(m.light);
  const pad = 2;
  for (const { bbox } of texts) {
    const x0 = Math.max(0, Math.floor(bbox.x0 * m.s) - pad), x1 = Math.min(m.w, Math.ceil(bbox.x1 * m.s) + pad);
    const y0 = Math.max(0, Math.floor(bbox.y0 * m.s) - pad), y1 = Math.min(m.h, Math.ceil(bbox.y1 * m.s) + pad);
    for (let y = y0; y < y1; y++) free.fill(0, y * m.w + x0, y * m.w + x1);
  }
  const { lines, thickness } = inferCorridors(free, m.w, m.h);
  const up = 1 / m.s;
  return {
    lines: lines.map((L) => ({ ...L, c: L.c * up, range: L.range.map((v) => v * up) })),
    tol: thickness * up,
  };
}

const inside = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

const HERE_WORDS = /您在這裡|你在這裡|YOU ARE HERE|現在位置|目前位置/i;
const LEGEND_WORDS = /^(圖例|Legend)/i;
const isCJK = (ch) => /[㐀-鿿]/.test(ch || '');

/**
 * Merge text lines stacked directly on top of each other into one label:
 * "夢想舞台" + "Dream Stage", or a name wrapped over two lines ("資優大" + "樓").
 */
export function mergeStacked(texts) {
  const items = texts
    .map((t) => ({ ...t, bbox: { ...t.bbox }, lh: t.bbox.y1 - t.bbox.y0 }))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const out = [];
  for (const t of items) {
    const b = t.bbox;
    const above = out.find((o) => {
      if (o.nLines >= 2) return false;
      const gap = b.y0 - o.bbox.y1;
      const ov = Math.min(o.bbox.x1, b.x1) - Math.max(o.bbox.x0, b.x0);
      const cx = (b.x0 + b.x1) / 2, ocx = (o.bbox.x0 + o.bbox.x1) / 2;
      return (
        gap > -0.3 * t.lh && gap < 0.8 * Math.min(o.lh, t.lh) &&
        ov > 0.3 * Math.min(o.bbox.x1 - o.bbox.x0, b.x1 - b.x0) &&
        Math.abs(cx - ocx) < 0.5 * Math.max(o.bbox.x1 - o.bbox.x0, b.x1 - b.x0) &&
        t.lh < 1.6 * o.lh && o.lh < 1.6 * t.lh
      );
    });
    if (above) {
      const join = isCJK(above.name.at(-1)) && isCJK(t.name[0]) ? '' : ' ';
      above.name = above.name + join + t.name;
      above.conf = Math.min(above.conf, t.conf);
      above.bbox = {
        x0: Math.min(above.bbox.x0, b.x0), y0: Math.min(above.bbox.y0, b.y0),
        x1: Math.max(above.bbox.x1, b.x1), y1: Math.max(above.bbox.y1, b.y1),
      };
      above.lh = Math.max(above.lh, t.lh);
      above.nLines = (above.nLines || 1) + 1;
    } else out.push(t);
  }
  return out;
}

/**
 * Pick anchors: "you are here" and keyword objects (入口、服務台…) first, then spread-out
 * objects (farthest-point sampling). Anchors closer than minSep to a chosen one are skipped.
 */
export function pickAnchors(objects, max = 8, minSep = 0) {
  const dist2 = (a, b) => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
  const farEnough = (o, list) => list.every((c) => dist2(c, o) >= minSep * minSep);
  const chosen = [];
  for (const o of [
    ...objects.filter((o) => o.here),
    ...objects.filter((o) => !o.here && ANCHOR_WORDS.test(o.name)),
  ]) {
    if (chosen.length < max && farEnough(o, chosen)) chosen.push(o);
  }
  const rest = objects.filter((o) => !chosen.includes(o) && farEnough(o, chosen));
  const target = Math.min(max, Math.max(6, chosen.length));
  if (!chosen.length && rest.length) chosen.push(rest.shift());
  while (chosen.length < target && rest.length) {
    let bi = -1, bd = -1;
    rest.forEach((o, i) => {
      const d = Math.min(...chosen.map((c) => dist2(c, o)));
      if (d > bd) { bd = d; bi = i; }
    });
    if (bd < minSep * minSep) break;
    chosen.push(rest.splice(bi, 1)[0]);
  }
  return chosen;
}

/**
 * Share of corridor length within `frac` of the image edge (default 5%). Page margins and
 * decorative frames sit there; real walkways run through the map.
 */
const pathsOf = (g) => g.paths || [];
/** Straight corridors + curves. */
const roadCount = (g) => g.lines.length + pathsOf(g).length;
const roadLength = (g) => g.lines.reduce((t, L) => t + (L.range[1] - L.range[0]), 0) + pathsOf(g).reduce((t, P) => t + pathLength(P), 0);

/** Visit sample points along every corridor (about 20 per line, at least minStep apart) and every curve. */
function forEachSample(graph, minStep, fn) {
  for (const L of graph.lines) {
    const step = Math.max(minStep, (L.range[1] - L.range[0]) / 20);
    for (let t = L.range[0]; t <= L.range[1]; t += step) fn(L.a === 0 ? t : L.c, L.a === 0 ? L.c : t);
  }
  for (const P of pathsOf(graph)) {
    const step = Math.max(minStep, pathLength(P) / 20);
    let carry = 0;
    for (let i = 1; i < P.points.length; i++) {
      const a = P.points[i - 1], b = P.points[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      let t = carry;
      for (; t <= len; t += step) fn(a.x + ((b.x - a.x) * t) / (len || 1), a.y + ((b.y - a.y) * t) / (len || 1));
      carry = t - len;
    }
  }
}

/** Nearest point on any corridor or curve: { x, y, dist, id }. */
const nearestOnGraph = (graph, p) => nearestOnNetwork(graph.lines, pathsOf(graph), p);

/** largestPart for a network with curves (the same as largestPart when there are none). */
function largestNet(g, tol) {
  if (!pathsOf(g).length) return { ...largestPart(g, tol), paths: [] };
  if (isConnected(g)) return g;
  const comp = components(g);
  const len = new Map(), of = new Map();
  const roads = [...g.lines.map((L) => [L.id, L.range[1] - L.range[0]]), ...g.paths.map((P) => [P.id, pathLength(P)])];
  for (const [id, l] of roads) {
    const n = g.nodes.find((m) => m.lines.includes(id));
    const c = n ? comp.get(n.id) : null;
    of.set(id, c);
    len.set(c, (len.get(c) || 0) + l);
  }
  let best = null;
  for (const [c, l] of len) if (best === null || l > len.get(best)) best = c;
  return buildNetwork(g.lines.filter((L) => of.get(L.id) === best), g.paths.filter((P) => of.get(P.id) === best), tol);
}

/** The parts of a network that largestNet drops, each at least minLen long (as separate networks). */
function otherNets(g, tol, minLen) {
  if (!roadCount(g) || isConnected(g)) return [];
  const comp = components(g);
  const len = new Map(), of = new Map();
  const roads = [...g.lines.map((L) => [L.id, L.range[1] - L.range[0]]), ...pathsOf(g).map((P) => [P.id, pathLength(P)])];
  for (const [id, l] of roads) {
    const n = g.nodes.find((m) => m.lines.includes(id));
    const c = n ? comp.get(n.id) : null;
    of.set(id, c);
    len.set(c, (len.get(c) || 0) + l);
  }
  let best = null;
  for (const [c, l] of len) if (best === null || l > len.get(best)) best = c;
  return [...len].filter(([c, l]) => c !== best && c !== null && l >= minLen)
    .map(([c]) => buildNetwork(g.lines.filter((L) => of.get(L.id) === c), pathsOf(g).filter((P) => of.get(P.id) === c), tol));
}

export function edgeShare(graph, W, H, frac = 0.05) {
  const band = frac * Math.min(W, H);
  let inBand = 0, samples = 0;
  forEachSample(graph, 2, (sx, sy) => {
    const x = sx, y = sy;
    samples++;
    if (x < band || y < band || x > W - band || y > H - band) inBand++;
  });
  return samples ? inBand / samples : 0;
}

/** Bounding box of all corridor lines. */
function graphSpan(graph) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of graph.lines) {
    const [a, b] = L.range;
    const xs = L.a === 0 ? [a, b] : [L.c, L.c];
    const ys = L.a === 0 ? [L.c, L.c] : [a, b];
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs);
    y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  for (const P of pathsOf(graph)) {
    for (const q of P.points) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  }
  return { x0, y0, x1, y1 };
}

/** Snap anchors onto the graph and evaluate the quality gate. */
export function evaluate(graph, objects, anchors, size = null) {
  const snapped = anchors
    .map((o, i) => {
      const n = roadCount(graph) ? nearestOnGraph(graph, { x: o.cx, y: o.cy }) : null;
      return n && { id: o.id || `A${i + 1}`, name: o.name, x: n.x, y: n.y, line: n.id, ...(o.here ? { here: true } : {}) };
    })
    .filter(Boolean);
  const avgConf = objects.length ? objects.reduce((s, o) => s + o.conf, 0) / objects.length : 0;
  const connected = roadCount(graph) > 0 && isConnected(graph);
  const reachable = snapped.length > 0 && anchorsReachable(graph, snapped);
  const checks = [
    { ok: avgConf >= GATE.minAvgConf, label: `OCR 平均信心值 ${avgConf.toFixed(0)}（需 ≥ ${GATE.minAvgConf}）`,
      tip: '文字辨識不清楚：請靠近、拿穩，讓文字清楚入鏡' },
    { ok: objects.length >= GATE.minObjects, label: `辨識到 ${objects.length} 個有名稱的物件（需 ≥ ${GATE.minObjects}）`,
      tip: '辨識到的物件太少：請讓整張地圖入鏡' },
    { ok: snapped.length >= GATE.minAnchors, label: `錨點 ${snapped.length} 個（需 ≥ ${GATE.minAnchors}）`,
      tip: '找不到足夠的定位點：請確認入口、服務台等標示有拍進去' },
  ];
  if (size) {
    const s = roadCount(graph) ? graphSpan(graph) : { x0: 0, x1: 0, y0: 0, y1: 0 };
    const cover = ((s.x1 - s.x0) / size.w) * ((s.y1 - s.y0) / size.h);
    const ok = roadCount(graph) >= 3 && cover >= GATE.minCover;
    const hug = edgeShare(graph, size.w, size.h);
    checks.push({
      ok: roadCount(graph) > 0 && hug <= GATE.maxEdge,
      label: `走道貼著地圖邊緣的比例 ${Math.round(hug * 100)}%（需 ≤ ${GATE.maxEdge * 100}%）`,
      tip: '找到的「走道」大多沿著地圖外框，可能把背景當成了路：請按「重新框選」只框地圖，或取消勾選、自己補畫',
    });
    checks.push({
      ok, label: `走道涵蓋地圖 ${Math.round(cover * 100)}%（需 ≥ ${GATE.minCover * 100}%）`,
      tip: '找到的走道太少：請讓整張地圖入鏡，或取消勾選、自己補畫',
    });
  }
  checks.push(
    { ok: connected, label: connected ? '走道互相連通' : `走道 ${roadCount(graph)} 條，但沒有全部連通`,
      tip: '走道辨識不完整：請正對地圖、讓手機與地圖平行再拍' },
    { ok: reachable, label: reachable ? '所有錨點都能抵達' : '有錨點無法抵達',
      tip: '部分定位點不在走道上：可以取消勾選、自己補畫' },
  );
  return { anchors: snapped, checks, pass: checks.every((c) => c.ok), avgConf };
}

// ---------- walkable-area hypotheses ----------
/** Mask pixel → canvas: the centre of its block (not its corner: that shifted every road ~2 px up-left). */
export const maskToCanvas = (v, up) => (v + 0.5) * up;
/** Canvas → the mask pixel whose block contains it. */
export const canvasToMask = (v, s, n) => Math.min(n - 1, Math.max(0, Math.floor(v * s)));
/** Penalty for lines that run mostly off their own colour: 0.3 at ≤ 30 %, none at ≥ 60 %, linear between. */
export const ownFactor = (own) => Math.min(1, Math.max(0.3, 0.3 + ((own - 0.3) * 0.7) / 0.3));

function rgbData(canvas, maxEdge) {
  const { d, w, h } = shrunkPixels(canvas, maxEdge);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
  }
  return { rgb, w, h };
}

/** Distance from an object (its centre or the middle of any box edge) to the nearest corridor. */
function distToGraph(graph, o) {
  const b = o.box || { x0: o.cx, x1: o.cx, y0: o.cy, y1: o.cy };
  const pts = [
    { x: o.cx, y: o.cy }, { x: b.x0, y: o.cy }, { x: b.x1, y: o.cy }, { x: o.cx, y: b.y0 }, { x: o.cx, y: b.y1 },
  ];
  return Math.min(...pts.map((p) => nearestOnGraph(graph, p).dist));
}

function scoreGraph(graph, objects, W, H, area) {
  if (!roadCount(graph) || !isConnected(graph)) return { score: 0 };
  const s = graphSpan(graph);
  // Coverage matters, but with diminishing returns: a big area is not better per se.
  const span = Math.sqrt(((s.x1 - s.x0) / W) * ((s.y1 - s.y0) / H));
  const near = 0.06 * Math.max(W, H);
  const fit = objects.length
    ? objects.filter((o) => distToGraph(graph, o) < near).length / objects.length
    : 0.5;
  const fillPenalty = area > 0.5 ? 0.4 : 1; // the whole page background is not a path
  // Real paths are smooth: long segments. Textures (tents, trees, text) give many tiny ones.
  const total = roadLength(graph);
  const avgLen = total / roadCount(graph);
  const smooth = Math.min(1, avgLen / (0.03 * Math.max(W, H)));
  const simplicity = 1 / (1 + roadCount(graph) / 400);
  // Page background / margins hug the image edge; real walkways run through the middle.
  const band = 0.1 * Math.min(W, H);
  let inBand = 0, samples = 0;
  forEachSample(graph, 4, (sx, sy) => {
    const x = sx, y = sy;
    samples++;
    if (x < band || y < band || x > W - band || y > H - band) inBand++;
  });
  const edge = samples ? inBand / samples : 0;
  const inner = Math.max(0, 1 - 3 * edgeShare(graph, W, H) - edge);
  const score = span * (0.25 + fit) * fillPenalty * smooth * simplicity * inner;
  return { score, span: +span.toFixed(2), fit: +fit.toFixed(2), smooth: +smooth.toFixed(2), edge: +edge.toFixed(2) };
}

/** Clear a band along the image edge: decorative frames are never walkways. */
function clearBorder(mask, w, h, b) {
  const out = Uint8Array.from(mask);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < b || y < b || x >= w - b || y >= h - b) out[y * w + x] = 0;
    }
  }
  return out;
}

/**
 * Recall first: a path is often cut into pieces by people, signs or icons drawn on it.
 * Trace every sizeable piece of the walkable region, then join each piece to the main
 * network with a short axis-aligned link where the gap is small. Returns graph lines in
 * canvas pixels, or null when there is nothing to add.
 */
/** Median colour of the pixels in a region (measured, not the cluster centre). */
function regionMedian(region, rgb, n) {
  const ch = [[], [], []];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    if (k++ % 4 !== 0) continue;
    for (let c = 0; c < 3; c++) ch[c].push(rgb[i * 3 + c]);
  }
  if (!ch[0].length) return null;
  return ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
}

/** Share of a block's outline pixels whose outside neighbour lies in other. */
function contactRatio(block, other, w, h) {
  let edge = 0, touch = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!block[p]) continue;
      let isEdge = false, isTouch = false;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || block[q]) continue;
        isEdge = true;
        if (other[q]) isTouch = true;
      }
      if (isEdge) { edge++; if (isTouch) touch++; }
    }
  }
  return edge ? touch / edge : 0;
}

/**
 * Recall first: when the winner's bridged version (name + '~') scores nearly as well (≥ 85 %) but
 * is a much fuller network (twice the length, wider span), take the bridged one. Two near-equal
 * scores should not hand the map a small fragment of its roads.
 */
export function preferFuller(cands) {
  const best = cands[0] || null;
  if (!best || best.name.endsWith('~')) return best;
  const alt = cands.find((c) => c.name === best.name + '~');
  if (alt && alt.score >= 0.85 * best.score && roadLength(alt.graph) >= 2 * roadLength(best.graph) && alt.span > best.span) return alt;
  return best;
}

export function connectPieces(region, m, maxE, up, border, road, unknown = null) {
  const n = m.w * m.h;
  const cleaned = clearBorder(fillSmallHoles(closing(region, m.w, m.h, 1), m.w, m.h, Math.round(n * 0.001), Math.max(3, Math.round(maxE * 0.008))), m.w, m.h, border);
  const { label, comps } = connectedComponents(cleaned, m.w, m.h);
  const pieces = comps.filter((c) => c.size >= n * 0.002).sort((a, b) => b.size - a.size);
  if (!pieces.length) return null;
  const graphs = [];
  // A piece whose skeleton falls apart (a junction lost at a thin spot) keeps its other long parts
  // too: they are linked in like separate pieces, after them (the main network is unchanged).
  const parts = [];
  for (const p of pieces.slice(0, 25)) {
    const mk = Uint8Array.from(label, (l) => (l === p.id ? 1 : 0));
    let pa = 0, pt = 0;
    for (const v of mk) pa += v;
    for (const v of removeWide(mk, m.w, m.h, Math.round(maxE * 0.025))) pt += v;
    if (pa && pt / pa < 0.6) continue; // wide blob (building, lawn), not a path
    const psk = skeletonCorridors(mk, m.w, m.h);
    const lines = psk.lines.map((L) => ({ ...L, c: maskToCanvas(L.c, up), range: L.range.map((v) => maskToCanvas(v, up)) }));
    const curves = psk.paths.map((P) => ({ ...P, points: P.points.map((q) => ({ x: maskToCanvas(q.x, up), y: maskToCanvas(q.y, up) })) }));
    if (!lines.length && !curves.length) continue;
    const net = buildNetwork(lines, curves, 3 * up);
    const g = largestNet(net, 3 * up);
    if (roadCount(g)) graphs.push(g);
    for (const o of otherNets(net, 3 * up, 0.1 * maxE * up)) if (roadCount(o)) parts.push(o);
  }
  graphs.push(...parts);
  if (graphs.length < 2) return null;
  // grow the main network piece by piece, nearest first
  let lines = [...graphs[0].lines];
  let curves = [...graphs[0].paths];
  let nodes = [...graphs[0].nodes];
  // Where a piece can be linked: its nodes and, on curves, every bend (a smooth curve has few nodes).
  // Bends are marked (node: false): a straight line ending on a bend would not be joined to the curve.
  const linkPts = (g) => {
    const seen = new Map();
    for (const q of g.nodes) seen.set(`${q.x},${q.y}`, { x: q.x, y: q.y, node: true });
    for (const P of g.paths) for (const q of P.points) if (!seen.has(`${q.x},${q.y}`)) seen.set(`${q.x},${q.y}`, { x: q.x, y: q.y, node: false });
    return [...seen.values()];
  };
  // Walkable for bridging a gap: the cleaned region (all pieces) and the main network's road.
  // Unreadable text boxes drawn over a road only hide it: a gap under one may be bridged (not for
  // the L-link rule, which uses road alone, so links do not cut across labels on buildings).
  const walk = road || unknown ? Uint8Array.from(cleaned, (v, i) => (v || road?.[i] || unknown?.[i] ? 1 : 0)) : cleaned;
  const maxRun = 2 * Math.max(2, Math.round(maxE * 0.008)); // twice the closing radius used for the mask
  /** Longest run of consecutive samples (one per mask pixel) off the walkable area. */
  const gapRun = (x0, y0, x1, y1) => {
    const steps = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / up));
    let run = 0, worst = 0;
    for (let t = 0; t <= steps; t++) {
      const x = canvasToMask(x0 + ((x1 - x0) * t) / steps, 1 / up, m.w);
      const y = canvasToMask(y0 + ((y1 - y0) * t) / steps, 1 / up, m.h);
      run = walk[y * m.w + x] ? 0 : run + 1;
      worst = Math.max(worst, run);
    }
    return worst;
  };
  let ends = linkPts(graphs[0]);
  const rest = graphs.slice(1);
  const maxGap = 0.06 * maxE * up;
  let id = 0;
  for (let changed = true; changed && rest.length; ) {
    changed = false;
    let best = null;
    rest.forEach((g, gi) => {
      for (const a of linkPts(g)) {
        for (const b of ends) {
          const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (d <= maxGap && (!best || d < best.d)) best = { d, a, b, gi };
        }
      }
    });
    if (!best) break;
    const { gi } = best;
    const g = rest.splice(gi, 1)[0];
    // L-shaped link: try both corners; the link must run mostly over walkable pixels
    const offRoad = (x0, y0, x1, y1) => {
      if (!road) return 0;
      let off = 0, tot = 0;
      const steps = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / up));
      for (let t = 0; t <= steps; t++) {
        const x = canvasToMask(x0 + ((x1 - x0) * t) / steps, 1 / up, m.w);
        const y = canvasToMask(y0 + ((y1 - y0) * t) / steps, 1 / up, m.h);
        tot++;
        if (!road[y * m.w + x]) off++;
      }
      return off / tot;
    };
    // With curves around (smooth roads have few nodes), try the closest pairs in turn: an L link by
    // the old rule, or else a straight link (a two-point curve) across a short gap. Without curves:
    // the nearest pair and the L rule only, as before.
    const withCurves = curves.length > 0 || g.paths.length > 0;
    const pairs = withCurves
      ? linkPts(g).flatMap((p) => ends.map((q) => ({ a: p, b: q, d: Math.abs(p.x - q.x) + Math.abs(p.y - q.y) })))
        .filter((q) => q.d <= maxGap).sort((p, q) => p.d - q.d).slice(0, 40)
      : [best];
    let link = null;
    for (const { a, b } of pairs) {
      const viaA = (offRoad(a.x, a.y, b.x, a.y) + offRoad(b.x, a.y, b.x, b.y)) / 2;
      const viaB = (offRoad(a.x, a.y, a.x, b.y) + offRoad(a.x, b.y, b.x, b.y)) / 2;
      if (Math.min(viaA, viaB) <= 0.4 || (withCurves && gapRun(a.x, a.y, b.x, b.y) <= maxRun)) { link = { a, b, viaA, viaB }; break; }
    }
    if (!link) { changed = true; continue; } // would cut across non-road: drop this piece
    const { a, b, viaA, viaB } = link;
    if (Math.min(viaA, viaB) > 0.4) {
      curves.push({ id: `J${++id}`, points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] });
    } else if (a.node === false || b.node === false) {
      // an end on a bend: the L link is a curve too, so it joins the bend
      const corner = viaA <= viaB ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      curves.push({ id: `J${++id}`, points: [{ x: a.x, y: a.y }, corner, { x: b.x, y: b.y }] });
    } else if (viaA <= viaB) {
      if (a.x !== b.x) lines.push(hLine(`J${++id}`, a.y, a.x, b.x));
      if (a.y !== b.y) lines.push(vLine(`J${++id}`, b.x, a.y, b.y));
    } else {
      if (a.y !== b.y) lines.push(vLine(`J${++id}`, a.x, a.y, b.y));
      if (a.x !== b.x) lines.push(hLine(`J${++id}`, b.y, a.x, b.x));
    }
    lines = lines.concat(g.lines.map((L) => ({ ...L, id: `${L.id}p${gi}_${id}` })));
    curves = curves.concat(g.paths.map((P) => ({ ...P, id: `${P.id}p${gi}_${id}` })));
    nodes = nodes.concat(g.nodes);
    ends = ends.concat(linkPts(g));
    changed = true;
  }
  return { lines, paths: curves };
}

/**
 * Page background = colours that dominate the outer ring of the image (≥ 35% of it).
 * Returns a mask (1 = background-coloured pixel) and the background colours.
 */
export function backgroundMask(rgb, w, h) {
  const n = w * h;
  const km = kmeans(rgb, n, 12);
  const ringW = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  const inRing = (x, y) => x < ringW || y < ringW || x >= w - ringW || y >= h - ringW;
  const ring = new Array(km.centers.length).fill(0);
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inRing(x, y)) { ring[km.labels[y * w + x]]++; total++; }
  // Only the single most dominant edge colour, and only if it clearly dominates.
  let top = 0;
  for (let c = 1; c < ring.length; c++) if (ring[c] > ring[top]) top = c;
  const mask = new Uint8Array(n);
  if (ring[top] / total < 0.35) return { mask, colors: [], info: { top: km.centers[top].map(Math.round), share: +(ring[top] / total).toFixed(2), rejected: 'share' } };
  // The page may have two big edge colours (cream margin + beige paths) that nearly tie: try
  // each in turn, largest first, and take the first that forms a wide open area.
  const tops = ring.map((_, c) => c).filter((c) => ring[c] / total >= 0.35).sort((p, q) => ring[q] - ring[p]);
  let narrowInfo = null;
  for (const tc of tops) {
    const bg = km.centers[tc];
    const like = (i) => Math.hypot(bg[0] - rgb[i * 3], bg[1] - rgb[i * 3 + 1], bg[2] - rgb[i * 3 + 2]) <= 14;
    // Background = pixels of that colour connected to the image edge (flood fill from the ring),
    // so the same colour used inside the map is not thrown away.
    const mask = new Uint8Array(n);
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (inRing(x, y) && like(i)) { mask[i] = 1; stack.push(i); }
      }
    }
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
        if (q >= 0 && q < n && !mask[q] && like(q)) { mask[q] = 1; stack.push(q); }
      }
    }
    // A page background is a wide open area. Roads that run off the edge of a street map
    // are narrow — those are paths, not background.
    const dist = distanceTransform(mask, w, h);
    let widest = 0;
    for (const v of dist) if (v > widest && v < 1e8) widest = v;
    const info = { top: bg.map(Math.round), share: +(ring[tc] / total).toFixed(2), widest: +(widest / Math.max(w, h)).toFixed(3) };
    if (widest < Math.max(w, h) * 0.035) { narrowInfo ??= { ...info, rejected: 'narrow' }; continue; }
    // Paths drawn in the page colour connect to the edge and would be flooded as background.
    // A page background is wide: keep only its wide parts (opening) still connected to the edge,
    // so narrow same-coloured paths stay available as walkways.
    const R = Math.max(2, Math.round(Math.max(w, h) * 0.015));
    const opened = dilate(erode(mask, w, h, R), w, h, R);
    const wide = new Uint8Array(n);
    const st = [];
    for (let i = 0; i < n; i++) {
      const x = i % w, y = (i - x) / w;
      if (opened[i] && mask[i] && inRing(x, y)) { wide[i] = 1; st.push(i); }
    }
    while (st.length) {
      const p = st.pop();
      const x = p % w;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
        if (q >= 0 && q < n && !wide[q] && opened[q] && mask[q]) { wide[q] = 1; st.push(q); }
      }
    }
    return { mask: wide, colors: [bg.map(Math.round)], info };
  }
  return { mask: new Uint8Array(n), colors: [], info: narrowInfo };
}

/**
 * Try several hypotheses of "what is walkable" — light areas (indoor plans), and each
 * dominant colour and pairs of similar colours (paths/roads in illustrated or street maps),
 * with and without wide open areas removed — and keep the graph that best fits the map.
 * The page background and unreadable erased-text boxes are never walkable.
 */
/** Canvas boxes → a mask with every block they touch set (floor / ceil, clipped). */
export function boxesToMask(boxes, m) {
  const mk = new Uint8Array(m.w * m.h);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0 * m.s)), x1 = Math.min(m.w, Math.ceil(b.x1 * m.s));
    const y0 = Math.max(0, Math.floor(b.y0 * m.s)), y1 = Math.min(m.h, Math.ceil(b.y1 * m.s));
    for (let y = y0; y < y1; y++) if (x1 > x0) mk.fill(1, y * m.w + x0, y * m.w + x1);
  }
  return mk;
}

export function bestCorridors(canvas, m, texts, objects, unknownBoxes = [], original = canvas, textBoxes = []) {
  const { rgb } = rgbData(canvas, MASK_EDGE);
  // Background is judged on the original image, so erasing text cannot shift it.
  const rgbOrig = original === canvas ? rgb : rgbData(original, MASK_EDGE).rgb;
  const n = m.w * m.h;
  const up = 1 / m.s;
  const maxE = Math.max(m.w, m.h);
  const border = Math.round(maxE * 0.03);
  const scale = (L) => ({ ...L, c: maskToCanvas(L.c, up), range: L.range.map((v) => maskToCanvas(v, up)) });
  const scaleP = (P) => ({ ...P, points: P.points.map((q) => ({ x: maskToCanvas(q.x, up), y: maskToCanvas(q.y, up) })) });
  const clean = (mk) => opening(closing(mk, m.w, m.h, 1), m.w, m.h, 1);

  // Excluded pixels: page background + erased text boxes whose surroundings were mixed.
  const bg = backgroundMask(rgbOrig, m.w, m.h);
  const excluded = Uint8Array.from(bg.mask);
  const unk = boxesToMask(unknownBoxes, m);
  for (let i = 0; i < n; i++) if (unk[i]) excluded[i] = 1;
  const without = (mk) => Uint8Array.from(mk, (v, i) => (v && !excluded[i] ? 1 : 0));

  // Colour clusters of the remaining (non-background) pixels only, so a path colour close
  // to the background colour still gets a cluster of its own.
  const idx = [];
  for (let i = 0; i < n; i++) if (!excluded[i]) idx.push(i);
  const sub = new Uint8Array(idx.length * 3);
  idx.forEach((i, k) => sub.set(rgb.subarray(i * 3, i * 3 + 3), k * 3));
  const km = idx.length > 100 ? kmeans(sub, idx.length, 10) : { centers: [], labels: [], counts: [] };
  const labels = new Int16Array(n).fill(-1);
  idx.forEach((i, k) => (labels[i] = km.labels[k]));

  // 'light' is only used for indoor plans (white corridors between booths, 'bands' method).
  const masks = [{ name: 'light', mask: m.light, bands: true }];
  // Street-style maps draw roads as plain near-white, colourless lines. Colour clustering can
  // merge them with cream/beige ground, so they get a hypothesis of their own.
  // Judged on the full-size map, then pooled: roads only 1–2 mask pixels wide must not blend away.
  const fullPx = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const isWhite = (r, g, b) => Math.min(r, g, b) >= 238 && Math.max(r, g, b) - Math.min(r, g, b) <= 14;
  const cover = coverageMask(fullPx, canvas.width, canvas.height, m.w, m.h, isWhite, 0.25);
  const white = Uint8Array.from(cover, (v, i) => (v && !excluded[i] ? 1 : 0));
  let whiteCount = 0;
  for (const v of white) whiteCount += v;
  if (whiteCount / n >= 0.02 && whiteCount / n <= 0.6) masks.push({ name: 'white', mask: closing(white, m.w, m.h, 1), color: [255, 255, 255] }); // no opening: roads may be 1–2 px wide here
  const usable = km.centers.map((_, c) => km.counts[c] / n).map((f) => f >= 0.02 && f <= 0.6);
  // With few clusters, unrelated pale colours (e.g. pink buildings) can join the ground's
  // cluster. A pixel only counts if it is actually close to the cluster colour.
  const close = (i, c) => Math.hypot(rgb[i * 3] - c[0], rgb[i * 3 + 1] - c[1], rgb[i * 3 + 2] - c[2]) <= 32;
  km.centers.forEach((col, c) => {
    if (!usable[c]) return;
    masks.push({ name: `color${c}`, mask: clean(Uint8Array.from(labels, (l, i) => (l >= 0 && close(i, col) ? 1 : 0))), color: col.map(Math.round) });
  });
  // Paths are often drawn with shading, so one path can split into two similar colours.
  for (let i = 0; i < km.centers.length; i++) {
    for (let j = i + 1; j < km.centers.length; j++) {
      const [a, b] = [km.centers[i], km.centers[j]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 38) continue;
      if ((km.counts[i] + km.counts[j]) / n > 0.6) continue;
      masks.push({
        name: `color${i}+${j}`,
        mask: clean(Uint8Array.from(labels, (l, p) => (l >= 0 && (close(p, a) || close(p, b)) ? 1 : 0))),
        color: a.map(Math.round),
      });
    }
  }

  const cands = [];
  const add = (info, lines, tol, area, paths = []) => {
    if (lines.length + paths.length < 3 || lines.length + paths.length > 800) return;
    // Small breaks where centre-lines meet can split a network; keep its largest piece.
    const graph = largestNet(buildNetwork(lines.map(scale), paths.map(scaleP), tol * up), tol * up);
    if (roadCount(graph) < 3) return;
    const sc = scoreGraph(graph, objects, canvas.width, canvas.height, area);
    // Lines running over the page background (white margins around the map) are not paths.
    let onBg = 0, samples = 0;
    forEachSample(graph, 2, (sx, sy) => {
      const x = canvasToMask(sx, m.s, m.w);
      const y = canvasToMask(sy, m.s, m.h);
      samples++;
      if (bg.mask[y * m.w + x]) onBg++;
    });
    const bgFrac = samples ? onBg / samples : 0;
    // A walkway network lies either on the page colour (indoor plans: white corridors) or
    // off it (paths on a drawn ground) — not half on the page margin and half off.
    info.bgFrac = +bgFrac.toFixed(2);
    info.factor = (info.factor ?? 1) * (1 - 2 * Math.min(bgFrac, 1 - bgFrac));
    // Indoor-plan corridors ('bands') sit inside the plan. On illustrated maps the same method
    // traces page margins instead: measured 28–43% of its length in the outer 10% band there,
    // vs 4–9% on real floor plans.
    if (info.method === 'bands' && sc.edge > 0.15) info.factor *= 0.2;
    // Indoor corridors are one uniform colour under the whole line (measured ≥ 0.95 on the
    // floor plans); on illustrated maps the 'bands' lines cross many colours.
    if (info.method === 'bands') {
      const cols = [];
      forEachSample(graph, 2, (sx, sy) => {
        const x = canvasToMask(sx, m.s, m.w);
        const y = canvasToMask(sy, m.s, m.h);
        const i = (y * m.w + x) * 3;
        cols.push([rgb[i], rgb[i + 1], rgb[i + 2]]);
      });
      const ref = [0, 1, 2].map((k) => cols.map((c) => c[k]).sort((a, b) => a - b)[cols.length >> 1]);
      const uniform = cols.length ? cols.filter((c) => Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) <= 25).length / cols.length : 0;
      info.uniform = +uniform.toFixed(2);
      info.factor *= uniform ** 3;
    }
    // A colour hypothesis (e.g. anti-aliased road fringes) whose centre lines mostly run over
    // other colours is not the walkway (measured 0.57–0.80 on real winners, 0.26 on a fringe).
    if (info.method === 'skeleton' && info.color) {
      let own = 0, tot = 0;
      forEachSample(graph, 2, (sx, sy) => {
        const x = canvasToMask(sx, m.s, m.w);
        const y = canvasToMask(sy, m.s, m.h);
        const i = (y * m.w + x) * 3;
        tot++;
        if (Math.hypot(rgb[i] - info.color[0], rgb[i + 1] - info.color[1], rgb[i + 2] - info.color[2]) <= 32) own++;
      });
      info.own = tot ? +(own / tot).toFixed(2) : 0;
      if (tot) info.factor = (info.factor ?? 1) * ownFactor(own / tot);
    }
    // Paths and corridors are narrow; grass, plazas and page areas are wide.
    const f = info.factor ?? 1;
    cands.push({ ...info, graph, tol: tol * up, area, ...sc, score: sc.score * f, narrow: +f.toFixed(2) });
  };
  for (const M of masks) {
    if (M.bands) {
      // Indoor plans: white corridors between booths (the corridors may well be the
      // "background" colour here, so this hypothesis keeps them).
      const corr = corridorsFrom(m, texts);
      add({ name: M.name, R: 0, method: 'bands' }, corr.lines.map((L) => ({ ...L, c: L.c * m.s, range: L.range.map((v) => v * m.s) })), corr.tol * m.s, 0);
      continue;
    }
    // Trees, icons and characters drawn on a path/plaza punch small holes; fill them so the
    // centre line runs straight down the middle instead of zig-zagging around them.
    const holes = Math.round(n * 0.001);
    const base0 = clearBorder(fillSmallHoles(M.mask, m.w, m.h, holes, Math.max(3, Math.round(maxE * 0.008))), m.w, m.h, border);
    // Bridge small gaps (people, signs, icons drawn on top of a path) with a wider closing.
    const bridged = clearBorder(closing(M.mask, m.w, m.h, Math.max(2, Math.round(maxE * 0.008))), m.w, m.h, border);
    // Bg-like colour that is not connected to the edge (cut-off pieces of page background).
    const bgLike = M.color && bg.colors.some((c) => Math.hypot(c[0] - M.color[0], c[1] - M.color[1], c[2] - M.color[2]) <= 25);
    for (const [base, gap] of [[base0, 0], [bridged, 1]]) {
      // Path-likeness: share of the region that is narrow (survives removing wide areas).
      let all = 0, thin = 0;
      for (const v of base) all += v;
      for (const v of removeWide(base, m.w, m.h, Math.round(maxE * 0.025))) thin += v;
      const narrowFrac = all ? thin / all : 0;
      // (Variants that removed wide open areas were dropped: the page background is now
      // detected directly, and on campus maps the open ground is exactly where people walk.)
      for (const R of [0]) {
        let mk = R ? removeWide(base, m.w, m.h, R) : base;
        mk = keepLargestComponent(mk, m.w, m.h);
        let cnt = 0;
        for (const v of mk) cnt += v;
        const area = cnt / n;
        if (area < 0.01) continue;
        const sk = skeletonCorridors(mk, m.w, m.h);
        const factor = narrowFrac ** 2 * (gap ? 0.85 : 1) * (bgLike ? 0.3 : 1);
        add({ name: M.name + (gap ? '~' : ''), R, method: 'skeleton', color: M.color, factor, mask: mk, region: base, mw: m.w, mh: m.h }, sk.lines, 3, area, sk.paths); // join tolerance: 3 analysis pixels (tracing jitter)
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  let best = preferFuller(cands);

  // Recall first: a map usually has several walkable surfaces (roads + campus grounds +
  // footpaths). Join the best one with every other plausible walkable colour that touches it.
  if (best?.method === 'skeleton' && best.region) {
    const near = dilate(best.region, m.w, m.h, 2);
    const union = Uint8Array.from(best.region);
    const used = [best.name];
    const bestMed = regionMedian(best.region, rgb, n);
    const okMeds = [bestMed]; // colours of the joined surfaces
    const trace = (globalThis.__unionTrace = []);
    for (const c of cands) {
      if (c === best || c.method !== 'skeleton' || !c.region || c.name.endsWith('~')) continue;
      // plausible walkway (scores well) OR open ground: light and nearly colourless
      // (white roads, cream/beige/light-grey grounds). Buildings, fields and water are coloured or darker.
      // Colours are judged on the measured median of the region, not the cluster centre.
      const cm = regionMedian(c.region, rgb, n);
      if (!cm || !bestMed) continue;
      const openGround = Math.min(...cm) >= 220 && Math.max(...cm) - Math.min(...cm) <= 35;
      const shade = Math.hypot(cm[0] - bestMed[0], cm[1] - bestMed[1], cm[2] - bestMed[2]) <= 20;
      if ((!shade && !openGround) || used.includes(c.name)) { trace.push({ name: c.name, skipped: 'colour', cm }); continue; }
      // Admit the extra region block by block: narrow, bordering the main network, and
      // forming at least two lines of its own.
      const extra = Uint8Array.from(c.region, (v, i) => (v && !best.region[i] ? 1 : 0));
      const { label: el, comps: ec } = connectedComponents(extra, m.w, m.h);
      let admitted = 0;
      const rej = { small: 0, wide: 0, contact: 0, skel: 0 };
      for (const blk of ec.sort((p, q) => q.size - p.size).slice(0, 15)) {
        if (blk.size < Math.max(40, n * 0.0005)) { rej.small++; continue; }
        const bm = Uint8Array.from(el, (l) => (l === blk.id ? 1 : 0));
        let thin = 0;
        for (const v of removeWide(bm, m.w, m.h, Math.round(maxE * 0.025))) thin += v;
        if (thin / blk.size < 0.6) { rej.wide++; continue; }
        if (contactRatio(bm, near, m.w, m.h) < 0.15) { rej.contact++; continue; }
        const bsk = skeletonCorridors(bm, m.w, m.h);
        if (bsk.lines.length + bsk.paths.length < 2) { rej.skel++; continue; }
        for (let i = 0; i < n; i++) if (bm[i]) union[i] = 1;
        admitted++;
      }
      trace.push({ name: c.name, score: +c.score.toFixed(3), openGround, cm, admitted, blocks: ec.length, rej });
      if (admitted) { used.push(c.name); okMeds.push(cm); }
    }
    if (used.length > 1) {
      const mk = keepLargestComponent(clearBorder(fillSmallHoles(closing(union, m.w, m.h, 1), m.w, m.h, Math.round(n * 0.001), Math.max(3, Math.round(maxE * 0.008))), m.w, m.h, border), m.w, m.h);
      let cnt = 0;
      for (const v of mk) cnt += v;
      const before = cands.length;
      let ua = 0, ut = 0;
      for (const v of mk) ua += v;
      for (const v of removeWide(mk, m.w, m.h, Math.round(maxE * 0.025))) ut += v;
      const uNarrow = ua ? ut / ua : 0;
      const usk = skeletonCorridors(mk, m.w, m.h);
      add({ name: used.join('+'), R: 0, method: 'skeleton', color: best.color, factor: uNarrow ** 2, mask: mk, region: union, mw: m.w, mh: m.h, union: used }, usk.lines, 3, cnt / n, usk.paths);
      if (cands.length > before) {
        const u = cands[cands.length - 1];
        // keep the joined network unless it is clearly worse (e.g. spilled onto the page)
        trace.push({ union: u.name, lines: roadCount(u.graph), bestLines: roadCount(best.graph), edge: u.edge, bestEdge: best.edge });
        // (the page background is already excluded; the final gate still rejects edge-hugging results)
        // adopt only when it scores nearly as well as the single colour and its lines stay on
        // one ground colour (not on buildings or lawns)
        let same = 0, tot = 0;
        forEachSample(u.graph, 2, (sx, sy) => {
          const x = canvasToMask(sx, m.s, m.w);
          const y = canvasToMask(sy, m.s, m.h);
          const i = (y * m.w + x) * 3;
          tot++;
          if (okMeds.some((c) => Math.hypot(rgb[i] - c[0], rgb[i + 1] - c[1], rgb[i + 2] - c[2]) <= 25)) same++;
        });
        const sameFrac = tot ? same / tot : 0;
        trace[trace.length - 1].sameFrac = +sameFrac.toFixed(2);
        trace[trace.length - 1].uScore = +u.score.toFixed(3);
        trace[trace.length - 1].bestScore = +best.score.toFixed(3);
        // Recall first: a sparse winner (few lines) is replaced by a much fuller network that
        // still scores at least half as well.
        const fuller = roadCount(u.graph) >= 3 * roadCount(best.graph) && u.score >= 0.5 * best.score;
        if (roadCount(u.graph) >= roadCount(best.graph) && (u.score >= 0.9 * best.score || fuller) && sameFrac >= 0.8) best = u;
      }
    }
  }
  // Recall first: also trace the pieces the main network was cut off from, and link them in.
  if (best?.method === 'skeleton' && best.region) {
    // Text only hides what is under it: a road gap under any erased label (read or not) may be
    // bridged. Only for bridging gaps — the candidate masks and L links are unchanged.
    const textMask = boxesToMask(textBoxes, m);
    const unknownMask = Uint8Array.from(excluded, (v, i) => ((v && !bg.mask[i]) || textMask[i] ? 1 : 0));
    const linked = connectPieces(best.region, m, maxE, up, border, best.mask, unknownMask);
    if (linked) {
      const g = largestNet(buildNetwork(linked.lines, linked.paths, 3 * up), 3 * up);
      globalThis.__piecesTrace = { in: [linked.lines.length, linked.paths.length], out: [g.lines.length, g.paths.length], len: Math.round(roadLength(g)), bestLen: Math.round(roadLength(best.graph)) }; // devtools only
      if (roadLength(g) > roadLength(best.graph) * 1.05) best = { ...best, graph: g, name: best.name + '+pieces' };
    }
  }
  return { best, candidates: cands, background: { colors: bg.colors, ...bg.info }, bgMask: bg.mask, excluded, maskW: m.w, maskH: m.h, maskS: m.s };
}

// ---------- buildings (coloured blocks) ----------
/**
 * Buildings on a coloured map: solid blocks that are neither walkway nor page background.
 * Returned as boxes in canvas pixels.
 */
export function findBuildings(walk, bgMask, w, h, s, rgb = null) {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = !walk[i] && !bgMask[i] ? 1 : 0;
  const area = w * h;
  const keep = (c) => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    return c.size > area * 0.0012 && bw * bh < area * 0.08 && c.size / (bw * bh) > 0.45 && Math.min(bw, bh) >= 4;
  };
  const toBox = (c) => ({ x0: c.x0 / s, y0: c.y0 / s, x1: (c.x1 + 1) / s, y1: (c.y1 + 1) / s, open: false });
  if (!rgb) return connectedComponents(opening(solid, w, h, 1), w, h).comps.filter(keep).map(toBox);
  // Adjacent buildings usually have different fill colours: grow each region only into
  // pixels close to its seed colour, so 科學館 / 生活科技館 / 美術館 come out separately.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!solid[i] || label[i]) continue;
    const seed = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    const c = { size: 0, x0: w, y0: h, x1: 0, y1: 0 };
    const id = comps.push(c);
    let sp = 0;
    stack[sp++] = i;
    label[i] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      c.size++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
        if (q < 0 || q >= w * h || label[q] || !solid[q]) continue;
        if (Math.abs(rgb[q * 3] - seed[0]) + Math.abs(rgb[q * 3 + 1] - seed[1]) + Math.abs(rgb[q * 3 + 2] - seed[2]) > 45) continue;
        label[q] = id;
        stack[sp++] = q;
      }
    }
  }
  return comps.filter(keep).map(toBox);
}

/**
 * Cut a building out and turn "anything that is not the fill colour" into black ink on
 * white — works for white, red or dark text on any fill colour. Ink touching the crop edge
 * (the building's outline, neighbours) is dropped.
 */
export function inkCrop(canvas, b) {
  const src = canvas.source || canvas;
  const ss = canvas.sourceScale || 1;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const k = Math.max(1, Math.min(4, 160 / Math.max(1, Math.min(w, h)), 1800 / Math.max(w, h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, b.x0 * ss, b.y0 * ss, w * ss, h * ss, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data, W = c.width, H = c.height, n = W * H;
  const ch = [[], [], []];
  for (let i = 0; i < n; i += 7) { ch[0].push(d[i * 4]); ch[1].push(d[i * 4 + 1]); ch[2].push(d[i * 4 + 2]); }
  const fill = ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (Math.hypot(d[i * 4] - fill[0], d[i * 4 + 1] - fill[1], d[i * 4 + 2] - fill[2]) > 70) ink[i] = 1;
  }
  // drop long marks that touch the crop edge (building outlines, roads); characters that
  // merely spill over the edge are kept
  const { label: inkLabel, comps: inkComps } = connectedComponents(ink, W, H);
  const drop = new Set();
  for (const c of inkComps) {
    const touches = c.x0 === 0 || c.y0 === 0 || c.x1 === W - 1 || c.y1 === H - 1;
    if (touches && (c.x1 - c.x0 > W * 0.6 || c.y1 - c.y0 > H * 0.6)) drop.add(c.id);
  }
  if (drop.size) for (let i = 0; i < n; i++) if (drop.has(inkLabel[i])) ink[i] = 0;
  for (let i = 0; i < n; i++) {
    const v = ink[i] ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, ink, W, H };
}

/** Vertical label: cut into characters (by empty rows) and lay them out side by side. */
export function relayoutVertical(ic) {
  const { ink, W, H } = ic;
  const rowInk = new Array(H).fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rowInk[y] += ink[y * W + x];
  const chars = [];
  let s = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && rowInk[y] > 0;
    if (on && s < 0) s = y;
    if (!on && s >= 0) { if (y - s >= 3) chars.push([s, y]); s = -1; }
  }
  if (chars.length < 2) return null;
  // merge pieces of one character split by a thin gap (e.g. 二, 三)
  const hs = chars.map(([a, b]) => b - a).sort((a, b) => a - b);
  const typical = hs[hs.length >> 1];
  const merged = [];
  for (const cr of chars) {
    const last = merged[merged.length - 1];
    if (last && cr[1] - last[0] <= typical * 1.25 && (last[1] - last[0] < typical * 0.7 || cr[1] - cr[0] < typical * 0.7)) last[1] = cr[1];
    else merged.push([...cr]);
  }
  const cell = Math.max(...merged.map(([a, b]) => b - a), W);
  const pad = Math.round(cell * 0.3);
  const out = document.createElement('canvas');
  out.width = merged.length * (W + pad) + pad;
  out.height = cell + pad * 2;
  const g = out.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  merged.forEach(([a, b], i) => {
    g.drawImage(ic.canvas, 0, a, W, b - a, pad + i * (W + pad), pad + (cell - (b - a)) / 2, W, b - a);
  });
  return out;
}

/** Greyscale, contrast-stretched copy of a crop (dark text on light), at a given size. */
function grayCrop(canvas, box, W, H) {
  const src = canvas.source || canvas, ss = canvas.sourceScale || 1;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, box.x0 * ss, box.y0 * ss, (box.x1 - box.x0) * ss, (box.y1 - box.y0) * ss, 0, 0, W, H);
  const img = g.getImageData(0, 0, W, H), d = img.data;
  let lo = 255, hi = 0, sum = 0;
  const gv = new Float32Array(W * H);
  for (let i = 0; i < gv.length; i++) {
    const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    gv[i] = v; sum += v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const invert = sum / gv.length < (lo + hi) / 2;
  for (let i = 0; i < gv.length; i++) {
    let v = ((gv[i] - lo) * 255) / Math.max(1, hi - lo);
    if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Tidy a building reading: drop stray one-character fragments and symbols that a padded
 * crop picks up from neighbours ("1 | L 排球場" → "排球場", "日 3 網球場上 4 可" → "網球場上").
 */
export function tidyReading(name) {
  const tokens = name.split(/\s+/).filter(Boolean);
  const keep = tokens.filter((t) => t.replace(/[\p{P}\p{S}]/gu, '').length >= 2);
  return keep.length ? joinLines(keep) : '';
}

/**
 * Read one building thoroughly: the tight crop and a padded crop (labels often spill past
 * the outline), each as contrast-stretched greyscale and as black-on-white ink; tall
 * buildings also as a vertical label re-laid side by side. Keep the most confident reading.
 */
export async function ocrBuilding(worker, canvas, b) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const pad = 0.2 * Math.min(w, h);
  const padded = { x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(canvas.width, b.x1 + pad), y1: Math.min(canvas.height, b.y1 + pad) };
  const reads = [];
  const read = async (c, psm, tight) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(c);
    const lines = data.text.split('\n').map(cleanText).filter((t) => t && meaningful(t));
    const name = tidyReading(joinLines(lines));
    const letters = name.replace(/[\s\p{P}\p{S}]/gu, '');
    // at least two real characters, and not mostly line-art read as 一 / 二 / 丨
    const strokes = (letters.match(/[一二三丨|lI]/g) || []).length;
    if (letters.length >= 2 && strokes / letters.length < 0.5) {
      // small preference for the tight crop: it cannot contain a neighbour's label
      reads.push({ name, conf: data.confidence + (tight ? 3 : 0) });
    }
  };
  let anyInk = false;
  for (const [box, tight] of [[b, true], [padded, false]]) {
    const ic = inkCrop(canvas, box);
    let inkCount = 0;
    for (const v of ic.ink) inkCount += v;
    if (inkCount < ic.W * ic.H * 0.005) continue; // no text here
    anyInk = true;
    const gray = grayCrop(canvas, box, ic.W, ic.H);
    if (h < w * 1.6) {
      await read(gray, Tesseract.PSM.SINGLE_BLOCK, tight);
      await read(ic.canvas, Tesseract.PSM.SINGLE_BLOCK, tight);
    }
    if (h > w * 1.2) {
      const v = relayoutVertical(ic);
      if (v) await read(v, Tesseract.PSM.SINGLE_LINE, tight);
      await read(gray, Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT, tight);
    }
  }
  if (!anyInk) return null;
  reads.sort((p, q) => q.conf - p.conf);
  return reads[0] || null;
}

// ---------- building names, line by line (1-A4) ----------
/**
 * Read one label line enlarged to a fixed letter height (Tesseract reads ~12 px names badly):
 * the roof becomes white, red dashes and blue signs are removed, the text keeps its soft edges.
 */
async function readLabelLine(worker, canvas, L, letter) {
  const src = canvas.source || canvas, ss = canvas.sourceScale || 1;
  const w = L.x1 - L.x0, h = L.y1 - L.y0, k = letter / h, m = Math.round(h * 0.6);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((w + 2 * m) * k));
  c.height = Math.max(1, Math.round((h + 2 * m) * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (L.x0 - 1) * ss, (L.y0 - 1) * ss, (w + 2) * ss, (h + 2) * ss, (m - 1) * k, (m - 1) * k, (w + 2) * k, (h + 2) * k);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  const span = Math.max(1, L.ref - 15 - 70);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gr = d[i + 1], b = d[i + 2];
    const v = r - Math.max(gr, b) > 40 || b - r > 50 ? 255 : Math.max(0, Math.min(255, (((r + gr + b) / 3 - 70) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
  const { data } = await worker.recognize(c);
  return { name: cleanText(data.text), conf: data.confidence };
}

/**
 * Re-read each building's name from its own label lines (found inside its outline) and use it
 * when it is clearly better than the name given from the page pass: there was none, the old one
 * is not a building-like name, or a confident reading ends like a building (…館, …樓) and the
 * page pass gave the building a neighbour's label. Of several labels on one roof, a building-like
 * one wins over a place name. A name read here wins over the same name
 * given to another building from the page pass. Mutates buildings[].name.
 */
export async function readBuildingNames(worker, canvas, buildings, onProgress) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const list = buildings.slice(0, 30);
  const labels = labelsFor(img, list);
  const cjk = (t) => /[\u3400-\u9fff]/.test(t);
  // a few letter sizes until one reads clearly (Tesseract is fickle at this size); Chinese first
  const readLine = async (L) => {
    let best = null;
    for (const letter of [36, 48, 28, 42]) {
      const r = await readLabelLine(worker, canvas, L, letter);
      if (!best || (cjk(r.name) && !cjk(best.name)) || (cjk(r.name) === cjk(best.name) && r.conf > best.conf)) best = r;
      if (best.conf >= 70 && cjk(best.name)) break;
    }
    return best;
  };
  // share of characters two names have in common (the page pass and this one agreeing on a roof)
  const alike = (p, q) => { const a = [...(p || '')], b = new Set(q || ''); return a.length ? a.filter((ch) => b.has(ch)).length / Math.max(a.length, b.size) : 0; };
  const read = new Set(), splits = [];
  for (let i = 0; i < list.length; i++) {
    onProgress?.({ status: `讀建築名稱 ${i + 1}/${list.length}`, progress: (i + 1) / list.length });
    const b = list[i];
    const found = [], dbg = [];
    for (const group of labels[i].slice(0, 3)) {
      const parts = [], confs = [];
      for (const L of group.slice(0, 3)) {
        const r = await readLine(L);
        dbg.push([r.name, Math.round(r.conf), L.x0, L.y0, L.x1, L.y1]);
        if (r.conf >= 40 && cjk(r.name)) { parts.push(r.name); confs.push(r.conf); }
      }
      if (!parts.length) continue;
      const name = correctName(joinLines(parts));
      const conf = confs.reduce((s, v) => s + v, 0) / confs.length;
      const used = group.slice(0, 3), cx = used.reduce((t, L) => t + (L.x0 + L.x1) / 2, 0) / used.length, cy = used.reduce((t, L) => t + (L.y0 + L.y1) / 2, 0) / used.length;
      if ((name.match(/[\u3400-\u9fff]/g) || []).length >= 2 && conf >= 55) found.push({ name, conf, cx, cy });
    }
    if (globalThis.__photopathDebug) (globalThis.__photopathDebug.names ||= []).push({ old: b.name, dbg }); // regression page only
    if (!found.length) continue;
    // two building names on one roof (two buildings drawn as one shape): cut it apart after this pass
    const two = found.filter((f) => BUILDING_END.test(f.name));
    if (two.length >= 2) splits.push({ b, names: two });
    // a building-like name (…館, …樓) before a place name on the same roof, then one the page pass
    // also read there, then the clearer reading
    found.sort((p, q) => BUILDING_END.test(q.name) - BUILDING_END.test(p.name) || (alike(q.name, b.name) >= 0.5) - (alike(p.name, b.name) >= 0.5) || q.conf - p.conf);
    const { name, conf } = found[0];
    if (name === b.name) { read.add(b); continue; }
    const better = !b.name || !BUILDING_WORDS.test(b.name) || (conf >= 70 && BUILDING_END.test(name));
    if (!better) continue;
    b.name = name;
    read.add(b);
  }
  for (const { b, names } of splits) {
    const parts = splitAtNames(buildings, b, names);
    if (parts) { read.delete(b); for (const o of parts) read.add(o); }
  }
  for (const b of read) for (const o of buildings) if (o !== b && !read.has(o) && o.name === b.name) o.name = '';
}

// ---------- labels written on the ground ----------
/**
 * Find text written directly on the walkway/ground colour: character-sized marks chained
 * into horizontal or vertical lines. Returns [{box, chars:[box], vertical}] in canvas px.
 */
export function findGroundText(canvas, groundColor, maxEdge = 1200) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const n = w * h;
  const ground = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ground[i] = Math.hypot(d[i * 4] - groundColor[0], d[i * 4 + 1] - groundColor[1], d[i * 4 + 2] - groundColor[2]) <= 40 ? 1 : 0;
  }
  // Marks = non-ground pixels; dilate a little so the strokes of one character join up.
  // Non-ground pixels include buildings and the page; keep only small blobs (character
  // strokes), then join strokes into characters with a small dilation.
  const raw = Uint8Array.from(ground, (v) => 1 - v);
  const rawC = connectedComponents(raw, w, h);
  const bigLimit = Math.max(400, n * 0.0015);
  const small = Uint8Array.from(rawC.label, (l) => (l && rawC.comps[l - 1].size <= bigLimit && (rawC.comps[l - 1].x1 - rawC.comps[l - 1].x0) < 90 && (rawC.comps[l - 1].y1 - rawC.comps[l - 1].y0) < 90 ? 1 : 0));
  const marks = dilate(small, w, h, 2);
  const { label, comps } = connectedComponents(marks, w, h);
  const area = n;
  // A character sits on the ground: most of the ring just outside its box is ground.
  const onGround = (cmp) => {
    let tot = 0, gr = 0;
    for (let x = cmp.x0 - 2; x <= cmp.x1 + 2; x += 2) for (const y of [cmp.y0 - 3, cmp.y1 + 3]) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      tot++; gr += ground[y * w + x];
    }
    for (let y = cmp.y0 - 2; y <= cmp.y1 + 2; y += 2) for (const x of [cmp.x0 - 3, cmp.x1 + 3]) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      tot++; gr += ground[y * w + x];
    }
    return tot && gr / tot > 0.35; // labels often sit right against their building
  };
  const marksOk = comps.filter((cmp) => {
    const bw = cmp.x1 - cmp.x0 + 1, bh = cmp.y1 - cmp.y0 + 1;
    return Math.min(bw, bh) >= 8 && Math.min(bw, bh) <= 70 && Math.max(bw, bh) <= 600 &&
      cmp.size / (bw * bh) > 0.15 && cmp.size < area * 0.004 && onGround(cmp);
  }).map((cmp) => ({ x0: cmp.x0, y0: cmp.y0, x1: cmp.x1 + 1, y1: cmp.y1 + 1 }));
  // Square-ish marks are single characters (chained below); long marks are whole lines
  // whose characters already touch.
  const isLong = (b) => Math.max(b.x1 - b.x0, b.y1 - b.y0) / Math.min(b.x1 - b.x0, b.y1 - b.y0) >= 1.8;
  const chars = marksOk.filter((b) => !isLong(b));
  const longLines = marksOk.filter(isLong);

  // Chain characters into lines.
  const used = new Set();
  const lines = [];
  const size = (b) => Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const cx = (b) => (b.x0 + b.x1) / 2, cy = (b) => (b.y0 + b.y1) / 2;
  for (const vertical of [false, true]) {
    for (const start of [...chars].sort((a, b) => (vertical ? a.y0 - b.y0 : a.x0 - b.x0))) {
      if (used.has(start)) continue;
      const line = [start];
      let cur = start;
      for (;;) {
        const sz = size(cur);
        const next = chars.filter((o) => !used.has(o) && !line.includes(o)).filter((o) => {
          const sz2 = size(o);
          if (sz2 > sz * 2 || sz > sz2 * 2) return false;
          return vertical
            ? Math.abs(cx(o) - cx(cur)) < sz * 0.35 && o.y0 > cur.y0 && o.y0 - cur.y1 < sz * 1.1
            : Math.abs(cy(o) - cy(cur)) < sz * 0.35 && o.x0 > cur.x0 && o.x0 - cur.x1 < sz * 1.1;
        }).sort((a, b) => (vertical ? a.y0 - b.y0 : a.x0 - b.x0))[0];
        if (!next) break;
        line.push(next);
        cur = next;
      }
      if (line.length < 2) continue;
      line.forEach((o) => used.add(o));
      const box = {
        x0: Math.min(...line.map((o) => o.x0)), y0: Math.min(...line.map((o) => o.y0)),
        x1: Math.max(...line.map((o) => o.x1)), y1: Math.max(...line.map((o) => o.y1)),
      };
      const sc = (b) => ({ x0: b.x0 / s, y0: b.y0 / s, x1: b.x1 / s, y1: b.y1 / s });
      lines.push({ box: sc(box), chars: line.map(sc), vertical });
    }
  }
  const sc = (b) => ({ x0: b.x0 / s, y0: b.y0 / s, x1: b.x1 / s, y1: b.y1 / s });
  for (const b of longLines) lines.push({ box: sc(b), chars: [sc(b)], vertical: b.y1 - b.y0 > b.x1 - b.x0 });
  // Unchained blobs that are clearly bigger than a typical character may be a whole label
  // merged with a nearby mark: worth one reading (single-character results are dropped later).
  const sizes = chars.map(size).sort((a, b) => a - b);
  const typical = sizes.length ? sizes[sizes.length >> 1] : 20;
  for (const b of chars) {
    if (used.has(b) || size(b) < typical * 1.8) continue;
    lines.push({ box: sc(b), chars: [sc(b)], vertical: b.y1 - b.y0 > (b.x1 - b.x0) * 1.15 });
  }
  return lines;
}

/** Read one ground label: ink = anything not ground; vertical lines re-laid side by side. */
export async function ocrGroundLine(worker, canvas, line, groundColor) {
  const src = canvas.source || canvas;
  const ss = canvas.sourceScale || 1;
  const bx = line.box;
  const short = Math.min(bx.x1 - bx.x0, bx.y1 - bx.y0);
  const pad = short * 0.15;
  const box = { x0: Math.max(0, bx.x0 - pad), y0: Math.max(0, bx.y0 - pad), x1: Math.min(canvas.width, bx.x1 + pad), y1: Math.min(canvas.height, bx.y1 + pad) };
  const k = Math.max(1, Math.min(4, 56 / Math.max(1, short)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((box.x1 - box.x0) * k));
  c.height = Math.max(1, Math.round((box.y1 - box.y0) * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, box.x0 * ss, box.y0 * ss, (box.x1 - box.x0) * ss, (box.y1 - box.y0) * ss, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data, W = c.width, H = c.height;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    ink[i] = Math.hypot(d[i * 4] - groundColor[0], d[i * 4 + 1] - groundColor[1], d[i * 4 + 2] - groundColor[2]) > 50 ? 1 : 0;
    const v = ink[i] ? 0 : 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  let input = c;
  if (line.vertical) input = relayoutVertical({ canvas: c, ink, W, H }) || c;
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
  const { data } = await worker.recognize(input);
  const name = cleanText(data.text.replace(/\n/g, ' '));
  return name && meaningful(name) ? { name, conf: data.confidence } : null;
}

/**
 * Full automatic pipeline:
 * 1. quality  2. find enclosed rooms/booths  3. OCR each room → named object
 * 4. sparse OCR of the page for labels in open space, merged into multi-line labels
 * 5. corridors: best of several walkable-area hypotheses  6. anchors  7. gate
 */
export async function recognize(canvas, onProgress) {
  const quality = checkQuality(canvas);
  const m = lightMask(canvas, MASK_EDGE);
  const rooms = findRooms(m);
  const objects = [];
  let texts = [];
  let boxes = [];
  let title = null;
  let ocrError = null;

  try {
    const worker = await getWorker(onProgress);
    ({ texts, boxes } = await ocrPage(worker, canvas));
    ({ texts, boxes } = await ocrTiles(worker, canvas, texts, boxes, onProgress));
    await refineTexts(worker, canvas, texts, onProgress);
    for (let i = 0; i < rooms.length; i++) {
      onProgress?.({ status: `辨識物件 ${i + 1}/${rooms.length}`, progress: (i + 1) / rooms.length });
      const r = await ocrRegion(worker, canvas, rooms[i]);
      if (r.name && r.conf >= 50) objects.push({ name: correctName(r.name), conf: r.conf, box: rooms[i] });
    }
  } catch (e) {
    ocrError = e;
  }
  for (const t of texts) t.name = correctName(t.name);

  // Labels in open space (not inside a booth): merge stacked lines, drop junk.
  // Open-space text has no booth outline to confirm it, so require higher confidence.
  const outside = mergeStacked(
    texts.filter((t) => {
      if (rooms.some((r) => inside(r, centre(t.bbox).x, centre(t.bbox).y))) return false;
      const letters = t.name.replace(/\s/g, '');
      return t.conf >= 60 && (letters.length >= 2 || isSingleCJK(letters));
    })
  );
  const heights = outside.map((t) => t.lh).sort((a, b) => a - b);
  const medianH = heights[heights.length >> 1] || 0;

  // Title: the tallest label near the top, clearly larger than ordinary labels.
  const titleLike = (t) => t.name.replace(/\s/g, '').length >= 3;
  const top = outside
    .filter((t) => titleLike(t) && t.bbox.y0 < canvas.height * 0.3 && t.lh >= 1.8 * medianH)
    .sort((a, b) => b.lh - a.lh)[0] ||
    outside.filter((t) => titleLike(t) && t.bbox.y1 < canvas.height * 0.12).sort((a, b) => b.lh - a.lh)[0];
  if (top) title = top.name;

  // Legend box ("圖例"): its sample entries are not real places.
  const legend = outside.find((t) => LEGEND_WORDS.test(t.name));
  const inLegend = (t) => {
    if (!legend) return false;
    const lw = legend.bbox.x1 - legend.bbox.x0;
    const c = centre(t.bbox);
    return c.x > legend.bbox.x0 - 2.5 * lw && c.x < legend.bbox.x1 + 2.5 * lw &&
      c.y > legend.bbox.y0 && c.y < legend.bbox.y1 + canvas.height * 0.3;
  };

  for (const t of outside) {
    if (t === top || t === legend || inLegend(t)) continue;
    if (top && t.lh >= 1.4 * medianH && t.bbox.y0 < canvas.height * 0.4 &&
        Math.abs(centre(t.bbox).x - centre(top.bbox).x) < (top.bbox.x1 - top.bbox.x0)) continue; // rest of title block
    if (t.name.replace(/\s/g, '').length < 2) continue; // lone characters that did not join a label
    const here = HERE_WORDS.test(t.name);
    if (here && objects.some((o) => o.here)) continue; // "您在這裡" + "YOU ARE HERE"
    const name = here ? '您在這裡（地圖標示）' : t.name.replace(/\s*[。、，,.·•]+(\s*[。、，,.·•]+)*\s*/g, ' ').trim();
    objects.push({ name, conf: t.conf, box: { ...t.bbox, open: true }, ...(here ? { here } : {}) });
  }

  const finalObjects = objects.map((o, i) => ({
    id: `P${i + 1}`, ...o, cx: centre(o.box).x, cy: centre(o.box).y,
  }));
  onProgress?.({ status: '分析走道', progress: 1 });
  // Look for paths on a copy of the map with all text erased (labels break roads apart).
  const erased = boxes.length ? eraseText(canvas, boxes) : { canvas, unknown: [] };
  const clean = erased.canvas;
  // the labels eraseText actually erased (it skips illustration-sized boxes): gaps under them may be bridged
  const erasedBoxes = boxes.filter((b) => b.y1 - b.y0 <= canvas.height * 0.08 && b.x1 - b.x0 <= canvas.width * 0.4);
  const corr = bestCorridors(clean, lightMask(clean, MASK_EDGE), [], finalObjects, erased.unknown, canvas, erasedBoxes);
  const { best, candidates, background } = corr;
  globalThis.__photopathDebug = { candidates, clean, corr, objects: finalObjects.slice(), unknown: erased.unknown, boxes: erasedBoxes }; // devtools / regression page only (objects as the walkway search saw them)
  const graph = best ? { paths: [], ...best.graph } : { lines: [], paths: [], nodes: [], edges: [] };
  const tol = best ? best.tol : 20;

  // Coloured maps: labels written directly on the ground (e.g. 懷恩樓 next to its building).
  if (best?.color && !ocrError) {
    try {
      const worker = await getWorker(onProgress);
      const lines = findGroundText(canvas, best.color).slice(0, 40);
      for (let i = 0; i < lines.length; i++) {
        onProgress?.({ status: `辨識地面文字 ${i + 1}/${lines.length}`, progress: (i + 1) / lines.length });
        const ln = lines[i];
        const b = ln.box;
        // already read well by the page pass?
        const dupe = finalObjects.find((o) => iou(o.box, b) > 0.3);
        if (dupe && dupe.conf >= 80) continue;
        const rd = await ocrGroundLine(worker, canvas, ln, best.color);
        if (!rd || rd.conf < 60 || rd.name.replace(/\s/g, '').length < 2) continue;
        if (dupe) { if (rd.conf <= dupe.conf) continue; finalObjects.splice(finalObjects.indexOf(dupe), 1); }
        finalObjects.push({ id: `G${i + 1}`, name: correctName(rd.name), conf: rd.conf, box: { ...b, open: true }, cx: centre(b).x, cy: centre(b).y });
      }
    } catch (e) {
      ocrError = e;
    }
  }

  // Coloured maps: read the names inside buildings (blocks that are not walkway/background).
  if (best?.mask && !ocrError) {
    const buildings = findBuildings(best.region || best.mask, corr.bgMask, corr.maskW, corr.maskH, corr.maskS, rgbData(canvas, MASK_EDGE).rgb)
      .filter((b) => !finalObjects.some((o) => !o.box.open && iou(o.box, b) > 0.5))
      .slice(0, 40);
    try {
      const worker = await getWorker(onProgress);
      for (let i = 0; i < buildings.length; i++) {
        onProgress?.({ status: `辨識建築物 ${i + 1}/${buildings.length}`, progress: (i + 1) / buildings.length });
        const b = buildings[i];
        const rd = await ocrBuilding(worker, canvas, b);
        if (!rd || rd.conf < 50) continue;
        // drop open-space readings of the same label inside this building
        for (let k = finalObjects.length - 1; k >= 0; k--) {
          const o = finalObjects[k];
          if (o.box.open && inside(b, o.cx, o.cy)) finalObjects.splice(k, 1);
        }
        finalObjects.push({ id: `B${i + 1}`, name: correctName(rd.name), conf: rd.conf, box: b, cx: centre(b).x, cy: centre(b).y });
      }
    } catch (e) {
      ocrError = e;
    }
  }

  // Only objects close to a corridor make good anchors (legend/title/decor are far away).
  const near = 0.06 * Math.max(canvas.width, canvas.height);
  const anchorPool = roadCount(graph)
    ? finalObjects.filter((o) => distToGraph(graph, o) < near)
    : finalObjects;
  const result = evaluate(graph, finalObjects, pickAnchors(anchorPool, 8, 0.08 * Math.max(canvas.width, canvas.height)), { w: canvas.width, h: canvas.height });
  // 1-A4: buildings (doors = destinations), water and the site; everything else inside the site is walkable
  let site = { buildings: [], water: [], boundary: null };
  try {
    const roads = [
      ...graph.lines.map((L) => (isH(L) ? [{ x: L.range[0], y: L.c }, { x: L.range[1], y: L.c }] : [{ x: L.c, y: L.range[0] }, { x: L.c, y: L.range[1] }])),
      ...(graph.paths || []).map((P) => P.points),
    ];
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    site = extractMap(img, { roads, texts: finalObjects.map((o) => ({ name: o.name, cx: o.cx, cy: o.cy, conf: o.conf })), labels: erasedBoxes, debug: globalThis.__photopathDebug ? (globalThis.__photopathDebug.site = {}) : null });
  } catch (e) {
    console.warn('building extraction failed', e);
  }
  // names on street-style maps are small: read each building's own label lines enlarged
  if (site.buildings.length && !ocrError) {
    try {
      await readBuildingNames(await getWorker(onProgress), canvas, site.buildings, onProgress);
    } catch (e) {
      console.warn('building names failed', e);
    }
  }
  return {
    buildings: site.buildings, water: site.water, boundary: site.boundary,
    quality, texts, rooms, title, objects: finalObjects, graph, tol, ocrError,
    background,
    walkable: best && { name: best.name, method: best.method, R: best.R, color: best.color, score: best.score },
    candidates: candidates.map((c) => ({ name: c.name, color: c.color, method: c.method, R: c.R, lines: roadCount(c.graph), score: +c.score.toFixed(3), span: c.span, fit: c.fit, smooth: c.smooth, edge: c.edge, narrow: c.narrow })),
    ...result,
  };
}
