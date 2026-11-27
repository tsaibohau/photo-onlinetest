// Automatic suggestions for the map editor, one list per wizard step (3 roads / obstacles,
// 4 booths, 5 anchors), from OpenStreetMap data or from the photo recognition result.
// The user reviews them (keep / drop / keep and fix). Pure functions in metres, no DOM.
import { makeObstacle, makeWall, makePath, nextId, DOOR_W } from './venue.js';
import { nearestOnRing, isWalkable, pointInPolygon, obstaclePolygons, walkGrid } from './walkable.js';
import { simplify } from './curves.js';

const r1 = (v) => Math.round(v * 10) / 10;
export const UNSURE_CONF = 75; // OCR readings below this start unchecked and are flagged
const BUILDING_NAME = /樓|館|堂|舍|大樓|中心|building|hall/i; // photo blocks that look like real buildings

/** Block kind for a name read off a map (or an OSM tag set). */
export function guessKind(name = '', tags = {}) {
  if (/入口|出口|大門|[東西南北側後正]門|門口|gate|entrance/i.test(name) || tags.entrance) return 'entrance';
  if (/服務台|服務中心|詢問|資訊|info/i.test(name) || tags.tourism === 'information') return 'info';
  if (/廁|洗手間|化妝室|toilet|wc/i.test(name) || tags.amenity === 'toilets') return 'restroom';
  if (/舞台|舞臺|stage/i.test(name)) return 'stage';
  if (/教室|室$|館$|廳$|room/i.test(name)) return 'room';
  return 'booth';
}

function segCross(a, b, c, d) {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (!den) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
}

/**
 * Doors of a building outline: entrances within 2.5 m of it, and the places where paths cross
 * it. When there are none, one door is guessed (closest to a path, else a whole wall people can
 * walk in through, see guessEntrance) and guessed = true.
 * opt: { others: outlines of the other buildings / obstacles, width, height (venue size) }.
 */
export function findDoors(points, entrances = [], ways = [], opt = {}) {
  const found = [];
  for (const e of entrances) {
    const n = nearestOnRing(points, e);
    if (n.dist <= 2.5) found.push(n);
  }
  for (const w of ways) {
    for (let i = 1; i < w.length; i++) {
      for (let j = 0; j < points.length; j++) {
        const x = segCross(w[i - 1], w[i], points[j], points[(j + 1) % points.length]);
        if (x) found.push(x);
      }
    }
  }
  const doors = [];
  for (const p of found) if (!doors.some((d) => Math.hypot(d.x - p.x, d.y - p.y) < 3)) doors.push({ x: r1(p.x), y: r1(p.y), w: DOOR_W });
  if (doors.length) return { doors, guessed: false };
  let best = null;
  for (const w of ways) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1], b = w[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let s = 0; s <= n; s++) {
        const q = nearestOnRing(points, { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
        if (!best || q.dist < best.dist) best = q;
      }
    }
  }
  if (!best) return { doors: [guessEntrance(points, opt)], guessed: true };
  return { doors: [{ x: r1(best.x), y: r1(best.y), w: DOOR_W }], guessed: true };
}

const signedArea = (P) => P.reduce((s, q, i) => {
  const r = P[(i + 1) % P.length];
  return s + q.x * r.y - r.x * q.y;
}, 0) / 2;

/**
 * Guess where people walk into a building with no known entrance: the whole of one wall (but its
 * corners). A part that sticks out (porch, entrance hall) comes first, then the longest wall
 * whose outside is open ground (not another building, not the edge of the venue). When every
 * wall is blocked: a 2 m door in the middle of the longest wall.
 */
export function guessEntrance(outline, { others = [], width = Infinity, height = Infinity } = {}) {
  // straighten an outline traced from a map image (tiny pixel steps), like the saved wall is
  let points = simplify([...outline, outline[0]], 0.3).slice(0, -1);
  if (points.length < 3) points = outline;
  const n = points.length;
  const turn = signedArea(points) > 0 ? 1 : -1;
  const convex = (i) => {
    const a = points[(i - 1 + n) % n], p = points[i], b = points[(i + 1) % n];
    return ((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) * turn > 0;
  };
  const edges = points.map((a, i) => {
    const b = points[(i + 1) % n], L = Math.hypot(b.x - a.x, b.y - a.y);
    return { i, a, b, L, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  });
  const free = (e) => {
    if (e.L < 2) return false;
    let nx = (e.b.y - e.a.y) / e.L, ny = -(e.b.x - e.a.x) / e.L;
    if (pointInPolygon({ x: e.mid.x + nx * 0.2, y: e.mid.y + ny * 0.2 }, points)) { nx = -nx; ny = -ny; }
    for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      const q = { x: e.a.x + (e.b.x - e.a.x) * t + nx, y: e.a.y + (e.b.y - e.a.y) * t + ny };
      if (q.x < 0 || q.y < 0 || q.x > width || q.y > height) return false;
      if (others.some((o) => o !== outline && pointInPolygon(q, o))) return false;
    }
    return true;
  };
  const sticksOut = (e) => convex(e.i) && convex((e.i + 1) % n) && !convex((e.i - 1 + n) % n) && !convex((e.i + 2) % n);
  const open = edges.filter(free).sort((p, q) => q.L - p.L);
  const pick = open.find(sticksOut) || open[0];
  if (pick) return { x: r1(pick.mid.x), y: r1(pick.mid.y), w: r1(Math.max(DOOR_W, pick.L - 1)) };
  const longest = edges.reduce((p, q) => (q.L > p.L ? q : p));
  return { x: r1(longest.mid.x), y: r1(longest.mid.y), w: DOOR_W };
}

const rectPts = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

function wallCandidate(key, name, points, entrances, ways, opt) {
  const { doors, guessed } = findDoors(points, entrances, ways, opt);
  return {
    key, step: 3, type: 'obstacle', name, on: true,
    item: { kind: 'building', shape: 'wall', name, points, doors },
    ...(guessed ? { note: '門的位置是猜的' } : {}),
  };
}

/** Pieces of the polyline that lie inside the venue. */
function insideRuns(points, venue) {
  const runs = [];
  let cur = [];
  for (const p of points) {
    if (p.x >= 0 && p.y >= 0 && p.x <= venue.width && p.y <= venue.height) cur.push(p);
    else { if (cur.length > 1) runs.push(cur); cur = []; }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

/**
 * Suggestions from OSM data already projected to venue metres:
 * { areas: [{kind, name, points}], nodes: [{type: entrance|landmark|poi, name, label, kind?, x, y}],
 *   ways: [{name, points}] }.
 */
export function osmCandidates(data, venue) {
  const out = [];
  const entrances = data.nodes.filter((n) => n.type === 'entrance');
  const ways = data.ways.map((w) => w.points);
  if (venue.walk === 'open') {
    const opt = { others: data.areas.filter((a) => a.kind !== 'grass').map((a) => a.points), width: venue.width, height: venue.height };
    data.areas.forEach((a, i) => {
      const c = a.kind === 'building' ? wallCandidate(`o${i}`, a.name, a.points, entrances, ways, opt)
        : { key: `o${i}`, step: 3, type: 'obstacle', name: a.name, on: a.kind !== 'grass', item: { kind: a.kind, name: a.name, points: a.points } };
      if (a.conf != null && a.conf < UNSURE_CONF) c.doubt = true; // name read off the map image
      if (a.guess) Object.assign(c, { on: false, note: '依地圖上的字圈出，可能有錯，請確認' }); // a stray label's patch
      out.push(c);
    });
  }
  // roads are offered for both kinds of venue (open venues: drawn on the map and preferred by routes)
  data.ways.forEach((w, i) => insideRuns(w.points, venue).forEach((pts, j) => {
    out.push({ key: `w${i}.${j}`, step: 3, type: 'path', name: w.name, on: true, item: { points: pts, width: 3 } });
  }));
  data.nodes.filter((n) => n.type === 'poi').forEach((n, i) => {
    out.push({
      key: `p${i}`, step: 4, type: 'block', name: n.name, on: true,
      item: { name: n.name, kind: n.kind || guessKind(n.name), x: r1(n.x - 1.5), y: r1(n.y - 1.5), w: 3, h: 3 },
    });
  });
  const marks = [...entrances, ...data.nodes.filter((n) => n.type === 'landmark')];
  const taken = [];
  marks.forEach((n, i) => {
    if (taken.some((t) => Math.hypot(t.x - n.x, t.y - n.y) < 3) || taken.length >= 12) return;
    taken.push(n);
    const unsure = n.conf != null && n.conf < UNSURE_CONF; // label read off the map image
    out.push({ key: `a${i}`, step: 5, type: 'anchor', name: n.name || n.label, on: !unsure, ...(unsure ? { doubt: true } : {}), item: { name: n.name || n.label, x: r1(n.x), y: r1(n.y), landmark: n.label } });
  });
  return [...out, ...gridCandidate(venue, out)];
}

/**
 * Suggestions from the photo recognition result (canvas pixels). toM(x, y) maps canvas pixels to
 * venue metres, k is metres per canvas pixel.
 */
export function photoCandidates(result, toM, k, venue) {
  const out = [];
  const lines = result.graph?.lines || [];
  const seg = (L) => (L.a === 0 ? [toM(L.range[0], L.c), toM(L.range[1], L.c)] : [toM(L.c, L.range[0]), toM(L.c, L.range[1])]);
  const unsure = (o) => (o.conf ?? 100) < UNSURE_CONF;
  if (venue.walk === 'open') {
    const ways = lines.map(seg);
    const rects = result.objects.filter((o) => /^B/.test(o.id) && !o.box.open).map((o) => {
      const a = toM(o.box.x0, o.box.y0), b = toM(o.box.x1, o.box.y1);
      return rectPts(r1(a.x), r1(a.y), r1(b.x), r1(b.y));
    });
    const opt = { others: rects, width: venue.width, height: venue.height };
    result.objects.filter((o) => /^B/.test(o.id) && !o.box.open).forEach((o, i) => {
      const c = wallCandidate(`b${i}`, o.name, rects[i], [], ways, opt);
      if (unsure(o)) Object.assign(c, { on: false, doubt: true });
      else if (!BUILDING_NAME.test(o.name)) Object.assign(c, { on: false, note: '可能是區域，不是建築' });
      out.push(c);
    });
  } else {
    lines.forEach((L, i) => {
      const [p, q] = seg(L);
      const h = L.a === 0;
      out.push({
        key: `c${i}`, step: 3, type: 'corridor', name: `${h ? '橫' : '直'}向走道`, on: true,
        item: { axis: h ? 'h' : 'v', c: r1(h ? p.y : p.x), from: r1(h ? Math.min(p.x, q.x) : Math.min(p.y, q.y)), to: r1(h ? Math.max(p.x, q.x) : Math.max(p.y, q.y)), width: 3 },
      });
    });
  }
  result.objects.filter((o) => !o.box.open && !/^B/.test(o.id)).forEach((o, i) => {
    const a = toM(o.box.x0, o.box.y0), b = toM(o.box.x1, o.box.y1);
    out.push({
      key: `r${i}`, step: 4, type: 'block', name: o.name, on: !unsure(o), ...(unsure(o) ? { doubt: true } : {}),
      item: { name: o.name, kind: guessKind(o.name), x: r1(a.x), y: r1(a.y), w: r1(b.x - a.x), h: r1(b.y - a.y) },
    });
  });
  (result.anchors || []).forEach((a, i) => {
    const o = result.objects.find((x) => x.id === a.id);
    const p = toM(a.x, a.y);
    const bad = o && unsure(o);
    out.push({ key: `a${i}`, step: 5, type: 'anchor', name: a.name, on: !bad, ...(bad ? { doubt: true } : {}), item: { name: a.name, x: r1(p.x), y: r1(p.y) } });
  });
  return [...out, ...gridCandidate(venue, out)];
}

// ---------- anchors spread over the whole venue ----------
const GRID = { spacing: 5, min: 20, max: 6500, clear: 1, apart: 5 };

/** "旭陵樓北側": the nearest named obstacle (within 60 m) and which side of it p is on. */
function placeName(named, p) {
  let best = null;
  for (const o of named) {
    const d = pointInPolygon(p, o.points) ? 0 : nearestOnRing(o.points, p).dist;
    if (d <= 60 && (!best || d < best.d)) best = { o, d };
  }
  if (!best) return '';
  const P = best.o.points;
  const cx = P.reduce((s, q) => s + q.x, 0) / P.length, cy = P.reduce((s, q) => s + q.y, 0) / P.length;
  const dx = p.x - cx, dy = p.y - cy;
  return best.o.name + (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? '東側' : '西側') : dy > 0 ? '南側' : '北側');
}

/** Points along the roads every `step` metres (roads venues). */
function roadPoints(venue, step) {
  const lines = [
    ...venue.corridors.map((c) => (c.axis === 'h' ? [{ x: c.from, y: c.c }, { x: c.to, y: c.c }] : [{ x: c.c, y: c.from }, { x: c.c, y: c.to }])),
    ...(venue.paths || []).map((p) => p.points),
  ];
  const out = [];
  for (const L of lines) {
    let carry = step / 2;
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1], b = L[i], len = Math.hypot(b.x - a.x, b.y - a.y);
      let s = carry;
      for (; s <= len; s += step) {
        const q = { x: r1(a.x + ((b.x - a.x) * s) / len), y: r1(a.y + ((b.y - a.y) * s) / len) };
        if (!out.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < step / 2)) out.push(q);
      }
      carry = s - len;
    }
  }
  return out;
}

/**
 * Anchors about every `spacing` metres over the ground people can reach (open venues: outside
 * buildings, at least 1 m from obstacles, in the biggest connected open area; roads venues:
 * along the roads). Spacing shrinks to give at least `min` and grows to give at most `max`
 * points. Points within 5 m of `taken` are left out.
 * Returns { spacing, points: [{ x, y, name, landmark }] }.
 */
export function gridAnchors(venue, taken = [], opt = {}) {
  const { spacing: want, min, max, clear, apart } = { ...GRID, ...opt };
  let sample;
  if (venue.walk === 'open') {
    // connectivity uses the same grid as the export check (building walls block, floors do not),
    // so anchors placed here always pass it; buildings count as solid only for where anchors go:
    // outside, where people stand to look around
    const g = walkGrid(venue, 0.5);
    const { cols, rows, blocked } = g;
    const solid = walkGrid({ ...venue, obstacles: (venue.obstacles || []).map(({ shape, doors, ...o }) => o) }, 0.5).blocked;
    // the biggest connected open area
    const comp = new Int32Array(cols * rows), queue = new Int32Array(cols * rows), sizes = [0];
    for (let s0 = 0; s0 < cols * rows; s0++) {
      if (blocked[s0] || comp[s0]) continue;
      const id = sizes.length;
      let head = 0, tail = 0;
      queue[tail++] = s0;
      comp[s0] = id;
      while (head < tail) {
        const i = queue[head++], r = (i / cols) | 0, c = i - r * cols;
        for (const nb of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) {
          if (nb >= 0 && !blocked[nb] && !comp[nb]) { comp[nb] = id; queue[tail++] = nb; }
        }
      }
      let outside = 0;
      for (let q = 0; q < tail; q++) if (!solid[queue[q]]) outside++;
      sizes.push(outside);
    }
    const main = sizes.indexOf(Math.max(...sizes));
    const k = Math.round(clear / g.cell);
    const ok = (p) => {
      const c = Math.floor(p.x / g.cell), r = Math.floor(p.y / g.cell);
      if (c - k < 0 || r - k < 0 || c + k >= cols || r + k >= rows) return false;
      for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (comp[(r + dr) * cols + c + dc] !== main || solid[(r + dr) * cols + c + dc]) return false;
      return true;
    };
    sample = (sp) => {
      const pts = [];
      for (let y = sp / 2; y < venue.height; y += sp) {
        for (let x = sp / 2; x < venue.width; x += sp) {
          // the lattice point, or the nearest good spot within a third of the spacing
          let best = ok({ x, y }) ? { x, y } : null;
          for (let d = 1; !best && d <= sp / 3; d++) {
            for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
              if (ok({ x: x + dx, y: y + dy })) { best = { x: x + dx, y: y + dy }; break; }
            }
          }
          if (best) pts.push({ x: r1(best.x), y: r1(best.y) });
        }
      }
      return pts;
    };
  } else {
    sample = (sp) => roadPoints(venue, sp);
  }
  const keep = (pts) => pts.filter((p) => taken.every((t) => Math.hypot(t.x - p.x, t.y - p.y) >= apart));
  let spacing = want;
  let pts = keep(sample(spacing));
  for (let i = 0; i < 12 && pts.length < min && spacing > 2; i++) pts = keep(sample((spacing = r1(spacing * 0.8))));
  for (let i = 0; i < 12 && pts.length > max; i++) pts = keep(sample((spacing = r1(spacing * 1.25))));
  const named = obstaclePolygons(venue).filter((o) => o.name);
  const used = new Map();
  const points = pts.map((p, i) => {
    const base = placeName(named, p);
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const name = base ? (n > 1 ? `${base} ${n}` : base) : `定位點 ${i + 1}`;
    return { ...p, name, landmark: base || name };
  });
  return { spacing, points };
}

/** One review row for the whole set of spread-out anchors ([] when there is no room for any). */
function gridCandidate(venue, out) {
  const taken = [...out.filter((c) => c.type === 'anchor').map((c) => c.item), ...venue.anchors.filter((a) => !a.src)];
  const g = gridAnchors(venue, taken);
  if (!g.points.length) return [];
  return [{
    key: 'grid', step: 5, type: 'anchors', name: `每 ${g.spacing} 公尺一個定位點`, on: true,
    note: `共 ${g.points.length} 個，間距約 ${g.spacing} 公尺`, item: { points: g.points },
  }];
}

const STEP_LISTS = { 3: ['obstacles', 'corridors', 'paths'], 4: ['blocks'], 5: ['anchors'] };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Add the chosen suggestions of a step to the venue. Suggestions added earlier from the same
 * step (marked with src) are replaced, so importing twice does not duplicate them.
 */
export function applyCandidates(venue, step, chosen, src) {
  let v = { ...venue };
  for (const key of STEP_LISTS[step] || []) v[key] = (v[key] || []).filter((x) => !x.src);
  for (const c of chosen) {
    const it = c.item;
    if (c.type === 'obstacle') {
      const o = it.shape === 'wall' ? makeWall(v, it.points, it.name, it.doors) : makeObstacle(v, it.points, it.kind, it.name);
      if (o) v.obstacles = [...v.obstacles, { ...o, src }];
    } else if (c.type === 'corridor') {
      v.corridors = [...v.corridors, { id: nextId(v.corridors, 'C'), ...it, src }];
    } else if (c.type === 'path') {
      const P = makePath(v, it.points, it.width);
      if (P) v.paths = [...(v.paths || []), { ...P, src }];
    } else if (c.type === 'block') {
      const x = clamp(it.x, 0, v.width), y = clamp(it.y, 0, v.height);
      const w = Math.min(it.w, v.width - x), h = Math.min(it.h, v.height - y);
      if (w >= 0.5 && h >= 0.5) v.blocks = [...v.blocks, { id: nextId(v.blocks, 'B'), name: it.name, kind: it.kind, x, y, w, h, src }];
    } else if (c.type === 'anchor' || c.type === 'anchors') {
      // thousands of points (a 5 m grid): number them in one go instead of rescanning the list
      let n = +nextId(v.anchors, 'A').slice(1);
      const add = [];
      for (const p of c.type === 'anchors' ? it.points : [it]) {
        if (v.walk === 'open' && !isWalkable(v, p)) continue;
        const a = { id: 'A' + n++, name: p.name, x: p.x, y: p.y, src };
        if (p.landmark) a.landmark = p.landmark;
        add.push(a);
      }
      v.anchors = [...v.anchors, ...add];
    }
  }
  return v;
}
