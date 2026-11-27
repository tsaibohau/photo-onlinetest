// Reading the OSM map image itself (used when the Overpass servers cannot be reached):
// areas come from the fixed colours of the standard OSM map style, names from OCR of the map's
// labels. Pure functions on RGBA image data, except readTileMap (needs Tesseract and a canvas).
import { traceOutline } from './trace.js';
import { dilate } from './paths.js';
import { correctName } from './recognize.js';

// OSM Carto fill colours → obstacle kind (the map is drawn tile for tile, so colours are exact)
const PALETTE = [
  ['building', ['d9d0c9', 'd8cfc8']],
  ['water', ['aad3df']],
  ['trees', ['add19e', 'c8d7ab']],
  ['grass', ['cdebb0', 'c8facc', '88e0be', 'dffce2']],
];
const ROAD = ['ffffff', 'fefefe', 'f7fabf', 'fcd6a4', 'f9b29c', 'e892a2', 'dddde8'];
const hex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const COLORS = PALETTE.flatMap(([, list], k) => list.map((h) => [k, ...hex(h)]));
const ROAD_RGB = ROAD.map(hex);
const OUTLINE = hex('c4b6ab'); // the darker line drawn round every building
const BUILDING = PALETTE.findIndex(([k]) => k === 'building');
const near = (d, i, c, tol) => Math.abs(d[i] - c[0]) <= tol && Math.abs(d[i + 1] - c[1]) <= tol && Math.abs(d[i + 2] - c[2]) <= tol;

/**
 * Areas of the map by colour: { areas: [{ id, kind, points (pixel corners), box, count }],
 * region: Int32Array (area id per pixel, 0 = none) }. Areas under minPx pixels are dropped.
 * bridge: footways and labels drawn over a building cut its colour; gaps up to this many pixels
 * between building pixels are filled, unless a building outline runs through them (two buildings).
 */
export function segmentAreas(img, minPx = 50, bridge = 0) {
  const { data: d, width: w, height: h } = img;
  const cls = new Int8Array(w * h).fill(-1);
  for (let p = 0; p < w * h; p++) {
    for (const [k, r, g, b] of COLORS) if (near(d, p * 4, [r, g, b], 3)) { cls[p] = k; break; }
  }
  if (bridge > 0) bridgeGaps(d, cls, w, h, bridge);
  const region = new Int32Array(w * h);
  const areas = [];
  const queue = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (cls[s] < 0 || region[s]) continue;
    const id = areas.length + 1, k = cls[s];
    let head = 0, tail = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    queue[tail++] = s;
    region[s] = id;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n >= 0 && !region[n] && cls[n] === k) { region[n] = id; queue[tail++] = n; }
      }
    }
    areas.push({ id, kind: PALETTE[k][0], count: tail, box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, points: null });
  }
  for (const a of areas) {
    if (a.count < minPx) continue;
    const { x0, y0, x1, y1 } = a.box, bw = x1 - x0, bh = y1 - y0;
    const m = new Uint8Array(bw * bh);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (region[y * w + x] === a.id) m[(y - y0) * bw + (x - x0)] = 1;
    a.points = traceOutline(m, bw, bh).map((q) => ({ x: q.x + x0, y: q.y + y0 }));
  }
  return { areas: areas.filter((a) => a.points?.length >= 3), region };
}

/** Fill short runs of unclassified pixels between building pixels (rows and columns). */
function bridgeGaps(d, cls, w, h, max) {
  const fill = new Uint8Array(w * h);
  const scan = (n, len, at) => { // one row or column: at(i) → pixel index
    let last = -1; // index along the line of the last building pixel
    for (let i = 0; i < len; i++) {
      const p = at(i);
      if (cls[p] === BUILDING) {
        if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= max) {
          let ok = true;
          for (let j = last + 1; j < i && ok; j++) { const q = at(j); ok = cls[q] < 0 && !near(d, q * 4, OUTLINE, 6); }
          if (ok) for (let j = last + 1; j < i; j++) fill[at(j)] = 1;
        }
        last = i;
      }
    }
  };
  for (let y = 0; y < h; y++) scan(y, w, (i) => y * w + i);
  for (let x = 0; x < w; x++) scan(x, h, (i) => i * w + x);
  for (let p = 0; p < w * h; p++) if (fill[p]) cls[p] = BUILDING;
}

/** Boxes of map labels: dark grey text pixels, letters a few pixels apart joined into one box. */
export function findLabels(img, gap = 2) {
  const { data: d, width: w, height: h } = img;
  const ink = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] < 160 && mx - mn < 50) ink[p] = 1;
  }
  const grown = dilate(ink, w, h, gap);
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h), boxes = [];
  for (let s = 0; s < w * h; s++) {
    if (!grown[s] || seen[s]) continue;
    let head = 0, tail = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i / w) | 0;
      if (ink[i]) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (const q of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (q >= 0 && grown[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (n >= 12 && bh >= 6 && bh <= 40 && bw >= 6 && bw <= 400) boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return mergeStacked(boxes);
}

/** A label written on two lines ("生活科" over "技館") becomes one box with lines: 2. */
function mergeStacked(boxes) {
  const out = boxes.map((b) => ({ ...b, lines: 1 }));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = 0; j < out.length && !merged; j++) {
        const a = out[i], b = out[j];
        if (i === j || b.y0 < a.y1 || b.y0 - a.y1 > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.8) continue;
        const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        if (ov < Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5) continue;
        out[i] = { x0: Math.min(a.x0, b.x0), y0: a.y0, x1: Math.max(a.x1, b.x1), y1: b.y1, lines: a.lines + b.lines };
        out.splice(j, 1);
        merged = true;
      }
    }
  }
  return out;
}

/** OCR text of a label → a usable name ('' when it is noise). */
export function cleanLabel(t = '') {
  const s = t.replace(/[^㐀-鿿A-Za-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (/^[一二三丨-]*$/.test(s)) return '';
  const cjk = (s.match(/[㐀-鿿]/g) || []).length;
  if (!(cjk >= 2 || (!cjk && s.length >= 3))) return '';
  return correctName(s).replace(/[飾鏗]$/, '館'); // 館 is often read as 飾 / 鏗 on the small map labels
}

/** What most pixels just around box b are: an area ({ id }) or a road ({ road: true }). */
function surroundings(img, region, b) {
  const { data: d, width: w, height: h } = img;
  const votes = new Map();
  let road = 0, total = 0;
  const x0 = Math.max(0, b.x0 - 4), y0 = Math.max(0, b.y0 - 4), x1 = Math.min(w, b.x1 + 4), y1 = Math.min(h, b.y1 + 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) continue; // only the ring around the text
      const p = y * w + x;
      total++;
      if (region[p]) votes.set(region[p], (votes.get(region[p]) || 0) + 1);
      else if (ROAD_RGB.some((c) => near(d, p * 4, c, 2))) road++;
    }
  }
  const [id, n] = [...votes].sort((a, c) => c[1] - a[1])[0] || [0, 0];
  if (n >= road && n > total * 0.15) return { id }; // labels often overhang their building
  return { road: road > total * 0.3 };
}

/**
 * Areas and named labels → the same { areas, nodes, ways } (metres; mpp metres per pixel) the
 * OSM data gives. Every label that is not a road name becomes something:
 *  1. on an area: it names that area (the surest reading wins; another one becomes a landmark);
 *  2. just outside an unnamed building (a few metres): it names that building;
 *  3. on a small closed patch of one colour: that patch becomes a named area, marked guess: true;
 *  4. otherwise (open land, a patch too big or too odd): a landmark (anchor suggestion).
 */
export function tileMapData(img, seg, labels, mpp, minConf = 35) {
  const names = new Map(); // area id → { text, conf }
  const nodes = [];
  const extra = []; // areas made from labels (rule 3)
  const mark = (l, text) => nodes.push({ type: 'landmark', name: text, label: text, conf: l.conf, x: ((l.x0 + l.x1) / 2) * mpp, y: ((l.y0 + l.y1) / 2) * mpp });
  const byId = new Map(seg.areas.map((x) => [x.id, x]));
  const read = labels.map((l) => ({ l, text: cleanLabel(l.text) }))
    .filter(({ l, text }) => text && (l.conf ?? 0) >= minConf)
    .sort((p, q) => (q.l.conf ?? 0) - (p.l.conf ?? 0)); // surest first: it gets the building
  const loose = [];
  for (const { l, text } of read) {
    const s = surroundings(img, seg.region, l);
    if (s.id) {
      const prev = names.get(s.id);
      if (!prev) names.set(s.id, { text, conf: l.conf });
      else if (prev.text !== text) mark(l, text);
    } else if (!s.road) loose.push({ l, text });
  }
  for (const { l, text } of loose) {
    const id = nearBuilding(seg.region, img.width, byId, names, l, Math.round(4 / mpp));
    if (id) { names.set(id, { text, conf: l.conf }); continue; }
    const patch = patchAt(img, seg.region, l, Math.max(20, 25 / (mpp * mpp)), Math.min(2500 / (mpp * mpp), (img.width * img.height) / 4));
    if (patch) extra.push({ kind: 'other', name: text, conf: l.conf, guess: true, count: patch.count, points: patch.points.map((q) => ({ x: q.x * mpp, y: q.y * mpp })) });
    else mark(l, text);
  }
  const areas = seg.areas.map((a) => ({
    kind: a.kind,
    name: names.get(a.id)?.text || '',
    ...(names.has(a.id) ? { conf: names.get(a.id).conf } : {}),
    points: a.points.map((q) => ({ x: q.x * mpp, y: q.y * mpp })),
  }));
  // named ones first (guesses after), then the biggest, so the review list starts with what matters
  const size = new Map(areas.map((x, i) => [x, seg.areas[i].count]));
  for (const x of extra) { const { count, ...rest } = x; areas.push(rest); size.set(rest, count); }
  const rank = (x) => (x.name ? (x.guess ? 1 : 2) : 0);
  areas.sort((p, q) => rank(q) - rank(p) || size.get(q) - size.get(p));
  return { areas, nodes, ways: [] };
}

/** The unnamed building area nearest to label box l, within r pixels (0 when none). */
function nearBuilding(region, w, byId, names, l, r) {
  const h = region.length / w;
  let best = 0, bd = Infinity;
  for (let y = Math.max(0, l.y0 - r); y < Math.min(h, l.y1 + r); y++) {
    for (let x = Math.max(0, l.x0 - r); x < Math.min(w, l.x1 + r); x++) {
      const id = region[y * w + x];
      if (!id || names.has(id) || byId.get(id)?.kind !== 'building') continue;
      const d = Math.hypot(Math.max(l.x0 - x, 0, x - l.x1 + 1), Math.max(l.y0 - y, 0, y - l.y1 + 1));
      if (d <= r && d < bd) { bd = d; best = id; }
    }
  }
  return best;
}

/**
 * The closed patch of one colour a label sits on: { count, points } in pixels, or null when the
 * colour runs off the map, the patch is under minPx or over maxPx, or it is a road colour.
 */
function patchAt(img, region, l, minPx, maxPx) {
  const { data: d, width: w, height: h } = img;
  const inBox = (x, y) => x >= l.x0 && x < l.x1 && y >= l.y0 && y < l.y1;
  // the colour most of the ring just around the text has
  const votes = new Map();
  for (let y = Math.max(0, l.y0 - 3); y < Math.min(h, l.y1 + 3); y++) {
    for (let x = Math.max(0, l.x0 - 3); x < Math.min(w, l.x1 + 3); x++) {
      const p = y * w + x;
      if (inBox(x, y) || region[p]) continue;
      const k = (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];
      votes.set(k, (votes.get(k) || 0) + 1);
    }
  }
  const [key] = [...votes].sort((a, b) => b[1] - a[1])[0] || [];
  if (key == null) return null;
  const c = [key >> 16, (key >> 8) & 255, key & 255];
  if (ROAD_RGB.some((r) => Math.abs(r[0] - c[0]) <= 3 && Math.abs(r[1] - c[1]) <= 3 && Math.abs(r[2] - c[2]) <= 3)) return null;
  const ok = (p) => !region[p] && (inBox(p % w, (p / w) | 0) || near(d, p * 4, c, 3));
  const seen = new Uint8Array(w * h), queue = [];
  for (let y = l.y0; y < l.y1; y++) for (let x = l.x0; x < l.x1; x++) { const p = y * w + x; if (!region[p]) { seen[p] = 1; queue.push(p); } }
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let head = 0; head < queue.length; head++) {
    if (queue.length > maxPx) return null;
    const i = queue[head], x = i % w, y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return null; // runs off the map: open land
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const n of [i - 1, i + 1, i - w, i + w]) if (!seen[n] && ok(n)) { seen[n] = 1; queue.push(n); }
  }
  if (queue.length < minPx) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, m = new Uint8Array(bw * bh);
  for (const p of queue) m[(((p / w) | 0) - y0) * bw + (p % w) - x0] = 1;
  const points = traceOutline(m, bw, bh).map((q) => ({ x: q.x + x0, y: q.y + y0 }));
  return points.length >= 3 ? { count: queue.length, points } : null;
}

/** Label box → an enlarged, contrast-stretched grey canvas (coloured lines and icons whited out). */
function labelCanvas(src, b, S = 4, pad = 4) {
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
  const w = Math.min(src.width, b.x1 + pad) - x0, h = Math.min(src.height, b.y1 + pad) - y0;
  const c = document.createElement('canvas');
  c.width = w * S + 40;
  c.height = h * S + 40;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x0, y0, w, h, 20, 20, w * S, h * S);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = sat > 60 ? 255 : Math.max(0, Math.min(255, ((l - 90) * 255) / 125));
  }
  g.putImageData(im, 0, 0);
  return c;
}

/**
 * Read an OSM map canvas (mpp metres per pixel): areas by colour, names by OCR.
 * Returns { areas, nodes, ways } in metres. onProgress(text) reports what it is doing.
 */
export async function readTileMap(canvas, mpp, onProgress = () => {}, maxLabels = 40) {
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  onProgress('找建築、水池、草地');
  // footways over a building are about a metre wide on the map
  const seg = segmentAreas(img, Math.max(20, 25 / (mpp * mpp)), Math.max(2, Math.round(1.5 / mpp)));
  const labels = [];
  if (window.Tesseract && mpp < 0.6) { // on a zoomed-out map the labels are too small to read
    const boxes = findLabels(img)
      .filter((b) => b.x1 - b.x0 >= (b.y1 - b.y0) * 0.8) // vertical road names are skipped
      .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
      .slice(0, maxLabels);
    const worker = await window.Tesseract.createWorker(['chi_tra']);
    try {
      for (let i = 0; i < boxes.length; i++) {
        onProgress(`讀地圖上的名字 ${i + 1}/${boxes.length}`);
        await worker.setParameters({ tessedit_pageseg_mode: boxes[i].lines > 1 || boxes[i].y1 - boxes[i].y0 >= 16 ? '6' : '7' });
        const { data } = await worker.recognize(labelCanvas(canvas, boxes[i]));
        labels.push({ ...boxes[i], text: data.text, conf: data.confidence });
      }
    } finally {
      await worker.terminate();
    }
  }
  return tileMapData(img, seg, labels, mpp);
}
