// Curved paths (polylines) next to the straight corridors (a·x + b·y = c).
// A path is { id, points: [{x,y}, …] }. Curves are for display, snapping and route
// connectivity; step-by-step dead reckoning (nav.js) still only runs on straight corridors
// and simply ignores ids it does not know.
import { buildGraph, nodesOnLine, project, isH } from './geometry.js';

/** Ramer–Douglas–Peucker simplification (eps in the points' units). */
export function simplify(points, eps) {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const a = points[0];
  const b = points[points.length - 1];
  let worst = -1;
  let wi = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segDist(points[i], a, b).dist;
    if (d > worst) { worst = d; wi = i; }
  }
  if (worst <= eps) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const left = simplify(points.slice(0, wi + 1), eps);
  const right = simplify(points.slice(wi), eps);
  return [...left.slice(0, -1), ...right];
}

/** Closest point on segment ab to p; u ∈ [0,1] is the position along ab. */
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const u = L2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  const x = a.x + u * dx, y = a.y + u * dy;
  return { x, y, u, dist: Math.hypot(p.x - x, p.y - y) };
}

export function pathLength(P) {
  let s = 0;
  for (let i = 1; i < P.points.length; i++) s += Math.hypot(P.points[i].x - P.points[i - 1].x, P.points[i].y - P.points[i - 1].y);
  return s;
}

/** Closest point on a path; s is the arc length from the first point. */
export function projectPath(P, p) {
  let best = null;
  let acc = 0;
  for (let i = 1; i < P.points.length; i++) {
    const a = P.points[i - 1], b = P.points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const q = segDist(p, a, b);
    if (!best || q.dist < best.dist) best = { x: q.x, y: q.y, dist: q.dist, s: acc + q.u * len };
    acc += len;
  }
  return best;
}

/** Nearest point on any straight corridor or curved path: {x, y, dist, id, kind}. */
export function nearestOnNetwork(lines = [], paths = [], p) {
  let best = null;
  for (const L of lines) {
    const q = project(L, p);
    if (!best || q.dist < best.dist) best = { x: q.x, y: q.y, dist: q.dist, id: L.id, kind: 'line' };
  }
  for (const P of paths) {
    if (P.points.length < 2) continue;
    const q = projectPath(P, p);
    if (!best || q.dist < best.dist) best = { x: q.x, y: q.y, dist: q.dist, id: P.id, kind: 'path' };
  }
  return best;
}

const lineSeg = (L) => (isH(L)
  ? [{ x: L.range[0], y: L.c }, { x: L.range[1], y: L.c }]
  : [{ x: L.c, y: L.range[0] }, { x: L.c, y: L.range[1] }]);

/** Intersection point of segments ab and cd (inclusive), or null. */
function segCross(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/**
 * Corridor graph with curved paths. Straight corridors are built exactly as before
 * (buildGraph); curve endpoints within tol of another corridor/curve are snapped onto it,
 * crossings become junction nodes, and edges are split at every junction.
 * Returns { lines, paths, nodes, edges }.
 */
export function buildNetwork(inputLines, inputPaths = [], tol = 0) {
  const g = buildGraph(inputLines, tol);
  const lines = g.lines;
  const paths = inputPaths
    .filter((P) => P.points.length >= 2)
    .map((P) => ({ ...P, points: P.points.map((q) => ({ x: q.x, y: q.y })) }));
  if (!paths.length) return { ...g, paths: [] };

  const nodes = g.nodes.map((n) => ({ ...n, lines: [...n.lines] }));
  let seq = nodes.length;
  const addNode = (x, y, ids) => {
    let n = nodes.find((m) => Math.abs(m.x - x) < 0.5 && Math.abs(m.y - y) < 0.5);
    if (!n) {
      n = { id: `N${++seq}`, x, y, lines: [] };
      nodes.push(n);
    }
    for (const id of ids) if (!n.lines.includes(id)) n.lines.push(id);
    return n;
  };

  // 1. snap curve endpoints onto a nearby corridor or curve
  for (const P of paths) {
    for (const end of [0, P.points.length - 1]) {
      const others = paths.filter((Q) => Q !== P);
      const n = nearestOnNetwork(lines, others, P.points[end]);
      if (n && n.dist <= tol) {
        P.points[end] = { x: n.x, y: n.y };
        addNode(n.x, n.y, [P.id, n.id]);
      }
    }
  }

  // 2. crossings with straight corridors and with other curves
  for (const P of paths) {
    for (let i = 1; i < P.points.length; i++) {
      const a = P.points[i - 1], b = P.points[i];
      for (const L of lines) {
        const [c, d] = lineSeg(L);
        const x = segCross(a, b, c, d);
        if (x) addNode(isH(L) ? x.x : L.c, isH(L) ? L.c : x.y, [P.id, L.id]);
      }
    }
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const P = paths[i], Q = paths[j];
      for (let a = 1; a < P.points.length; a++) {
        for (let b = 1; b < Q.points.length; b++) {
          const x = segCross(P.points[a - 1], P.points[a], Q.points[b - 1], Q.points[b]);
          if (x) addNode(x.x, x.y, [P.id, Q.id]);
        }
      }
    }
  }

  // 3. curve ends are nodes too
  for (const P of paths) {
    for (const q of [P.points[0], P.points[P.points.length - 1]]) addNode(q.x, q.y, [P.id]);
  }

  // 4. edges: straight corridors split at all their nodes, curves by arc length
  const edges = [];
  for (const L of lines) {
    const on = nodesOnLine({ nodes }, L);
    for (let k = 1; k < on.length; k++) {
      const len = Math.abs((isH(L) ? on[k].x - on[k - 1].x : on[k].y - on[k - 1].y));
      if (len > 0) edges.push({ from: on[k - 1].id, to: on[k].id, line: L.id, lengthPx: len });
    }
  }
  for (const P of paths) {
    const on = nodes
      .filter((n) => n.lines.includes(P.id))
      .map((n) => ({ n, s: projectPath(P, n).s }))
      .sort((p, q) => p.s - q.s);
    for (let k = 1; k < on.length; k++) {
      const len = on[k].s - on[k - 1].s;
      if (len > 0) edges.push({ from: on[k - 1].n.id, to: on[k].n.id, line: P.id, lengthPx: len });
    }
  }
  return { lines, paths, nodes, edges };
}
