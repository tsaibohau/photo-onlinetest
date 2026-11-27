// Free walking on open-walk maps: a 0.5 m grid of free/blocked cells built from the map's
// obstacles, shortest routes around them (A*), and moving the user freely (any direction,
// not snapped to a path) while never entering an obstacle. Coordinates are map pixels.
import { walkGrid, pointInPolygon } from './walkable.js';

/** Walking through a building costs this many times more than outside, so routes stay outdoors unless that saves a lot. */
const INDOOR = 3;
/** Walking on a drawn path costs this much, so routes follow paths unless that is a big detour. */
const ON_PATH = 0.6;
/** Half the width of the band along a drawn path that counts as on it (metres). */
const PATH_HALF_M = 1.5;

/** Grid for a .phop graph (obstacles in px), image size (px) and pixels per metre. */
export function gridFromGraph(graph, size, ppm, cell = 0.5) {
  const m = (q) => ({ x: q.x / ppm, y: q.y / ppm });
  const venue = {
    width: size.width / ppm,
    height: size.height / ppm,
    blocks: [],
    obstacles: (graph.obstacles || []).map((o) => ({
      ...o,
      points: o.points.map(m),
      ...(o.doors ? { doors: o.doors.map((d) => ({ ...m(d), w: d.w / ppm })) } : {}),
    })),
  };
  const g = walkGrid(venue, cell);
  // cells inside buildings you can walk into (their walls block, their floor does not)
  const indoor = new Uint8Array(g.cols * g.rows);
  for (const o of venue.obstacles) {
    if (o.shape !== 'wall') continue;
    const xs = o.points.map((q) => q.x), ys = o.points.map((q) => q.y);
    const c0 = Math.max(0, Math.floor(Math.min(...xs) / cell)), c1 = Math.min(g.cols - 1, Math.floor(Math.max(...xs) / cell));
    const r0 = Math.max(0, Math.floor(Math.min(...ys) / cell)), r1 = Math.min(g.rows - 1, Math.floor(Math.max(...ys) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (pointInPolygon({ x: (c + 0.5) * cell, y: (r + 0.5) * cell }, o.points)) indoor[r * g.cols + c] = 1;
    }
  }
  // cells on drawn paths (only make routes prefer them; the user can still walk anywhere)
  const onPath = new Uint8Array(g.cols * g.rows);
  const R = Math.ceil(PATH_HALF_M / cell);
  for (const P of graph.paths || []) {
    const pts = P.points.map(m);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 2)));
      for (let t = 0; t <= n; t++) {
        const c = Math.floor((a.x + ((b.x - a.x) * t) / n) / cell), r = Math.floor((a.y + ((b.y - a.y) * t) / n) / cell);
        for (let dr = -R; dr <= R; dr++) {
          for (let dc = -R; dc <= R; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < g.rows && cc < g.cols && (dr * dr + dc * dc) * cell * cell <= PATH_HALF_M ** 2) onPath[rr * g.cols + cc] = 1;
          }
        }
      }
    }
  }
  return { ...g, indoor, onPath, ppm };
}

/** Cost of walking one cell's length through cell i. */
const cellCost = (g, i) => (g.indoor?.[i] ? INDOOR : g.onPath?.[i] ? ON_PATH : 1);

const cellIdx = (g, p) => {
  const c = Math.floor(p.x / g.ppm / g.cell), r = Math.floor(p.y / g.ppm / g.cell);
  return c >= 0 && r >= 0 && c < g.cols && r < g.rows ? r * g.cols + c : -1;
};
const centre = (g, i) => ({ x: ((i % g.cols) + 0.5) * g.cell * g.ppm, y: (Math.floor(i / g.cols) + 0.5) * g.cell * g.ppm });

/** True when p (px) is inside the map and not in an obstacle. */
export function freeAt(g, p) {
  const i = cellIdx(g, p);
  return i >= 0 && !g.blocked[i];
}

/** Nearest free cell to p (searching outwards up to maxM metres), or -1. */
function nearestFree(g, p, maxM = 60) {
  const c0 = Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.ppm / g.cell)));
  const r0 = Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.ppm / g.cell)));
  if (!g.blocked[r0 * g.cols + c0]) return r0 * g.cols + c0;
  const R = Math.ceil(maxM / g.cell);
  for (let d = 1; d <= R; d++) {
    let best = -1, bd = Infinity;
    for (let dr = -d; dr <= d; dr++) {
      for (const dc of Math.abs(dr) === d ? range(-d, d) : [-d, d]) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= g.rows || c >= g.cols || g.blocked[r * g.cols + c]) continue;
        const dd = dr * dr + dc * dc;
        if (dd < bd) { bd = dd; best = r * g.cols + c; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}
function range(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

/** True when the straight line a→b (px) crosses only free cells (and, unless indoorOk, no building floor). */
export function lineFree(g, a, b, indoorOk = true) {
  const step = g.cell * g.ppm * 0.35;
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  for (let i = 0; i <= n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
    if (!freeAt(g, p)) return false;
    if (!indoorOk && g.indoor?.[cellIdx(g, p)]) return false;
  }
  return true;
}

/**
 * Shortest route from a to b (px) around obstacles: [{x, y}] with straight legs, or null.
 * Ends that are inside an obstacle (e.g. a building's centre) move to the nearest free spot.
 */
export function findRoute(g, a, b) {
  const s = nearestFree(g, a), t = nearestFree(g, b);
  if (s < 0 || t < 0) return null;
  const N = g.cols * g.rows;
  const cost = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const tc = t % g.cols, tr = Math.floor(t / g.cols);
  const hk = g.onPath?.some(Boolean) ? ON_PATH : 1; // keeps the estimate below the real cost
  const h = (i) => {
    const dx = Math.abs((i % g.cols) - tc), dy = Math.abs(Math.floor(i / g.cols) - tr);
    return hk * (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy));
  };
  const heap = new Heap();
  cost[s] = 0;
  heap.push(s, h(s));
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    if (i === t) break;
    const c = i % g.cols, r = Math.floor(i / g.cols);
    for (const [dc, dr, w] of D) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= g.cols || rr >= g.rows) continue;
      const j = rr * g.cols + cc;
      if (g.blocked[j] || done[j]) continue;
      if (dc && dr && (g.blocked[r * g.cols + cc] || g.blocked[rr * g.cols + c])) continue; // no corner cutting
      const nc = cost[i] + w * cellCost(g, j);
      if (nc < cost[j]) { cost[j] = nc; from[j] = i; heap.push(j, nc + h(j)); }
    }
  }
  if (!done[t]) return null;
  const cells = [];
  for (let i = t; i >= 0; i = from[i]) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => centre(g, i));
  if (freeAt(g, a)) pts[0] = { x: a.x, y: a.y };
  if (freeAt(g, b)) pts[pts.length - 1] = { x: b.x, y: b.y };
  return smooth(g, pts, cells.map((i) => !!g.indoor?.[i]), cells.map((i) => cost[i]));
}

/** Cost (in cell lengths) of walking the straight line a→b (px). */
function lineCost(g, a, b) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * g.ppm * 0.5)));
  const len = Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * g.ppm) / n;
  let c = 0;
  for (let i = 0; i < n; i++) c += len * cellCost(g, cellIdx(g, { x: a.x + ((b.x - a.x) * (i + 0.5)) / n, y: a.y + ((b.y - a.y) * (i + 0.5)) / n }));
  return c;
}

/** String-pulling: keep only the turns needed to stay clear of obstacles. */
function smooth(g, pts, indoor, acc) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let i = 0;
  // a shortcut may cross a building floor only where the found route already went indoors
  const indoorBetween = (i, j) => indoor.slice(i, j + 1).some(Boolean);
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    // ...and only where it costs no more than the found route (so it does not leave a drawn path)
    while (j > i + 1 && !(lineFree(g, pts[i], pts[j], indoorBetween(i, j)) && lineCost(g, pts[i], pts[j]) <= (acc[j] - acc[i]) * 1.05 + 1)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

export const routeLength = (r) => r.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - r[i].x, p.y - r[i].y), 0);

/** Where p is along route r: { remaining (px to the end), off (px from the route), at (closest point) }. */
export function routeProgress(r, p) {
  let best = { off: Infinity, seg: 0, t: 0, at: r[0] };
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i], b = r[i + 1];
    const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.off) best = { off: d, seg: i, t, at: q };
  }
  let remaining = Math.hypot(r[best.seg + 1].x - best.at.x, r[best.seg + 1].y - best.at.y);
  for (let i = best.seg + 1; i < r.length - 1; i++) remaining += Math.hypot(r[i + 1].x - r[i].x, r[i + 1].y - r[i].y);
  return { remaining, off: best.off, at: best.at, seg: best.seg };
}

/**
 * One step from p (px) heading `angle` (radians, 0 = map up, clockwise) of length len px.
 * Free movement; at an obstacle it slides along it, or stays put.
 */
export function walkStep(g, p, angle, len) {
  const dx = Math.sin(angle) * len, dy = -Math.cos(angle) * len;
  for (const [mx, my] of [[dx, dy], [dx, 0], [0, dy]]) {
    if (!mx && !my) continue;
    const q = { x: p.x + mx, y: p.y + my };
    if (freeAt(g, q) && lineFree(g, p, q)) return q;
  }
  return { x: p.x, y: p.y };
}

/**
 * The anchor to show the user on: the nearest one to p within maxDist (px), or null. Stays on
 * prev until another anchor is clearly closer (keep × prev's distance), so the dot does not
 * flicker between two neighbours. Only the shown position snaps; p itself keeps moving freely.
 * seen(a) (optional) rules out anchors that can't be seen from p, e.g. behind a building wall.
 */
export function snapToAnchor(anchors, p, prev, maxDist, keep = 0.75, seen = () => true) {
  const near = [];
  for (const a of anchors) {
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d <= maxDist) near.push([d, a]);
  }
  near.sort((u, v) => u[0] - v[0]);
  const hit = near.find(([, a]) => seen(a));
  if (!hit) return null;
  const [bd, best] = hit;
  if (prev && prev !== best) {
    const pd = Math.hypot(prev.x - p.x, prev.y - p.y);
    if (pd <= maxDist && bd >= keep * pd && seen(prev)) return prev;
  }
  return best;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(k, v) {
    const K = this.k, V = this.v;
    let i = K.length;
    K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (V[p] <= v) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = K[0];
    const k = K.pop(), v = V.pop();
    if (K.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mv = v;
        if (l < K.length && V[l] < mv) { m = l; mv = V[l]; }
        if (r < K.length && V[r] < mv) { m = r; mv = V[r]; }
        if (m === i) break;
        K[i] = K[m]; V[i] = V[m]; i = m;
      }
      K[i] = k; V[i] = v;
    }
    return top;
  }
}
