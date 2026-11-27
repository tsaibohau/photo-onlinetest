// Open-walk venues: the whole venue is walkable except the obstacles (grass, water, buildings…)
// and the blocks people can't walk through (booths, stages…). Pure functions in metres, no DOM.

/** Block kinds that people can walk on (everything else is an obstacle in open-walk venues). */
export const WALKABLE_BLOCK_KINDS = new Set(['entrance']);

/** Ray casting; points on the boundary count as inside. */
export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (x === p.x) return true;
      if (x > p.x) inside = !inside;
    }
  }
  return inside;
}

const rectPts = (b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];

/**
 * Every area people can't walk through: [{ id, kind, name, points, poi?, shape?, doors? }] in metres.
 * shape 'wall' (buildings): only the outline blocks, the inside is walkable; doors [{x, y, w}] are
 * gaps in the outline.
 */
export function obstaclePolygons(venue) {
  return [
    ...(venue.obstacles || []).map((o) => ({
      id: o.id, kind: o.kind, name: o.name || '', points: o.points,
      ...(o.shape === 'wall' ? { shape: 'wall', doors: o.doors || [] } : {}),
    })),
    ...groundParts(venue),
    ...venue.blocks
      .filter((b) => !WALKABLE_BLOCK_KINDS.has(b.kind))
      .map((b) => ({ id: b.id, kind: b.kind, name: b.name, points: rectPts(b), poi: b.id })),
  ];
}

const insideVenue = (venue, p) => p.x >= 0 && p.y >= 0 && p.x <= venue.width && p.y <= venue.height;

/** True when p is inside the venue and not inside any obstacle. */
export function isWalkable(venue, p) {
  return insideVenue(venue, p) && !obstaclePolygons(venue).some((o) => o.shape !== 'wall' && pointInPolygon(p, o.points));
}

/** Nearest point on the closed outline pts to p: { x, y, dist, edge, t }. */
export function nearestOnRing(pts, p) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const x = a.x + t * dx, y = a.y + t * dy;
    const dist = Math.hypot(p.x - x, p.y - y);
    if (!best || dist < best.dist) best = { x, y, dist, edge: i, t };
  }
  return best;
}

/** The outline pts as segments [[a, b]], with a gap of width d.w around every door d. */
export function wallSegments(pts, doors = []) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (!L) continue;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    // door intervals along this edge (doors lying within 0.5 m of it)
    const cuts = [];
    for (const d of doors) {
      const s = (d.x - a.x) * ux + (d.y - a.y) * uy;
      const off = Math.abs((d.x - a.x) * uy - (d.y - a.y) * ux);
      if (off > 0.5 || s < -d.w / 2 || s > L + d.w / 2) continue;
      cuts.push([s - d.w / 2, s + d.w / 2]);
    }
    cuts.sort((p, q) => p[0] - q[0]);
    let s0 = 0;
    const at = (s) => ({ x: a.x + ux * s, y: a.y + uy * s });
    for (const [c0, c1] of cuts) {
      if (c0 > s0) out.push([at(s0), at(Math.min(c0, L))]);
      s0 = Math.max(s0, c1);
    }
    if (s0 < L) out.push([at(s0), b]);
  }
  return out;
}

/** Occupancy grid: a cell is blocked when its centre lies in an obstacle, or a wall crosses it. */
export function walkGrid(venue, cell = 0.5) {
  const cols = Math.max(1, Math.ceil(venue.width / cell));
  const rows = Math.max(1, Math.ceil(venue.height / cell));
  const blocked = new Uint8Array(cols * rows);
  const mark = (x, y) => {
    const c = Math.floor(x / cell), r = Math.floor(y / cell);
    if (c >= 0 && r >= 0 && c < cols && r < rows) blocked[r * cols + c] = 1;
  };
  for (const o of obstaclePolygons(venue)) {
    if (o.shape === 'wall') {
      for (const [a, b] of wallSegments(o.points, o.doors)) {
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 4));
        for (let i = 0; i <= n; i++) mark(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      }
      continue;
    }
    const xs = o.points.map((q) => q.x), ys = o.points.map((q) => q.y);
    const c0 = Math.max(0, Math.floor(Math.min(...xs) / cell)), c1 = Math.min(cols - 1, Math.floor(Math.max(...xs) / cell));
    const r0 = Math.max(0, Math.floor(Math.min(...ys) / cell)), r1 = Math.min(rows - 1, Math.floor(Math.max(...ys) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (!blocked[i] && pointInPolygon({ x: (c + 0.5) * cell, y: (r + 0.5) * cell }, o.points)) blocked[i] = 1;
      }
    }
  }
  return { cell, cols, rows, blocked };
}

/** Free cell for point p (its own, or a free neighbour within 2 cells), or -1. */
function cellOf(g, p) {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell)));
  for (let d = 0; d <= 2; d++) {
    for (let dr = -d; dr <= d; dr++) {
      for (let dc = -d; dc <= d; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < g.rows && cc < g.cols && !g.blocked[rr * g.cols + cc]) return rr * g.cols + cc;
      }
    }
  }
  return -1;
}

/** True when every point can be reached from the first one through free cells (4-neighbour). */
export function allReachable(g, points) {
  if (!points.length) return true;
  const cells = points.map((p) => cellOf(g, p));
  if (cells.some((i) => i < 0)) return false;
  const seen = new Uint8Array(g.cols * g.rows);
  const queue = new Int32Array(g.cols * g.rows);
  let head = 0, tail = 0;
  queue[tail++] = cells[0];
  seen[cells[0]] = 1;
  while (head < tail) {
    const i = queue[head++];
    const r = (i / g.cols) | 0, c = i - r * g.cols;
    const next = [c > 0 && i - 1, c < g.cols - 1 && i + 1, r > 0 && i - g.cols, r < g.rows - 1 && i + g.cols];
    for (const n of next) {
      if (n === false || seen[n] || g.blocked[n]) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  return cells.every((i) => seen[i]);
}

/**
 * Indexes of the points that are cut off from the rest: everything outside the connected area
 * that holds the most points (4-neighbour, like allReachable).
 */
export function unreachablePoints(g, points) {
  const cells = points.map((p) => cellOf(g, p));
  const comp = new Int32Array(g.cols * g.rows);
  const queue = new Int32Array(g.cols * g.rows);
  let id = 0;
  for (const s of cells) {
    if (s < 0 || comp[s]) continue;
    id++;
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const i = queue[head++];
      const r = (i / g.cols) | 0, c = i - r * g.cols;
      for (const n of [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, r > 0 ? i - g.cols : -1, r < g.rows - 1 ? i + g.cols : -1]) {
        if (n >= 0 && !comp[n] && !g.blocked[n]) { comp[n] = id; queue[tail++] = n; }
      }
    }
  }
  const count = new Map();
  for (const s of cells) if (s >= 0) count.set(comp[s], (count.get(comp[s]) || 0) + 1);
  let main = -1, most = 0;
  for (const [k, n] of count) if (n > most) { most = n; main = k; }
  return cells.flatMap((s, i) => (s < 0 || comp[s] !== main ? [i] : []));
}

/** Sutherland–Hodgman: clip polygon pts to the rectangle x0..x1 × y0..y1 ([] when outside). */
export function clipPolygon(pts, x0, y0, x1, y1) {
  const edges = [
    [(p) => p.x >= x0, (a, b) => ({ x: x0, y: a.y + ((x0 - a.x) / (b.x - a.x)) * (b.y - a.y) })],
    [(p) => p.x <= x1, (a, b) => ({ x: x1, y: a.y + ((x1 - a.x) / (b.x - a.x)) * (b.y - a.y) })],
    [(p) => p.y >= y0, (a, b) => ({ x: a.x + ((y0 - a.y) / (b.y - a.y)) * (b.x - a.x), y: y0 })],
    [(p) => p.y <= y1, (a, b) => ({ x: a.x + ((y1 - a.y) / (b.y - a.y)) * (b.x - a.x), y: y1 })],
  ];
  let out = pts;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i - 1 + input.length) % input.length], b = input[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) return [];
  }
  return out;
}

/**
 * The rooms and inner walls drawn on the ground floor (floors[0]) of every building, as wall-only
 * obstacles in venue metres. Upper floors stay in the editor (the .phop has one floor).
 */
export function groundParts(venue) {
  return (venue.obstacles || []).flatMap((o) => (o.shape === 'wall' && o.floors?.[0]?.parts || []).map((p) => ({
    id: `${o.id}-${p.id}`, kind: 'building', name: p.name || '', points: p.points, shape: 'wall', doors: p.doors || [],
  })));
}
