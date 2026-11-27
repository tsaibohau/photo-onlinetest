// PhotoPath geometry: corridors are linear equations a·x + b·y = c,
// restricted to horizontal (a=0,b=1 → y=c) or vertical (a=1,b=0 → x=c).
// Coordinates: origin top-left, x right, y down, unit = map pixels.

export function hLine(id, y, x0, x1) {
  return { id, a: 0, b: 1, c: y, range: [Math.min(x0, x1), Math.max(x0, x1)] };
}

export function vLine(id, x, y0, y1) {
  return { id, a: 1, b: 0, c: x, range: [Math.min(y0, y1), Math.max(y0, y1)] };
}

export const isH = (L) => L.a === 0;

export const lineLength = (L) => L.range[1] - L.range[0];

/** Coordinate along the line's free axis (x for horizontal, y for vertical). */
export const along = (L, p) => (isH(L) ? p.x : p.y);

/** Point on line L at free-axis coordinate t. */
export const pointAt = (L, t) => (isH(L) ? { x: t, y: L.c } : { x: L.c, y: t });

export function inRange(L, x, y, tol = 0) {
  const v = isH(L) ? x : y;
  return v >= L.range[0] - tol && v <= L.range[1] + tol;
}

/** Intersection of two corridors by Cramer's rule; null if parallel or outside ranges. */
export function intersect(L1, L2, tol = 0) {
  const D = L1.a * L2.b - L2.a * L1.b;
  if (D === 0) return null;
  const x = (L1.c * L2.b - L2.c * L1.b) / D;
  const y = (L1.a * L2.c - L2.a * L1.c) / D;
  if (!inRange(L1, x, y, tol) || !inRange(L2, x, y, tol)) return null;
  return { x, y };
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** Project point p onto line L (clamped to its range). */
export function project(L, p) {
  const t = clamp(along(L, p), L.range);
  const q = pointAt(L, t);
  return { ...q, t, dist: Math.hypot(q.x - p.x, q.y - p.y) };
}

export function nearestLine(lines, p) {
  let best = null;
  for (const L of lines) {
    const q = project(L, p);
    if (!best || q.dist < best.dist) best = { line: L, ...q };
  }
  return best;
}

/**
 * Build the corridor graph: nodes are intersections (junctions) and line endpoints,
 * edges connect consecutive nodes along each line. With tol > 0, lines that stop
 * just short of a crossing line are extended to meet it.
 */
/**
 * Merge corridors that lie on the same straight line and touch or overlap (within gap):
 * a path traced in pieces (x=625 [1238,1318] + x=625 [1223,1238]) becomes one corridor,
 * so walking straight on does not stop at every joint.
 */
export function mergeCollinear(lines, gap = 0.5, cTol = 0.5) {
  const out = [];
  for (const a of [0, 1]) {
    // sort by position, then cluster pieces whose offset is within cTol (tracing jitter)
    const list = lines.filter((L) => L.a === a).map((L) => ({ ...L, range: [...L.range] })).sort((p, q) => p.c - q.c);
    const clusters = [];
    for (const L of list) {
      const cl = clusters.find((k) => Math.abs(k.c - L.c) <= cTol &&
        k.items.some((M) => L.range[0] <= M.range[1] + gap && M.range[0] <= L.range[1] + gap));
      if (cl) { cl.items.push(L); cl.c = cl.items.reduce((s, M) => s + M.c * (M.range[1] - M.range[0] + 1), 0) / cl.items.reduce((s, M) => s + (M.range[1] - M.range[0] + 1), 0); }
      else clusters.push({ c: L.c, items: [L] });
    }
    for (const cl of clusters) {
      const items = cl.items.sort((p, q) => p.range[0] - q.range[0]);
      let cur = null;
      for (const L of items) {
        if (cur && L.range[0] <= cur.range[1] + gap) cur.range[1] = Math.max(cur.range[1], L.range[1]);
        else { if (cur) out.push(cur); cur = { ...L, c: cl.c, range: [...L.range] }; }
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

export function buildGraph(inputLines, tol = 0) {
  // pieces offset by less than the snapping tolerance are one corridor (tracing jitter)
  const jitter = Math.min(Math.max(0.5, tol), 8);
  const lines = mergeCollinear(inputLines, jitter, jitter).map((L) => ({ ...L, range: [...L.range] }));
  const nodes = [];
  const addNode = (x, y, lineIds) => {
    let n = nodes.find((m) => Math.abs(m.x - x) < 0.5 && Math.abs(m.y - y) < 0.5);
    if (!n) {
      n = { id: `N${nodes.length + 1}`, x, y, lines: [] };
      nodes.push(n);
    }
    for (const id of lineIds) if (!n.lines.includes(id)) n.lines.push(id);
    return n;
  };
  const extendTo = (L, p) => {
    const t = along(L, p);
    L.range[0] = Math.min(L.range[0], t);
    L.range[1] = Math.max(L.range[1], t);
  };

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = intersect(lines[i], lines[j], tol);
      if (!p) continue;
      extendTo(lines[i], p);
      extendTo(lines[j], p);
      addNode(p.x, p.y, [lines[i].id, lines[j].id]);
    }
  }
  for (const L of lines) {
    for (const t of L.range) {
      const p = pointAt(L, t);
      addNode(p.x, p.y, [L.id]);
    }
  }

  const edges = [];
  for (const L of lines) {
    const on = nodesOnLine({ nodes }, L);
    for (let k = 1; k < on.length; k++) {
      edges.push({
        from: on[k - 1].id,
        to: on[k].id,
        line: L.id,
        lengthPx: Math.abs(along(L, on[k]) - along(L, on[k - 1])),
      });
    }
  }
  return { lines, nodes, edges };
}

/** Nodes lying on line L, sorted along it. */
export function nodesOnLine(graph, L) {
  return graph.nodes
    .filter((n) => n.lines.includes(L.id))
    .sort((m, n) => along(L, m) - along(L, n));
}

/** Map nodeId → component index (union-find over edges). */
export function components(graph) {
  const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
  const find = (a) => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)));
      a = parent.get(a);
    }
    return a;
  };
  for (const e of graph.edges) parent.set(find(e.from), find(e.to));
  return new Map(graph.nodes.map((n) => [n.id, find(n.id)]));
}

export function isConnected(graph) {
  if (graph.nodes.length === 0) return false;
  return new Set(components(graph).values()).size === 1;
}

/** True when every anchor sits on a line belonging to the same connected component. */
export function anchorsReachable(graph, anchors) {
  if (anchors.length === 0) return false;
  const comp = components(graph);
  const roots = new Set();
  for (const a of anchors) {
    const n = graph.nodes.find((m) => m.lines.includes(a.line));
    if (!n) return false;
    roots.add(comp.get(n.id));
  }
  return roots.size === 1;
}

/** Keep only the connected part of the graph with the most corridor length. */
export function largestPart(graph, tol = 0) {
  if (!graph.lines.length || isConnected(graph)) return graph;
  const comp = components(graph);
  const nodeComp = new Map(graph.nodes.map((n) => [n.id, comp.get(n.id)]));
  const len = new Map();
  const lineComp = new Map();
  for (const L of graph.lines) {
    const n = graph.nodes.find((m) => m.lines.includes(L.id));
    const c = n ? nodeComp.get(n.id) : null;
    lineComp.set(L.id, c);
    len.set(c, (len.get(c) || 0) + lineLength(L));
  }
  let best = null;
  for (const [c, l] of len) if (best === null || l > len.get(best)) best = c;
  return buildGraph(graph.lines.filter((L) => lineComp.get(L.id) === best), tol);
}
