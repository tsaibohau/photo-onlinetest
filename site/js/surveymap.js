// Walking survey → floor map. Someone walks along the walls of a building holding a phone; each
// step (length, heading) is recorded together with what they marked (doors, stairs, landmarks).
// This module turns that record into a clean floor: headings snapped to the building's right
// angles, loops closed, walls offset to the side they were walked on, gaps at doors, and finally
// an open-walk venue for the editor. Pure, no DOM. Metres, y down, headings clockwise from up.
import { angleDiff, meanAngle } from './pdr.js';
import { simplify } from './curves.js';
import { newVenue } from './venue.js';

/** Points after each step: [origin, after step 1, …]. */
export function trackPoints(steps, origin = { x: 0, y: 0 }) {
  const pts = [{ x: origin.x, y: origin.y }];
  let { x, y } = origin;
  for (const s of steps) {
    const r = (s.h * Math.PI) / 180;
    x += Math.sin(r) * s.len;
    y -= Math.cos(r) * s.len;
    pts.push({ x, y });
  }
  return pts;
}

/** Snap angle a to the building's grid: right angles from base, or 45° when close to one. */
function snapAngle(a, base) {
  const d = angleDiff(a, base);
  const k90 = Math.round(d / 90);
  if (Math.abs(d - 90 * k90) <= 25) return base + 90 * k90;
  const k45 = Math.round(d / 45);
  if (Math.abs(d - 45 * k45) <= 12) return base + 45 * k45;
  return a;
}

/** Split steps[lo..hi) into straight runs: a new run when the heading turns more than 30°. */
function splitRuns(steps, lo = 0, hi = steps.length) {
  const runs = [];
  let cur = null;
  for (let i = lo; i < hi; i++) {
    const h = steps[i].h;
    if (cur && Math.abs(angleDiff(h, meanAngle(cur.hs))) <= 30) {
      cur.hs.push(h);
      cur.to = i;
    } else {
      cur = { from: i, to: i, hs: [h] };
      runs.push(cur);
    }
  }
  for (const r of runs) r.mean = meanAngle(r.hs);
  return runs;
}

const MAX_DODGE_STEPS = 8; // a swerve around people longer than this is taken as a real turn

/**
 * Split the walk into straight runs (a new run when the heading turns more than 30° from the
 * run so far) and give every step of a run the run's direction snapped to the building grid.
 * A short swerve (≤ 8 steps, never more than 90° off) between two runs going the same way is
 * someone getting round people: it joins that run, and only its forward part counts as length.
 * base: the building's axis; by default the direction of the first run of 4+ steps.
 * Returns { headings, base, scale (length factor per step), detours: [{ from, to, lateral }] }.
 */
export function straightenHeadings(steps, opt = {}) {
  const runs = splitRuns(steps);
  const base = opt.base ?? (runs.find((r) => r.hs.length >= 4) || runs[0])?.mean ?? 0;
  for (const r of runs) r.dir = snapAngle(r.mean, base);
  const scale = new Array(steps.length).fill(1);
  const detours = [];
  const same = (a, b) => Math.abs(angleDiff(a, b)) < 0.5;
  for (let i = 1; i < runs.length - 1; i++) {
    const a = runs[i - 1];
    if (a.hs.length < 3) continue;
    let j = i, n = 0;
    while (j < runs.length && !same(runs[j].dir, a.dir) && n + runs[j].hs.length <= MAX_DODGE_STEPS && Math.abs(angleDiff(runs[j].mean, a.dir)) <= 90) {
      n += runs[j].hs.length;
      j++;
    }
    if (j === i || j >= runs.length || !same(runs[j].dir, a.dir) || runs[j].hs.length < 3) continue;
    let lat = 0, widest = 0;
    for (let k = runs[i].from; k <= runs[j - 1].to; k++) {
      const d = (angleDiff(steps[k].h, a.dir) * Math.PI) / 180;
      scale[k] = Math.max(0, Math.cos(d));
      lat += steps[k].len * Math.sin(d);
      widest = Math.max(widest, Math.abs(lat));
    }
    for (let k = i; k < j; k++) runs[k].dir = a.dir;
    detours.push({ from: runs[i].from, to: runs[j - 1].to, lateral: widest });
    i = j;
  }
  // a step or two taken while turning joins the run after it (no little diagonal at corners)
  runs.forEach((r, i) => {
    if (r.hs.length < 2 && runs.length > 1 && !detours.some((d) => r.from >= d.from && r.to <= d.to)) r.dir = (runs[i + 1] || runs[i - 1]).dir;
  });
  const headings = new Array(steps.length);
  for (const r of runs) for (let i = r.from; i <= r.to; i++) headings[i] = r.dir;
  return { headings, base, scale, detours };
}

/**
 * Width of a corridor from walking across it, wall to wall: steps[from..to) measured square to
 * the direction walked just before (the corridor's), plus `body` for standing half a body off
 * each wall. Rounded to 0.1 m.
 */
export function measureAcross(steps, from, to, body = 0.5) {
  const pts = trackPoints(steps.slice(from, to));
  const e = pts[pts.length - 1];
  const prev = steps.slice(Math.max(0, from - 6), from);
  let dist = Math.hypot(e.x, e.y);
  if (prev.length) {
    const a = (meanAngle(prev.map((s) => s.h)) * Math.PI) / 180;
    dist = Math.abs(e.x * -Math.cos(a) - e.y * Math.sin(a));
  }
  return Math.round((dist + body) * 10) / 10;
}

/**
 * Stairs between floors usually go: up a flight, across a landing, back up the other way. When
 * the walk since `from` ends like that (a run of 4+ steps, at most 4 steps and 2.5 m on the
 * landing, then 3+ steps the opposite way) return { start (step where the stairs probably
 * began), turn (first step back) }, else null. Turning round in a corridor looks the same, so
 * this is only ever a question to the user.
 */
export function detectStairTurn(steps, from = 0) {
  const runs = splitRuns(steps, Math.max(0, steps.length - 40));
  const last = runs[runs.length - 1];
  if (!last || last.hs.length < 3 || last.from < from) return null;
  let k = runs.length - 2, between = 0;
  while (k >= 0 && runs[k].hs.length < 4) { between += runs[k].hs.length; k--; }
  if (k < 0 || between > 4) return null;
  const r1 = runs[k];
  if (Math.abs(angleDiff(last.mean, r1.mean)) < 150) return null;
  const land = trackPoints(steps.slice(r1.to + 1, last.from));
  const e = land[land.length - 1];
  if (Math.hypot(e.x, e.y) > 2.5) return null;
  return { start: Math.max(r1.from, r1.to - 9), turn: last.from }; // a flight is about 10 treads
}

/**
 * Coming back to a marked spot ("loop" marks with ref = index of the earlier mark) shows how far
 * the estimate has drifted: spread that gap back over the steps in between, and shift the rest.
 */
export function closeLoops(points, marks) {
  let pts = points.map((p) => ({ ...p }));
  for (const m of marks) {
    if (m.kind !== 'loop' || marks[m.ref] == null) continue;
    const i0 = marks[m.ref].at, i1 = m.at;
    if (!(i1 > i0)) continue;
    const ex = pts[i1].x - pts[i0].x, ey = pts[i1].y - pts[i0].y;
    pts = pts.map((p, i) => {
      if (i <= i0) return p;
      const f = i >= i1 ? 1 : (i - i0) / (i1 - i0);
      return { x: p.x - ex * f, y: p.y - ey * f };
    });
  }
  return pts;
}

/**
 * Walls beside the walked line: points[from..to] moved `offset` metres to the wall's side.
 * A wall with side 'both' (walking down the middle of a corridor `width` wide) gives two lines,
 * left then right, each half the width away.
 */
export function wallLines(points, walls, offset = 0.5) {
  const out = [];
  for (const w of walls) {
    const run = dedupe(points.slice(w.from, w.to + 1));
    const sides = w.side === 'both' ? [1, -1] : [w.side === 'left' ? 1 : -1];
    const off = w.side === 'both' ? (w.width || 2) / 2 : offset;
    for (const sgn of sides) {
      out.push(run.map((p, i) => {
        const a = run[Math.max(0, i - 1)], b = run[Math.min(run.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
        // left of the walking direction (dx, dy) in y-down coordinates is (dy, −dx)
        return { x: p.x + (sgn * dy * off) / L, y: p.y - (sgn * dx * off) / L };
      }));
    }
  }
  return out.filter((l) => l.length >= 2);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-6) out.push(p);
  return out;
}

/** Arc-length position of the point of polyline L closest to p: { s, dist }. */
function project(L, p) {
  let best = { s: 0, dist: Infinity }, acc = 0;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len))) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best.dist) best = { s: acc + len * t, dist: d };
    acc += len;
  }
  return best;
}

/** The part of polyline L between arc lengths s0 and s1. */
function slice(L, s0, s1) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
    const at = (s) => ({ x: a.x + ((b.x - a.x) * (s - acc)) / (len || 1), y: a.y + ((b.y - a.y) * (s - acc)) / (len || 1) });
    if (acc + len >= s0 && acc <= s1) {
      if (!out.length) out.push(at(Math.max(s0, acc)));
      out.push(at(Math.min(s1, acc + len)));
    }
    acc += len;
  }
  return dedupe(out);
}

/**
 * Cut a gap `gap` metres wide into each wall line next to every door point: within `reach`
 * metres (a door's own `reach`, if it has one).
 */
export function cutDoors(lines, doors, gap = 1.2, reach = 1.5) {
  const out = [];
  for (const L of lines) {
    const total = L.slice(1).reduce((n, q, i) => n + Math.hypot(q.x - L[i].x, q.y - L[i].y), 0);
    const cuts = doors.map((d) => ({ d, p: project(L, d) })).filter(({ d, p }) => p.dist <= (d.reach ?? reach)).map(({ p }) => [p.s - gap / 2, p.s + gap / 2]).sort((a, b) => a[0] - b[0]);
    let s = 0;
    for (const [c0, c1] of cuts) {
      if (c0 > s) out.push(slice(L, s, c0));
      s = Math.max(s, c1);
    }
    if (s < total) out.push(slice(L, s, total));
  }
  return out.filter((l) => l.length >= 2 && l.slice(1).reduce((n, q, i) => n + Math.hypot(q.x - l[i].x, q.y - l[i].y), 0) >= 0.2);
}

/** Unit direction of the step that led to point `at`, and the unit vector to its left. */
function frameAt(steps, at) {
  const s = steps[Math.min(Math.max(at - 1, 0), steps.length - 1)];
  const r = (s.h * Math.PI) / 180;
  const d = { x: Math.sin(r), y: -Math.cos(r) };
  return { d, left: { x: d.y, y: -d.x } };
}

/** How far the wall on `side` is from the walked line at step `at`. */
function wallDistance(walls, at, side, opt) {
  const w = walls.find((x) => at >= x.from && at <= x.to);
  if (w?.side === 'both') return w.width / 2;
  if (w && w.side === side) return opt.offset ?? 0.5;
  return opt.corridorWidth ? opt.corridorWidth / 2 : opt.offset ?? 0.5;
}

/**
 * Rooms behind named doors, without walking into them: a room sits behind the wall on the door's
 * side, `roomDepth` deep, and reaches half way to the next named door on the same side of the
 * same straight run (at most 4 m either way, at least 2 m wide). It never covers anywhere that
 * was walked (it stops 0.6 m short), and is dropped if that leaves it under 1.5 m deep.
 */
function roomsOf(points, steps, walls, marks, opt) {
  if (!(opt.roomDepth > 0) || !steps.length) return [];
  const doors = marks.map((m, idx) => ({ ...m, idx })).filter((m) => m.kind === 'door' && m.name);
  const info = doors.map((m) => {
    const w = walls.find((x) => m.at >= x.from && m.at <= x.to);
    const side = m.side || (w && w.side !== 'both' ? w.side : null);
    if (!side) return null;
    const { d, left } = frameAt(steps, m.at);
    const n = side === 'left' ? left : { x: -left.x, y: -left.y };
    const k = Math.min(Math.max(m.at - 1, 0), steps.length - 1);
    let r0 = k, r1 = k;
    while (r0 > 0 && Math.abs(angleDiff(steps[r0 - 1].h, steps[k].h)) < 1) r0--;
    while (r1 < steps.length - 1 && Math.abs(angleDiff(steps[r1 + 1].h, steps[k].h)) < 1) r1++;
    const g = (p) => p.x * d.x + p.y * d.y; // position along the run
    return { m, side, d, n, o: points[m.at], g: g(points[m.at]), start: g(points[r0]), end: g(points[r1 + 1]), key: `${r0}:${side}`, front: wallDistance(walls, m.at, side, opt) };
  }).filter(Boolean);
  const rooms = [];
  for (const r of info) {
    const along = info.filter((x) => x.key === r.key && x !== r).map((x) => x.g);
    const prev = Math.max(-Infinity, ...along.filter((v) => v < r.g));
    const next = Math.min(Infinity, ...along.filter((v) => v > r.g));
    let lo = prev > -Infinity ? (prev + r.g) / 2 : Math.max(r.start, r.g - 4);
    let hi = next < Infinity ? (next + r.g) / 2 : Math.min(r.end, r.g + 4);
    if (hi - lo < 2) { lo = Math.min(lo, r.g - 1); hi = Math.max(hi, r.g + 1); }
    let depth = opt.roomDepth;
    for (const p of points) {
      const gp = p.x * r.d.x + p.y * r.d.y;
      if (gp <= lo + 1e-9 || gp >= hi - 1e-9) continue;
      const v = (p.x - r.o.x) * r.n.x + (p.y - r.o.y) * r.n.y;
      if (v > r.front + 1e-9) depth = Math.min(depth, v - r.front - 0.6);
    }
    if (depth < 1.5) continue;
    const at = (s, off) => ({ x: r.o.x + r.d.x * (s - r.g) + r.n.x * off, y: r.o.y + r.d.y * (s - r.g) + r.n.y * off });
    rooms.push({ name: r.m.name, idx: r.m.idx, at: r.m.at, points: [at(lo, r.front), at(hi, r.front), at(hi, r.front + depth), at(lo, r.front + depth)] });
  }
  return rooms;
}

/**
 * One floor's record → its geometry in the survey frame:
 * { label, base, points (track), walls (polylines), wallOf, marks: [{ kind, name, x, y, at, idx }],
 *   rooms: [{ name, points }], warnings: [text] }.
 * floor: { label, origin?, steps: [{h, len}], walls: [{side, from, to, width?}],
 *          marks: [{kind, at, name?, side?, ref?}] }
 * opt: { straighten, base, offset, roomDepth, corridorWidth }
 */
export function buildFloor(floor, opt = {}) {
  const straight = opt.straighten !== false;
  const { headings, base, scale, detours } = straightenHeadings(floor.steps, opt);
  const steps = straight ? floor.steps.map((s, i) => ({ ...s, h: headings[i], len: s.len * scale[i] })) : floor.steps;
  const points = closeLoops(trackPoints(steps, floor.origin || { x: 0, y: 0 }), floor.marks);
  // a wall still being walked (no end yet) runs to the last step
  const walls = floor.walls.map((w) => ({ ...w, to: w.to ?? steps.length }));
  const inWall = (at) => walls.some((x) => at >= x.from && at <= x.to);
  // each wall is cut at the doors marked while it was being walked (or, for doors marked while
  // not walking a wall, at the nearest wall); a door on a known side only cuts that side
  const doors = floor.marks.filter((m) => m.kind === 'door');
  const cut = [], wallOf = [];
  walls.forEach((w, i) => {
    const lines = wallLines(points, [w], opt.offset ?? 0.5);
    lines.forEach((L, li) => {
      const side = w.side === 'both' ? (li === 0 ? 'left' : 'right') : w.side;
      const own = doors.filter((d) => ((d.at >= w.from && d.at <= w.to) || !inWall(d.at)) && (!d.side || d.side === side));
      const pts = own.map((d) => {
        if (w.side !== 'both') return points[d.at];
        if (!d.side || !steps.length) return { ...points[d.at], reach: w.width / 2 + 0.2 };
        const { left } = frameAt(steps, d.at), k = (side === 'left' ? 1 : -1) * (w.width / 2);
        return { x: points[d.at].x + left.x * k, y: points[d.at].y + left.y * k, reach: 0.6 };
      });
      for (const piece of cutDoors([L], pts)) { cut.push(piece); wallOf.push(i); }
    });
  });
  const marks = floor.marks.map((m, idx) => ({ m, idx })).filter(({ m }) => m.kind !== 'loop').map(({ m, idx }) => ({ kind: m.kind, name: m.name || '', at: m.at, idx, ...points[m.at] }));
  const rooms = roomsOf(points, steps, walls, floor.marks, opt);
  // swerving round people further than the corridor is wide: the width was probably measured short
  const warnings = [];
  for (const w of walls) {
    if (w.side !== 'both') continue;
    const d = detours.find((x) => x.to >= w.from && x.from <= w.to && x.lateral > w.width - 0.4);
    if (d) warnings.push(`走道寬度 ${w.width} m 可能太窄：第 ${d.from} 步附近閃避時往旁邊移了 ${d.lateral.toFixed(1)} m，建議重量一次`);
  }
  return { label: floor.label, base, points, walls: cut, wallOf, marks, rooms, warnings };
}

/** All floors in one frame: a floor with link { floor, at } starts where that floor's walk was at step `at`. */
export function buildFloors(floors, opt = {}) {
  const built = [];
  for (const f of floors) {
    const origin = f.link ? built[f.link.floor].points[Math.min(f.link.at, built[f.link.floor].points.length - 1)] : f.origin || { x: 0, y: 0 };
    built.push(buildFloor({ ...f, origin }, { ...opt, base: built[0]?.base ?? opt.base }));
  }
  return built;
}

/**
 * The photo → map transform from two matching points (src in photo pixels {u, v}, dst in metres
 * {x, y}): turn, scale and shift, no mirroring. Returns { ar, ai, bx, by, scale, apply }.
 */
export function similarity(src, dst) {
  const [w1, w2] = src, [z1, z2] = dst;
  const du = w2.u - w1.u, dv = w2.v - w1.v, dx = z2.x - z1.x, dy = z2.y - z1.y;
  const den = du * du + dv * dv || 1;
  const ar = (dx * du + dy * dv) / den, ai = (dy * du - dx * dv) / den;
  const bx = z1.x - (ar * w1.u - ai * w1.v), by = z1.y - (ai * w1.u + ar * w1.v);
  return { ar, ai, bx, by, scale: Math.hypot(ar, ai), apply: (w) => ({ x: ar * w.u - ai * w.v + bx, y: ai * w.u + ar * w.v + by }) };
}

const MARK_NAMES = { door: '門', stairs: '樓梯', elevator: '電梯', landmark: '地標' };

/**
 * A built floor → open-walk venue (the editor's format): turned so the building's axis points up,
 * walls as thin wall-only obstacles, rooms as named room blocks, marks as anchors, the walked
 * line as a preferred path.
 */
export function floorToVenue(built, title, opt = {}) {
  const th = (-(built.base || 0) * Math.PI) / 180;
  const rot = (p) => ({ x: p.x * Math.cos(th) - p.y * Math.sin(th), y: p.x * Math.sin(th) + p.y * Math.cos(th) });
  const track = built.points.map(rot);
  const walls = built.walls.map((L) => L.map(rot));
  const marks = built.marks.map((m) => ({ ...m, ...rot(m) }));
  const rooms = (built.rooms || []).map((r) => ({ ...r, points: r.points.map(rot) }));
  const all = [...track, ...walls.flat(), ...marks, ...rooms.flatMap((r) => r.points)];
  const M = opt.margin ?? 2;
  const x0 = Math.min(...all.map((p) => p.x)) - M, y0 = Math.min(...all.map((p) => p.y)) - M;
  const x1 = Math.max(...all.map((p) => p.x)) + M, y1 = Math.max(...all.map((p) => p.y)) + M;
  const r2 = (v) => Math.round(v * 100) / 100;
  const at = (p) => ({ x: r2(p.x - x0), y: r2(p.y - y0) });
  const v = newVenue(title, Math.ceil(x1 - x0), Math.ceil(y1 - y0), 'open');
  v.mapStyle = 'plain';
  // a wall drawn as a there-and-back outline: only its line blocks, and it has no inside
  v.obstacles = walls.map((L, i) => {
    const pts = simplify(L.map(at), 0.05).map(at0);
    return { id: `O${i + 1}`, kind: 'building', name: '', shape: 'wall', doors: [], points: [...pts, ...pts.slice(1, -1).reverse()] };
  });
  // rooms square to the map (the usual case once straightened) become room blocks
  for (const r of rooms) {
    const q = r.points.map(at);
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const square = q.every((p) => (Math.abs(p.x - bx0) < 0.05 || Math.abs(p.x - bx1) < 0.05) && (Math.abs(p.y - by0) < 0.05 || Math.abs(p.y - by1) < 0.05));
    if (square) v.blocks.push({ id: `B${v.blocks.length + 1}`, name: r.name, kind: 'room', x: r2(bx0), y: r2(by0), w: r2(bx1 - bx0), h: r2(by1 - by0) });
  }
  const count = {};
  v.anchors = marks.map((m, i) => {
    let name = m.name;
    if (!name) {
      count[m.kind] = (count[m.kind] || 0) + 1;
      const base = MARK_NAMES[m.kind] || '定位點';
      name = m.kind === 'door' || m.kind === 'landmark' ? `${base} ${count[m.kind]}` : count[m.kind] > 1 ? `${base} ${count[m.kind]}` : base;
    }
    return { id: `A${i + 1}`, name, landmark: name, ...at(m) };
  });
  if (v.anchors.length < 2 && track.length > 1) {
    v.anchors.push({ id: `A${v.anchors.length + 1}`, name: '起點', landmark: '起點', ...at(track[0]) });
    v.anchors.push({ id: `A${v.anchors.length + 1}`, name: '終點', landmark: '終點', ...at(track[track.length - 1]) });
  }
  const line = simplify(dedupe(track.map(at)), 0.3).map(at0);
  if (line.length >= 2) v.paths = [{ id: 'P1', points: line, width: 0.6 }]; // thin: drawn under the walls, which sit 0.5 m away
  return v;
}
const at0 = (p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
