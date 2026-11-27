// Buildings, water and the site boundary from a map image (1-A4, user's model, 2026-11-20):
// inside the site everything is walkable except buildings (whole footprint) and water; a
// building's doors are where you walk to. Grid points over the image are labelled by colour:
//   ground (the most common colour), white (roads, light neutral paving), water (blue), lawn (green), ink (text, red
//   dashed footpaths) or "solid" (anything else: building fills).
// Buildings are solid patches of one colour (labels and footpaths across a roof are painted over
// first), traced and straightened into walls. Pure, no DOM.
import { pointInPolygon, simplifyRing, traceOuter, mainAngle, regularize, nearestOnRing, bbox, rdpRing } from './outline.js';

export const BUILDING_WORDS = /[館樓廳亭廁站室棟堂舍苑]|中心|教室|大樓/;
export const BUILDING_END = /(?:[館樓廳亭廁站室棟堂舍苑]|中心|教室|大樓)$/;
export const ROAD_WORDS = /[路道街]|步道|廣場|大道/;

const dist3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * @param img {data, width, height} RGBA
 * @param opts roads: [[{x,y}…]] canvas px; texts: [{name, cx, cy, conf}] (names); labels: [{x0,y0,x1,y1}] OCR text boxes
 * @returns { buildings: [{name, points, doors}], water: [{name, points}], boundary: [{x,y}] | null }
 */
export function extractMap(img, { roads = [], texts = [], labels = [], tol = 24, debug = null } = {}) {
  const { data, width: W, height: H } = img;
  const maxDim = Math.max(W, H);
  const g = Math.max(1, Math.round(maxDim / 600)); // grid step in px
  const gw = Math.floor(W / g), gh = Math.floor(H / g), n = gw * gh;
  const col = new Uint8Array(n * 3);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = ((y * g + (g >> 1)) * W + x * g + (g >> 1)) * 4, k = (y * gw + x) * 3;
    col[k] = data[i]; col[k + 1] = data[i + 1]; col[k + 2] = data[i + 2];
  }
  const rgb = (k) => [col[k * 3], col[k * 3 + 1], col[k * 3 + 2]];

  // ground: the most common colour (32 levels per channel)
  const bins = new Map();
  for (let k = 0; k < n; k++) {
    const key = (col[k * 3] >> 3) * 1024 + (col[k * 3 + 1] >> 3) * 32 + (col[k * 3 + 2] >> 3);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  let gk = 0, gc = -1;
  for (const [key, c] of bins) if (c > gc) { gc = c; gk = key; }
  const ground = [((gk >> 10) << 3) + 4, (((gk >> 5) & 31) << 3) + 4, ((gk & 31) << 3) + 4];

  // classes: 0 ground, 1 white, 2 water, 3 lawn, 4 ink, 5 solid
  const cls = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const [r, gg, b] = rgb(k), mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    if (dist3([r, gg, b], ground) <= 20) cls[k] = 0;
    else if (mn >= 245 || (mx - mn <= 8 && mn >= 220)) cls[k] = 1; // white roads, light neutral paving (parking)
    else if (b - r >= 40 && b >= gg - 10) cls[k] = 2;
    else if (gg - r >= 20 && gg - b >= 15) cls[k] = 3;
    else if ((r + gg + b) / 3 < 180 || (r - b >= 40 && r - gg >= 30)) cls[k] = 4; // labels (incl. their grey edges), red dashed footpaths
    else cls[k] = 5;
  }

  // OCR text boxes (text-sized only): whatever is drawn there (glyphs, mid-grey edges, halo) is label, not map
  const preLabel = cls.slice(); // classes before the text boxes (a box's background may be roof)
  const boxed = new Uint8Array(n);
  for (const b of labels) {
    if (b.y1 - b.y0 > Math.max(24, 0.03 * maxDim) && b.x1 - b.x0 > Math.max(24, 0.03 * maxDim)) continue;
    const bx0 = Math.max(0, Math.floor((b.x0 - 2) / g)), by0 = Math.max(0, Math.floor((b.y0 - 2) / g));
    const bx1 = Math.min(gw - 1, Math.floor((b.x1 + 2) / g)), by1 = Math.min(gh - 1, Math.floor((b.y1 + 2) / g));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) { const k = y * gw + x; boxed[k] = 1; if (cls[k] === 1 || cls[k] === 5) cls[k] = 4; }
  }
  // paint labels and footpaths over where they lie on one solid colour: the glyphs (ink), their
  // white halo, a dashed line across a roof. A white stretch is painted only together with ink
  // (a label), so a plain white road between two buildings stays a gap.
  const reach = Math.max(6, Math.ceil(32 / g)); // a label row with its halo and box margin is up to ~32 px tall
  const paint = new Uint8Array(col);
  const cls0 = cls.slice();
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const k = y * gw + x;
    if (cls0[k] !== 4 && cls0[k] !== 1) continue;
    const side = (dx, dy) => {
      let ink = 0;
      for (let s = 1; s <= reach; s++) {
        const xx = x + dx * s, yy = y + dy * s;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) return null;
        const q = yy * gw + xx;
        if (cls0[q] === 5) return { q, ink };
        if (cls0[q] === 4) ink++;
        else if (cls0[q] !== 1) return null;
      }
      return null;
    };
    for (const [A, B] of [[side(-1, 0), side(1, 0)], [side(0, -1), side(0, 1)]]) {
      if (!A || !B || dist3(rgb(A.q), rgb(B.q)) > tol) continue;
      if (cls0[k] === 1 && A.ink + B.ink === 0) continue;
      paint[k * 3] = col[A.q * 3]; paint[k * 3 + 1] = col[A.q * 3 + 1]; paint[k * 3 + 2] = col[A.q * 3 + 2];
      cls[k] = 5;
      break;
    }
  }
  const prgb = (k) => [paint[k * 3], paint[k * 3 + 1], paint[k * 3 + 2]];

  if (debug) Object.assign(debug, { cls, gw, gh, g, ground });
  // site boundary first (buildings outside it are the neighbours', not ours)
  const site = siteMask(cls, gw, gh, g, maxDim);

  // solid patches of one colour; a patch may cross a short stretch of ink (a label, a dashed
  // footpath) to reach more of the same colour, so a label across a roof does not split it
  const label = new Int32Array(n);
  const stamp = new Int32Array(n), run = new Uint8Array(n);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (cls[s] !== 5 || label[s]) continue;
    const seed = prgb(s), id = comps.length + 1;
    const c = { id, cells: [], ink: [], x0: gw, y0: gh, x1: 0, y1: 0 };
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % gw, y = (p - x) / gw, solid = cls[p] === 5;
      (solid ? c.cells : c.ink).push(p);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, p - gw, p + gw]) {
        if (q < 0 || q >= n) continue;
        if (cls[q] === 5) {
          // grow into neighbours of nearly the same colour (shading and JPEG noise drift slowly), within reach of the seed colour
          if (label[q] || dist3(prgb(q), seed) > 2 * tol || dist3(prgb(q), solid ? prgb(p) : seed) > (solid ? 14 : tol)) continue;
          label[q] = id;
          stack.push(q);
        } else if (cls[q] === 4) {
          const r = solid ? 1 : run[p] + 1;
          if (r > reach || (stamp[q] === id && run[q] <= r)) continue;
          stamp[q] = id;
          run[q] = r;
          stack.push(q);
        }
      }
    }
    comps.push(c);
  }
  // a name's anti-aliased edges between its strokes are solid cells of a darker shade that the roof's flood
  // cannot enter: they make a small patch of their own, mostly ink, and a name over the wall leaves a notch.
  // Such a patch (every cell next to a dark stroke, more ink than cells) joins the one roof it touches when
  // nothing else of its size or larger touches it; only its own cells, not the strokes it reached past the
  // wall. A real small roof has cells away from its name (軍械室), so it stays a building of its own.
  {
    const inkOf = new Map(); // ink cell -> comps that crossed it
    for (const c of comps) for (const q of new Set(c.ink)) { const l = inkOf.get(q); if (l) l.push(c); else inkOf.set(q, [c]); }
    const stroke = (q) => cls0[q] === 4 && col[q * 3] + col[q * 3 + 1] + col[q * 3 + 2] < 540; // dark text, not a red footpath
    const nb = (p) => { const x = p % gw; return [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, p - gw, p + gw].filter((q) => q >= 0 && q < n); };
    const merged = new Set();
    for (const f of comps) {
      if (f.ink.length < f.cells.length || f.cells.length > reach * reach) continue;
      if (!f.cells.every((p) => nb(p).some(stroke))) continue;
      const near = new Set();
      for (const p of f.cells) for (const q of nb(p)) if (label[q] && label[q] !== f.id) near.add(comps[label[q] - 1]);
      for (const q of f.ink) for (const c of inkOf.get(q)) if (c !== f) near.add(c);
      const big = [...near].filter((c) => !merged.has(c) && c.cells.length >= f.cells.length);
      if (big.length !== 1 || big[0].cells.length < 10 * f.cells.length) continue;
      const r = big[0];
      for (const p of f.cells) {
        (r.edge ||= []).push(p);
        const x = p % gw, y = (p - x) / gw;
        if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
      }
      merged.add(f);
    }
    for (let i = comps.length - 1; i >= 0; i--) if (merged.has(comps[i])) comps.splice(i, 1);
  }

  const area = W * H;
  const toCanvas = (p) => ({ x: (p.x + 0.5) * g, y: (p.y + 0.5) * g });
  const raw = [];
  const why = debug ? (debug.comps = []) : null;
  const reject = (c, r) => { if (why && c.cells.length * g * g > 0.0005 * area) why.push({ r, x0: c.x0 * g, y0: c.y0 * g, x1: (c.x1 + 1) * g, y1: (c.y1 + 1) * g, n: c.cells.length, col: prgb(c.cells[0]) }); };
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (Math.min(bw, bh) < 3) { reject(c, 'thin'); continue; }
    // name edges joined to the patch shape its wall only; whether it is a building is judged without them
    const shape = filledMask(c, label, gw, bw, bh, cls, reach);
    const mask = c.edge ? filledMask({ ...c, edge: null }, label, gw, bw, bh, cls, reach) : shape;
    const cells = mask.reduce((s, v) => s + v, 0), px = cells * g * g;
    let mx0 = bw, my0 = bh, mx1 = -1, my1 = -1, own = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[y * bw + x]) { if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y; }
    for (const q of c.cells) { const x = (q % gw) - c.x0, y = ((q - (q % gw)) / gw) - c.y0; if (mask[y * bw + x]) own++; }
    // a small roof can be nearly all label: the text box's background there is one roof colour (on the
    // ground it is ground, and only scattered glyph edges are left)
    const inMask = [...new Set(c.ink)].filter((q) => mask[(((q - (q % gw)) / gw) - c.y0) * bw + (q % gw) - c.x0]);
    const bg = inMask.filter((q) => preLabel[q] === 5);
    const glyphs = inMask.filter((q) => boxed[q] && preLabel[q] === 4).length; // strokes of a label: on roof or ground alike
    if (bg.length) {
      const med = [0, 1, 2].map((i) => bg.map((q) => col[q * 3 + i]).sort((p, r) => p - r)[bg.length >> 1]);
      for (const q of bg) if (dist3(rgb(q), med) <= tol) own++;
    }
    const fill = cells / Math.max(1, (mx1 - mx0 + 1) * (my1 - my0 + 1)); // against the final shape's own box
    const centre = { x: ((c.x0 + c.x1 + 1) / 2) * g, y: ((c.y0 + c.y1 + 1) / 2) * g };
    const inside = texts.filter((t) => t.cx >= c.x0 * g && t.cx <= (c.x1 + 1) * g && t.cy >= c.y0 * g && t.cy <= (c.y1 + 1) * g && mask[(Math.floor(t.cy / g) - c.y0) * bw + Math.floor(t.cx / g) - c.x0]);
    const seedB = inside.some((t) => BUILDING_WORDS.test(t.name)), seedR = inside.some((t) => ROAD_WORDS.test(t.name) && !BUILDING_WORDS.test(t.name));
    if (seedR) { reject(c, 'road word'); continue; }
    if (px > 0.15 * area) { reject(c, 'huge'); continue; }
    if (!seedB && (px < 0.0003 * area || fill < 0.35)) { reject(c, 'small/sparse ' + fill.toFixed(2)); continue; }
    if (own < 0.5 * (cells - glyphs)) { reject(c, 'mostly ink ' + (own / cells).toFixed(2)); continue; } // a label on the ground, not a roof
    if (site && !touches(mask, c.x0, c.y0, bw, bh, site, gw, gh, 2)) { reject(c, 'off site'); continue; } // a neighbour across the street
    reject(c, 'KEPT');
    const ring = traceOuter(shape, bw, bh).map((p) => toCanvas({ x: p.x + c.x0, y: p.y + c.y0 }));
    if (ring.length < 4) continue;
    raw.push({ ring: simplifyRing(ring, Math.max(1, g * 0.75)), inside, mask: shape, x0: c.x0, y0: c.y0, bw, bh });
  }
  // two buildings drawn as one roof (no line between), each with its own name: cut apart at the inner corner
  const theta0 = mainAngle(raw.map((b) => b.ring));
  for (let i = raw.length - 1; i >= 0; i--) {
    const parts = splitByNames(raw[i], theta0, g, maxDim);
    if (parts) raw.splice(i, 1, ...parts);
  }
  // a patch lying mostly inside a larger one (a label read as a patch of its own on a roof) is part of that building
  for (const b of raw) b.n = b.mask.reduce((t, v) => t + v, 0);
  const inside = (a, b) => {
    let both = 0;
    for (let y = Math.max(a.y0, b.y0); y < Math.min(a.y0 + a.bh, b.y0 + b.bh); y++) {
      for (let x = Math.max(a.x0, b.x0); x < Math.min(a.x0 + a.bw, b.x0 + b.bw); x++) if (a.mask[(y - a.y0) * a.bw + x - a.x0] && b.mask[(y - b.y0) * b.bw + x - b.x0]) both++;
    }
    return both >= 0.6 * a.n;
  };
  const nested = new Set(raw.filter((a) => raw.some((b) => b !== a && b.n >= a.n && !(b.n === a.n && raw.indexOf(b) > raw.indexOf(a)) && inside(a, b))));
  for (let i = raw.length - 1; i >= 0; i--) if (nested.has(raw[i])) raw.splice(i, 1);
  // the site takes in its own buildings at the edge (a building on the street side has no ground beyond it)
  let boundary = null;
  if (site) {
    for (const b of raw) for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) if (b.mask[y * b.bw + x]) site[(y + b.y0) * gw + x + b.x0] = 1;
    fillHoles(site, gw, gh);
    const ring = traceOuter(site, gw, gh).map((p) => ({ x: (p.x + 0.5) * g, y: (p.y + 0.5) * g }));
    const pts = simplifyRing(ring, Math.max(2, 0.004 * maxDim)).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    if (pts.length >= 3) boundary = pts;
  }
  const theta = mainAngle(raw.map((b) => b.ring));
  const doorW = Math.max(8, Math.round(0.012 * maxDim));
  const buildings = [];
  for (const b of raw) {
    const points = regularize(b.ring, theta);
    if (points.length < 3) continue;
    const o = { name: '', points, doors: [] };
    Object.defineProperty(o, 'roof', { value: { ...b, theta, g, maxDim, roads, doorW } }); // for splitAtNames (names read later)
    buildings.push(o);
  }
  nameBuildings(buildings, texts, 0.02 * maxDim);
  for (const b of buildings) b.doors = doorsFor(b.points, buildings, roads, maxDim, doorW);

  // water: blue patches (curved edges stay as traced, only simplified)
  const water = [];
  const wl = new Int32Array(n), stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (cls[s] !== 2 || wl[s]) continue;
    const c = { cells: [], x0: gw, y0: gh, x1: 0, y1: 0 };
    let sp = 0;
    stack[sp++] = s;
    wl[s] = 1;
    while (sp) {
      const p = stack[--sp], x = p % gw, y = (p - x) / gw;
      c.cells.push(p);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, p - gw, p + gw]) {
        if (q < 0 || q >= n || wl[q] || cls[q] !== 2) continue;
        wl[q] = 1;
        stack[sp++] = q;
      }
    }
    if (c.cells.length * g * g < 0.0005 * area) continue;
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const m = new Uint8Array(bw * bh);
    for (const p of c.cells) { const x = p % gw, y = (p - x) / gw; m[(y - c.y0) * bw + x - c.x0] = 1; }
    fillHoles(m, bw, bh);
    const ring = traceOuter(m, bw, bh).map((p) => toCanvas({ x: p.x + c.x0, y: p.y + c.y0 }));
    const points = simplifyRing(ring, Math.max(1.5, g));
    if (points.length < 3) continue;
    const named = texts.filter((t) => pointInPolygon({ x: t.cx, y: t.cy }, points)).sort((p, q) => (q.conf || 0) - (p.conf || 0));
    water.push({ name: named.length ? named[0].name : '', points });
  }
  return { buildings, water, boundary };
}

/**
 * Names: a label inside a building, or just outside its wall (within near px), names it. Labels that
 * look like a building name (館, 樓 …) and nearer ones go first; each label and building is used once.
 */
function nameBuildings(buildings, texts, near) {
  const pairs = [];
  buildings.forEach((b, i) => texts.forEach((t, j) => {
    if (!t.name) return;
    const p = { x: t.cx, y: t.cy };
    const d = pointInPolygon(p, b.points) ? 0 : nearestOnRing(b.points, p).d;
    if (d > near) return;
    // ends like a building name (…館, …樓) best, contains one next, anything else last
    const kind = BUILDING_END.test(t.name) ? 0 : BUILDING_WORDS.test(t.name) ? 0.5 : 1;
    pairs.push({ i, j, s: d + kind * near - (t.conf || 0) / 1000 });
  }));
  pairs.sort((a, b) => a.s - b.s);
  const usedB = new Set(), usedT = new Set();
  for (const { i, j } of pairs) {
    if (usedB.has(i) || usedT.has(j) || texts.some((t, k) => usedT.has(k) && t.name === texts[j].name)) continue;
    usedB.add(i);
    usedT.add(j);
    buildings[i].name = texts[j].name;
  }
}

/**
 * A component's cells in its bounding box: its own colour plus the ink it crossed, thin bits
 * sticking out (a dashed line, a label running past the wall) cut off, holes (labels, icons) filled,
 * and only the largest piece kept.
 */
/**
 * A building whose own label lines (read later, enlarged) hold two building names far apart: cut it the
 * way extractMap would have if the page pass had read both names. Replaces b in buildings (with doors);
 * returns the two parts, or null when the roof has no inner corner that parts the names.
 */
export function splitAtNames(buildings, b, names) {
  const r = b.roof;
  if (!r) return null;
  const parts = splitByNames({ ...r, inside: names }, r.theta, r.g, r.maxDim);
  if (!parts) return null;
  const out = [];
  for (const p of parts) {
    const points = regularize(p.ring, r.theta);
    if (points.length < 3) return null;
    const o = { name: p.inside[0].name, points, doors: [] };
    Object.defineProperty(o, 'roof', { value: { ...p, theta: r.theta, g: r.g, maxDim: r.maxDim, roads: r.roads, doorW: r.doorW } });
    out.push(o);
  }
  buildings.splice(buildings.indexOf(b), 1, ...out);
  for (const o of out) o.doors = doorsFor(o.points, buildings, r.roads, r.maxDim, r.doorW);
  return out;
}

/**
 * Two buildings drawn as one roof of one colour (an L or T shape, no line between) with a building name
 * on each part: cut the roof straight from an inner corner, along the walls (theta), so the two names
 * fall on different parts. The cut whose less convex part is the most convex wins (an L is about 0.75,
 * each part must reach 0.8); a roof without a real inner corner (a rectangle with two names) stays whole.
 */
function splitByNames(b, theta, g, maxDim) {
  const names = b.inside.filter((t) => BUILDING_WORDS.test(t.name));
  let A = null, B = null;
  for (let i = 0; i < names.length && !A; i++) for (let j = i + 1; j < names.length; j++) {
    if (names[i].name !== names[j].name && Math.hypot(names[i].cx - names[j].cx, names[i].cy - names[j].cy) > 0.03 * maxDim) { A = names[i]; B = names[j]; break; }
  }
  if (!A) return null;
  const { mask, bw, bh, x0, y0 } = b;
  const at = (x, y) => (x >= 0 && y >= 0 && x < bw && y < bh ? y * bw + x : -1);
  const cellOf = (p) => at(Math.floor(p.x / g) - x0, Math.floor(p.y / g) - y0);
  const R = Math.ceil((0.02 * maxDim) / g);
  const onRoof = (p) => { // the roof cell under a name, or the nearest one (a label can stick out past the wall)
    const k = cellOf(p);
    if (k >= 0 && mask[k]) return k;
    const cx = Math.floor(p.x / g) - x0, cy = Math.floor(p.y / g) - y0;
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, cy - R); y <= Math.min(bh - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(bw - 1, cx + R); x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (mask[y * bw + x] && d < bd) { bd = d; best = y * bw + x; }
    }
    return bd <= R * R ? best : -1;
  };
  const total = mask.reduce((s, v) => s + v, 0);
  const ring = rdpRing(b.ring, Math.max(2, 0.06 * Math.min(bw, bh) * g));
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; area2 += p.x * q.y - q.x * p.y; }
  const c = Math.cos(theta), s = Math.sin(theta);
  const dirs = [[c, s], [-s, c], [-c, -s], [s, -c]];
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[(i + ring.length - 1) % ring.length], v = ring[i], q = ring[(i + 1) % ring.length];
    if (Math.hypot(v.x - p.x, v.y - p.y) < 3 * g || Math.hypot(q.x - v.x, q.y - v.y) < 3 * g) continue;
    const turn = (v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x);
    if (turn * area2 >= 0) continue; // not an inner corner
    for (const [dx, dy] of dirs) {
      const cut = [];
      let t = 0.75 * g, len = 0;
      for (; t < Math.max(bw, bh) * g; t += 0.5 * g) {
        const k = cellOf({ x: v.x + dx * t, y: v.y + dy * t });
        if (k < 0 || !mask[k]) break;
        if (!cut.includes(k)) cut.push(k);
        len = t;
      }
      if (cut.length < 2) continue;
      const m2 = mask.slice();
      for (const k of cut) m2[k] = 0;
      const lab = new Int32Array(bw * bh), size = [0];
      for (let s0 = 0; s0 < bw * bh; s0++) {
        if (!m2[s0] || lab[s0]) continue;
        const id = size.length, st = [s0];
        let n = 0;
        lab[s0] = id;
        while (st.length) {
          const k = st.pop(), x = k % bw;
          n++;
          for (const r of [x > 0 ? k - 1 : -1, x < bw - 1 ? k + 1 : -1, k - bw, k + bw]) if (r >= 0 && r < bw * bh && m2[r] && !lab[r]) { lab[r] = id; st.push(r); }
        }
        size.push(n);
      }
      const ka = onRoof({ x: A.cx, y: A.cy }), kb = onRoof({ x: B.cx, y: B.cy }), ia = ka >= 0 ? lab[ka] : 0, ib = kb >= 0 ? lab[kb] : 0;
      if (!ia || !ib || ia === ib || size[ia] < 0.15 * total || size[ib] < 0.15 * total || size[ia] + size[ib] < 0.95 * (total - cut.length)) continue;
      const parts = [ia, ib].map((id) => { const m = new Uint8Array(bw * bh); for (let k = 0; k < bw * bh; k++) if (lab[k] === id) m[k] = 1; return m; });
      for (const k of cut) parts[(k % bw > 0 && parts[1][k - 1]) || (k % bw < bw - 1 && parts[1][k + 1]) || parts[1][k - bw] || parts[1][k + bw] ? 1 : 0][k] = 1;
      const sol = Math.min(...parts.map((m) => solidity(m, bw, bh)));
      if (sol < 0.8 || (best && (sol < best.sol || (sol === best.sol && len >= best.len)))) continue;
      best = { len, sol, parts };
    }
  }
  if (!best) return null;
  return best.parts.map((m, i) => {
    const ring2 = traceOuter(m, bw, bh).map((p) => ({ x: (p.x + x0 + 0.5) * g, y: (p.y + y0 + 0.5) * g }));
    const mine = i ? B : A, theirs = i ? A : B;
    const inside = [mine, ...b.inside.filter((t) => t !== mine && t !== theirs && m[cellOf({ x: t.cx, y: t.cy })])];
    return { ring: simplifyRing(ring2, Math.max(1, g * 0.75)), inside, mask: m, x0, y0, bw, bh };
  });
}

/** Cells over the area of their convex hull (1 for a rectangle, about 0.75 for an L). */
function solidity(m, w, h) {
  const pts = [];
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    n++;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !m[y * w + x - 1] || !m[y * w + x + 1] || !m[(y - 1) * w + x] || !m[(y + 1) * w + x]) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const out = []; for (const p of list) { while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop(); out.push(p); } out.pop(); return out; };
  const hull = [...half(pts), ...half([...pts].reverse())];
  let a = 0;
  for (let i = 0; i < hull.length; i++) { const p = hull[i], q = hull[(i + 1) % hull.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a ? n / (Math.abs(a) / 2) : 0;
}

function filledMask(c, label, gw, bw, bh, cls, reach) {
  let m = new Uint8Array(bw * bh);
  for (const p of c.cells) { const x = p % gw, y = (p - x) / gw; m[(y - c.y0) * bw + x - c.x0] = 1; }
  const seen = new Set();
  for (const p of c.edge || []) { const x = p % gw, y = (p - x) / gw; m[(y - c.y0) * bw + x - c.x0] = 1; }
  for (const p of c.ink) { if (seen.has(p)) continue; seen.add(p); const x = p % gw, y = (p - x) / gw; m[(y - c.y0) * bw + x - c.x0] = 1; }
  // a name across a whole roof (glyphs, their halo, gaps painted another shade) can leave only a thin
  // bridge between the two halves: close short straight gaps of drawn cells (ink or solid; never
  // ground, white, water or lawn) between the patch's own cells
  const gap = m.slice();
  for (const [len, other, at] of [[bh, bw, (i, j) => i * bw + j], [bw, bh, (i, j) => j * bw + i]]) {
    for (let j = 0; j < other; j++) {
      let last = -1;
      for (let i = 0; i < len; i++) {
        if (!m[at(i, j)]) continue;
        if (last >= 0 && i - last > 1 && i - last - 1 <= reach) {
          // a label over the wall (its box dropped: nothing marks it as text) hides the wall under it: its
          // white halo is crossed too when a stroke is in this line or the next, so a plain white road is not
          let drawn = true, ink = false, white = false;
          const cv = (t, jj) => { const k = at(t, jj), x = k % bw; return cls[((k - x) / bw + c.y0) * gw + x + c.x0]; };
          for (let t = last + 1; t < i && drawn; t++) { const v = cv(t, j); drawn = v === 4 || v === 5 || v === 1; if (v === 1) white = true; for (const jj of [j - 1, j, j + 1]) if (jj >= 0 && jj < other && cv(t, jj) === 4) ink = true; }
          if (drawn && (ink || !white)) for (let t = last + 1; t < i; t++) gap[at(t, j)] = 1;
        }
        last = i;
      }
    }
  }
  m = gap;
  if (Math.min(bw, bh) > 6) m = morph(morph(m, bw, bh, 1, false), bw, bh, 1, true);
  keepLargest(m, bw, bh);
  fillHoles(m, bw, bh);
  return m;
}

function keepLargest(m, w, h) {
  const lab = new Int32Array(w * h);
  let best = 0, bestN = 0, id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let cnt = 0;
    const st = [s];
    lab[s] = id;
    while (st.length) {
      const p = st.pop(), x = p % w;
      cnt++;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && m[q] && !lab[q]) { lab[q] = id; st.push(q); }
    }
    if (cnt > bestN) { bestN = cnt; best = id; }
  }
  for (let k = 0; k < w * h; k++) m[k] = lab[k] === best ? 1 : 0;
}

function fillHoles(m, w, h) {
  const out = new Uint8Array(w * h), st = [];
  for (let i = 0; i < w; i++) st.push(i, (h - 1) * w + i);
  for (let j = 0; j < h; j++) st.push(j * w, j * w + w - 1);
  while (st.length) {
    const p = st.pop();
    if (p < 0 || p >= w * h || out[p] || m[p]) continue;
    out[p] = 1;
    const x = p % w;
    if (x > 0) st.push(p - 1);
    if (x < w - 1) st.push(p + 1);
    st.push(p - w, p + w);
  }
  for (let k = 0; k < w * h; k++) if (!out[k]) m[k] = 1;
}

/** Square max (grow) or min (shrink) filter of radius r, separable. */
function morph(src, w, h, r, grow) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let d = -r; d <= r; d++) {
      const xx = x + d, s = xx < 0 || xx >= w ? (grow ? 0 : 1) : src[y * w + xx];
      if (grow ? s : !s) { v = grow ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let d = -r; d <= r; d++) {
      const yy = y + d, s = yy < 0 || yy >= h ? (grow ? 0 : 1) : tmp[yy * w + x];
      if (grow ? s : !s) { v = grow ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

/** Does a component mask come within r cells of the site? */
function touches(mask, x0, y0, bw, bh, site, gw, gh, r) {
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!mask[y * bw + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + x0 + dx, yy = y + y0 + dy;
      if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && site[yy * gw + xx]) return true;
    }
  }
  return false;
}

/** The site mask: the largest patch of ground (roads inside bridged, holes filled). Null if it is small. */
function siteMask(cls, gw, gh, g, maxDim) {
  const n = gw * gh;
  let m = new Uint8Array(n);
  for (let k = 0; k < n; k++) m[k] = cls[k] === 0 ? 1 : 0;
  const r = Math.max(3, Math.ceil((0.012 * maxDim) / g));
  m = morph(morph(m, gw, gh, r, true), gw, gh, r, false);
  const lab = new Int32Array(n), st = [];
  let bestId = 0, bestN = 0, id = 0;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let cnt = 0;
    st.push(s);
    lab[s] = id;
    while (st.length) {
      const p = st.pop(), x = p % gw;
      cnt++;
      for (const q of [x > 0 ? p - 1 : -1, x < gw - 1 ? p + 1 : -1, p - gw, p + gw]) if (q >= 0 && q < n && m[q] && !lab[q]) { lab[q] = id; st.push(q); }
    }
    if (cnt > bestN) { bestN = cnt; bestId = id; }
  }
  if (!bestId) return null;
  const site = new Uint8Array(n);
  for (let k = 0; k < n; k++) site[k] = lab[k] === bestId ? 1 : 0;
  fillHoles(site, gw, gh);
  if (site.reduce((s, v) => s + v, 0) < 0.25 * n) return null;
  return site;
}

/**
 * Doors (user rule 2B: every nearby road gets one): for each road passing within 6% of the map's
 * long side, a door where that road comes closest to the outline. With no road nearby, one door
 * facing the closest road; with no roads at all, one in the middle of the longest wall.
 */
function doorsFor(points, buildings, roads, maxDim, w) {
  const near = 0.06 * maxDim, step = Math.max(2, maxDim / 400);
  const inAny = (p) => buildings.some((b) => pointInPolygon(p, b.points));
  const perRoad = [];
  for (const r of roads) {
    let bestQ = null;
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i], L = Math.hypot(b.x - a.x, b.y - a.y), k = Math.max(1, Math.ceil(L / step));
      for (let j = 0; j <= k; j++) {
        const p = { x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k };
        if (inAny(p)) continue;
        const q = nearestOnRing(points, p);
        if (!bestQ || q.d < bestQ.d) bestQ = q;
      }
    }
    if (bestQ) perRoad.push(bestQ);
  }
  perRoad.sort((a, b) => a.d - b.d);
  const doors = [];
  for (const q of perRoad) {
    if (q.d > near && doors.length) break;
    if (q.d > near && perRoad[0] !== q) break;
    if (doors.some((d) => Math.hypot(d.x - q.x, d.y - q.y) < 2 * w)) continue;
    doors.push({ x: q.x, y: q.y, w });
    if (q.d > near) break; // nothing nearby: just the one facing the closest road
  }
  if (doors.length) return doors;
  let bi = 0, bl = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > bl) { bl = L; bi = i; }
  }
  const a = points[bi], b = points[(bi + 1) % points.length];
  return [{ x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), w }];
}

/**
 * The text lines of a building's label, for reading its name line by line (1-A4 OCR, 2026-11-20):
 * names on street-style maps are ~12 px tall, too small for one pass over the whole page. Ink is
 * clearly darker than the roof and not red (dashed footpaths) or blue (parking signs); a strip
 * along the walls is ignored (outlines). Rows with ink make lines, split into separate labels at
 * wide gaps, and a line running past the wall keeps its outside characters. Horizontal text only
 * (vertical labels are read by the older per-building pass). Ink up to `grow` px outside the wall
 * counts too (a label sitting on the wall gets cut out of the outline), unless it is inside one of
 * `others` (neighbouring buildings); a label's next line hanging below the wall is kept. Returns [{x0, y0, x1, y1, ref}]
 * top to bottom in image px (x1/y1 exclusive; ref = roof lightness).
 */
export function labelLines(img, points, { inset = 3, minH = 5, maxH = 60, grow = null, others = [] } = {}) {
  const { data, width: W, height: H } = img;
  const gr = grow ?? Math.max(4, Math.round(0.01 * Math.max(W, H)));
  const b = bbox(points);
  const bx0 = Math.max(0, Math.floor(b.x0) - gr), by0 = Math.max(0, Math.floor(b.y0) - gr);
  const bx1 = Math.min(W, Math.ceil(b.x1) + 1 + gr), by1 = Math.min(H, Math.ceil(b.y1) + 1 + gr);
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw < 4 || bh < 4) return [];
  const lum = (x, y) => { const i = (y * W + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
  // 2 = inside the outline, 1 = within `grow` of it (labels sitting on the wall), not in a neighbour
  const zone = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = { x: bx0 + x + 0.5, y: by0 + y + 0.5 };
    if (pointInPolygon(p, points)) zone[y * bw + x] = 2;
    else if (gr > 0 && nearestOnRing(points, p).d <= gr && !others.some((o) => pointInPolygon(p, o))) zone[y * bw + x] = 1;
  }
  const ins = (x, y) => x >= 0 && y >= 0 && x < bw && y < bh && zone[y * bw + x] === 2;
  const ls = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (ins(x, y) && ins(x - inset, y) && ins(x + inset, y) && ins(x, y - inset) && ins(x, y + inset)) ls.push(lum(bx0 + x, by0 + y));
  }
  if (!ls.length) return [];
  ls.sort((p, q) => p - q);
  const ref = ls[ls.length >> 1];
  const isInk = (x, y) => {
    const i = (y * W + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
    return (r + g + bl) / 3 < ref - 50 && !(r - Math.max(g, bl) > 40) && !(bl - r > 50);
  };
  // ink in the zone; marks that cannot be characters (outlines, long rules, big shapes) are dropped
  const ink = new Uint8Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) if (zone[i] && isInk(bx0 + (i % bw), by0 + Math.floor(i / bw))) ink[i] = 1;
  const seen = new Uint8Array(bw * bh);
  for (let s0 = 0; s0 < bw * bh; s0++) {
    if (!ink[s0] || seen[s0]) continue;
    const cells = [s0];
    seen[s0] = 1;
    let x0 = bw, y0 = bh, x1 = 0, y1 = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k], cx = c % bw, cy = (c - cx) / bw;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const n = ny * bw + nx;
        if (ink[n] && !seen[n]) { seen[n] = 1; cells.push(n); }
      }
    }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (ch > maxH || cw > maxH * 1.5 || (cw > 4 * ch && cw > 20) || (ch > 4 * cw && ch > 20)) for (const c of cells) ink[c] = 0;
  }
  const rows = new Array(bh).fill(0);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) rows[y] += ink[y * bw + x];
  // bands of inked rows; a gap of up to 3 px stays in one line (characters like 三)
  const bandsOf = (rw) => {
    const out = [];
    let s = -1, last = -1;
    for (let y = 0; y <= rw.length; y++) {
      const on = y < rw.length && rw[y] >= 2;
      if (on) { if (s < 0) s = y; else if (y - last - 1 > 3) { out.push([s, last + 1]); s = y; } last = y; }
    }
    if (s >= 0) out.push([s, last + 1]);
    return out;
  };
  const colInk = (gx, ya, yb) => { for (let y = ya; y < yb; y++) if (isInk(gx, y)) return true; return false; };
  const out = [];
  const rowInk = (gy, xa, xb) => { for (let x = xa; x <= xb; x++) if (isInk(x, gy)) return true; return false; };
  const addLine = (ga, gb, runs) => {
    for (const [ra, rb] of runs) {
      let x0 = ra, x1 = rb, gy0 = ga, gy1 = gb;
      // the whole height of the characters (only their top may be inside the zone)
      for (let y = gy1, last = gy1 - 1; y < H && y - last <= 2 && y - gy0 < maxH; y++) if (rowInk(y, x0, x1)) { last = y; gy1 = y + 1; }
      for (let y = gy0 - 1, last = gy0; y >= 0 && last - y <= 2 && gy1 - y < maxH; y--) if (rowInk(y, x0, x1)) { last = y; gy0 = y; }
      const h = gy1 - gy0;
      if (h < minH) continue;
      // run past the wall while the characters continue (gaps under one letter)
      for (let gx = x1 + 1, lastInk = x1; gx < W && gx - lastInk <= h && gx <= bx1 + 3 * h; gx++) if (colInk(gx, gy0, gy1)) { lastInk = gx; x1 = gx; }
      for (let gx = x0 - 1, lastInk = x0; gx >= 0 && lastInk - gx <= h && gx >= bx0 - 3 * h; gx--) if (colInk(gx, gy0, gy1)) { lastInk = gx; x0 = gx; }
      if (x1 - x0 + 1 < h * 0.8) continue; // a dot, an icon stem: not a word
      if (out.some((o) => o.y0 < gy1 && gy0 < o.y1 && o.x0 <= x1 && x0 < o.x1)) continue; // same line again
      out.push({ x0, y0: gy0, x1: x1 + 1, y1: gy1, ref });
    }
  };
  // separate labels on one row: split at gaps wider than 1.5 letters
  const splitRuns = (cols, h) => {
    if (!cols.length) return [];
    const runs = [[cols[0], cols[0]]];
    for (const x of cols.slice(1)) { const r = runs[runs.length - 1]; if (x - r[1] > 1.5 * h) runs.push([x, x]); else r[1] = x; }
    return runs;
  };
  for (const [a, z] of bandsOf(rows)) {
    const h = z - a;
    if (h > Math.min(maxH, Math.max(bh - 2 * gr, 1) * 0.6)) continue;
    const cols = [];
    for (let x = 0; x < bw; x++) { let n = 0; for (let y = a; y < z; y++) n += ink[y * bw + x]; if (n) cols.push(bx0 + x); }
    if (cols.length >= 2) addLine(by0 + a, by0 + z, splitRuns(cols, h));
  }
  // a label's next line hanging below the wall (…學 / 校): a band of about the same height right under it
  out.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  for (const L of [...out]) {
    const h = L.y1 - L.y0, ya = L.y1, yb = Math.min(H, L.y1 + Math.round(2.6 * h));
    if (yb - ya < minH) continue;
    const xa = Math.max(0, L.x0 - h), xb = Math.min(W, L.x1 + h);
    const rw = [];
    for (let y = ya; y < yb; y++) { let n = 0; for (let x = xa; x < xb; x++) n += isInk(x, y) ? 1 : 0; rw.push(n); }
    const nb = bandsOf(rw).find(([a, z]) => a <= 0.8 * h && z - a >= 0.6 * h && z - a <= 1.4 * h);
    if (!nb) continue;
    const gy0 = ya + nb[0], gy1 = ya + nb[1];
    if (out.some((o) => o.y0 < gy1 && gy0 < o.y1 && o.x0 < xb && xa < o.x1)) continue; // already a line
    const cols = [];
    for (let x = xa; x < xb; x++) if (colInk(x, gy0, gy1)) cols.push(x);
    const runs = splitRuns(cols, gy1 - gy0).filter(([p, q]) => p < L.x1 && q >= L.x0);
    addLine(gy0, gy1, runs);
  }
  return out.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
}

/**
 * Every building's labels as groups of lines (a name may take two lines): each line goes to one
 * building only (the one it sits on, else the nearest), and lines more than ~a line apart, or
 * not side by side, are separate labels (a place name above a building's own name).
 * Returns, per building, [[line, …], …] top to bottom.
 */
export function labelsFor(img, buildings, opt = {}) {
  const all = [];
  buildings.forEach((b, i) => {
    const others = buildings.filter((o) => o !== b).map((o) => o.points);
    for (const L of labelLines(img, b.points, { ...opt, others })) {
      const c = { x: (L.x0 + L.x1) / 2, y: (L.y0 + L.y1) / 2 };
      all.push({ L, i, d: pointInPolygon(c, b.points) ? 0 : nearestOnRing(b.points, c).d });
    }
  });
  const area = (L) => (L.x1 - L.x0) * (L.y1 - L.y0);
  const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const kept = all.filter((p) => !all.some((q) => q !== p && overlap(p.L, q.L) > 0.5 * Math.min(area(p.L), area(q.L)) && (q.d < p.d || (q.d === p.d && q.i < p.i))));
  return buildings.map((_, i) => {
    const lines = kept.filter((p) => p.i === i).map((p) => p.L).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const groups = [];
    for (const L of lines) {
      const g = groups.find((gr) => {
        const last = gr[gr.length - 1], h = Math.max(last.y1 - last.y0, L.y1 - L.y0);
        return L.y0 - last.y1 <= 0.8 * h && L.y0 >= last.y1 - 0.3 * h && Math.min(L.x1, last.x1) > Math.max(L.x0, last.x0);
      });
      if (g) g.push(L); else groups.push([L]);
    }
    // a label standing beside the wall on the ground (a neighbour's name, a place name) is not this
    // building's: it lies outside the outline and the ground shows around its letters. One cut out of
    // the outline (sitting on the wall) still has roof around it; a hanging second line has its first.
    return groups.filter((gr) => gr.some((L) => insideShare(L, buildings[i].points) >= 0.25 || roofAround(img, L) >= 0.5));
  });
}

/** Share of a text line (along its middle row) that lies inside the outline. */
function insideShare(L, points) {
  const y = (L.y0 + L.y1) / 2;
  let n = 0, inside = 0;
  for (let x = L.x0 + 0.5; x < L.x1; x += 1) { n++; if (pointInPolygon({ x, y }, points)) inside++; }
  return n ? inside / n : 0;
}

/** Share of the background (not ink) in a text line's box that has the roof's lightness. */
function roofAround(img, L) {
  const { data, width: W, height: H } = img;
  let bg = 0, roof = 0;
  for (let y = Math.max(0, Math.floor(L.y0)); y < Math.min(H, Math.ceil(L.y1)); y++) for (let x = Math.max(0, Math.floor(L.x0)); x < Math.min(W, Math.ceil(L.x1)); x++) {
    const i = (y * W + x) * 4, l = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (l < L.ref - 25) continue; // ink
    bg++;
    if (Math.abs(l - L.ref) <= 12) roof++;
  }
  return bg ? roof / bg : 0;
}
