// Outlines of map shapes (buildings, water, the site): trace a grid mask, simplify, and straighten
// walls along the map's main direction. Pure, no DOM. Building outlines are never saw-toothed:
// straight walls, or smooth curves (user rule, 2026-11-20).

export const bbox = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
};

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Ramer–Douglas–Peucker on a closed ring. */
export function simplifyRing(pts, eps) {
  if (pts.length < 4) return pts;
  // split at the two points farthest apart so both halves are open polylines
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const rdp = (a) => {
    if (a.length < 3) return a;
    const s = a[0], e = a[a.length - 1], L = Math.hypot(e.x - s.x, e.y - s.y) || 1;
    let idx = 0, md = -1;
    for (let i = 1; i < a.length - 1; i++) {
      const d = Math.abs((e.x - s.x) * (s.y - a[i].y) - (s.x - a[i].x) * (e.y - s.y)) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (md <= eps) return [s, e];
    const l = rdp(a.slice(0, idx + 1)), r = rdp(a.slice(idx));
    return [...l.slice(0, -1), ...r];
  };
  const A = rdp(pts.slice(0, far + 1)), B = rdp([...pts.slice(far), pts[0]]);
  return [...A.slice(0, -1), ...B.slice(0, -1)];
}

/** Outer boundary of a binary mask (Moore neighbour tracing), in cell corners. */
export function traceOuter(mask, w, h) {
  let start = -1;
  for (let i = 0; i < w * h && start < 0; i++) if (mask[i]) start = i;
  if (start < 0) return [];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  // Moore neighbourhood, clockwise from west
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const sx = start % w, sy = (start - sx) / w;
  const out = [{ x: sx, y: sy }];
  let x = sx, y = sy, dir = 0; // came from the west (the cell left of start is empty)
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8, nx = x + N[d][0], ny = y + N[d][1];
      if (on(nx, ny)) {
        x = nx; y = ny;
        dir = (d + 6) % 8; // back up two steps (start the next search just outside)
        found = true;
        break;
      }
    }
    if (!found || (x === sx && y === sy)) break;
    out.push({ x, y });
  }
  return out;
}


/**
 * The map's main building direction (radians, in [-45°, 45°)). Two steps:
 * 1. Which way the walls run: the turn at which the outlines pile up on the fewest straight lines along
 *    the two axes (projection profile, 1° steps). A wall stays one line however a label bites it into
 *    pieces and however the grid trace staircases it; level labels, notches and the image frame make
 *    short lines of their own that do not add up.
 * 2. How exactly: walls (RDP pieces, each measured by a line fitted through the traced outline, not by
 *    its chord) within 2° of that, length² weighted. Pieces far from it (labels, chords across notches)
 *    are left out instead of averaged in.
 */
export function mainAngle(polys) {
  const Q = Math.PI / 2, fold = (a) => a - Q * Math.round(a / Q); // 0°, 90°, 180°, 270° all the same
  polys = polys.filter((p) => p.length >= 3);
  if (!polys.length) return 0;
  // 1. projection profile: outline points every 1 px, 0.5 px bands, a Gaussian of 1.5 px (half a grid step)
  const sets = polys.map((poly) => {
    const xs = [], ys = [], ws = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b.x - a.x, b.y - a.y), k = Math.max(1, Math.ceil(L));
      for (let j = 0; j < k; j++) { xs.push(a.x + ((b.x - a.x) * (j + 0.5)) / k); ys.push(a.y + ((b.y - a.y) * (j + 0.5)) / k); ws.push(L / k); }
    }
    let mx = 0, my = 0, R = 0;
    for (let i = 0; i < xs.length; i++) { mx += xs[i]; my += ys[i]; }
    mx /= xs.length; my /= xs.length;
    for (let i = 0; i < xs.length; i++) { xs[i] -= mx; ys[i] -= my; R = Math.max(R, Math.hypot(xs[i], ys[i])); }
    return { xs, ys, ws, nb: Math.ceil(4 * R) + 4 };
  });
  const G = [];
  for (let k = -9; k <= 9; k++) G.push(Math.exp(-0.5 * ((k * 0.5) / 1.5) ** 2));
  const lineUp = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    let tot = 0;
    for (const { xs, ys, ws, nb } of sets) for (const along of [false, true]) {
      const h = new Float64Array(nb);
      for (let i = 0; i < xs.length; i++) {
        const v = (along ? xs[i] * c + ys[i] * s : ys[i] * c - xs[i] * s) * 2 + nb / 2, iv = Math.floor(v), f = v - iv;
        h[iv] += ws[i] * (1 - f);
        h[iv + 1] += ws[i] * f;
      }
      for (let k = 0; k < nb; k++) {
        if (!h[k]) continue;
        let a = 0;
        for (let j = -9; j <= 9; j++) if (k + j >= 0 && k + j < nb) a += G[j + 9] * h[k + j];
        tot += h[k] * a;
      }
    }
    return tot;
  };
  let theta = 0, best = -1;
  for (let d = -45; d < 45; d++) { const v = lineUp((d * Math.PI) / 180); if (v > best) { best = v; theta = (d * Math.PI) / 180; } }
  // 2. the walls near that direction, each measured by a line fitted through the outline between its corners
  let sx = 0, sy = 0;
  for (const raw of polys) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const q of raw) { bx0 = Math.min(bx0, q.x); by0 = Math.min(by0, q.y); bx1 = Math.max(bx1, q.x); by1 = Math.max(by1, q.y); }
    const pts = rdpRing(raw, Math.max(2, 0.06 * Math.min(bx1 - bx0, by1 - by0))); // measure walls, not the trace's wobble
    const at = new Map(raw.map((p, i) => [p, i])), n = raw.length;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 15) continue; // short wiggles say nothing about the direction
      const i0 = at.get(a);
      let i1 = at.get(b);
      if (i1 <= i0) i1 += n;
      let sw = 0, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = i0; i < i1; i++) { const p = raw[i % n], q = raw[(i + 1) % n], l = Math.hypot(q.x - p.x, q.y - p.y); sw += l; mx += (l * (p.x + q.x)) / 2; my += (l * (p.y + q.y)) / 2; }
      mx /= sw; my /= sw;
      for (let i = i0; i < i1; i++) {
        const p = raw[i % n], q = raw[(i + 1) % n], l = Math.hypot(q.x - p.x, q.y - p.y);
        const ax = p.x - mx, ay = p.y - my, cx = q.x - mx, cy = q.y - my;
        sxx += (l * (ax * ax + ax * cx + cx * cx)) / 3; syy += (l * (ay * ay + ay * cy + cy * cy)) / 3; sxy += (l * (2 * ax * ay + ax * cy + cx * ay + 2 * cx * cy)) / 6;
      }
      const d = fold(0.5 * Math.atan2(2 * sxy, sxx - syy) - theta);
      if (Math.abs(d) > (2 * Math.PI) / 180) continue;
      sx += L * L * Math.cos(4 * d);
      sy += L * L * Math.sin(4 * d);
    }
  }
  const t = sx || sy ? theta + Math.atan2(sy, sx) / 4 : theta;
  return t >= Math.PI / 4 ? t - Q : t < -Math.PI / 4 ? t + Q : t;
}

/**
 * Turn a traced outline into walls: buildings have straight walls (or smooth curves), never saw-teeth.
 * - Wobble smaller than the noise size goes (RDP).
 * - Edges within `snap` of the map's main directions become exactly parallel to them; a run of such
 *   edges becomes one wall.
 * - Walls shorter than the noise size (text notches, one-step jogs) are removed; two parallel walls
 *   left closer than the noise size merge into one.
 * - Runs of slanted edges that keep turning the same way are curves and stay.
 * The noise size scales with the building: 20% of its short side, between 6 and 16 px.
 */
export function regularize(pts, theta, { snap = (20 * Math.PI) / 180 } = {}) {
  if (pts.length < 3) return pts;
  const c = Math.cos(-theta), s = Math.sin(-theta);
  const rot = (p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  const back = (p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c });
  let P = pts.map(rot);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const noise = Math.min(16, Math.max(6, 0.2 * Math.min(x1 - x0, y1 - y0)));
  P = rdpRing(P, Math.max(2, noise * 0.35));

  const kind = (a, b) => {
    const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) % Math.PI;
    if (Math.min(ang, Math.PI - ang) <= snap) return 'h';
    if (Math.abs(ang - Math.PI / 2) <= snap) return 'v';
    return 'd';
  };
  // walls: { k, w (length), v (h: y, v: x, weighted sum), a, b }
  const toWalls = (Q) => {
    const W = [];
    for (let i = 0; i < Q.length; i++) {
      const a = Q[i], b = Q[(i + 1) % Q.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1e-6) continue;
      const k = kind(a, b);
      W.push({ k, w: L, v: L * (k === 'h' ? (a.y + b.y) / 2 : k === 'v' ? (a.x + b.x) / 2 : 0), a, b });
    }
    return W;
  };
  const pos = (e) => e.v / e.w;
  const mergeRuns = (W) => {
    // merge neighbours of the same axis class when they are the same wall (offset below noise)
    let changed = true;
    while (changed && W.length > 3) {
      changed = false;
      for (let i = 0; i < W.length && W.length > 3; i++) {
        const e = W[i], f = W[(i + 1) % W.length];
        if (e.k === 'd' || e.k !== f.k || Math.abs(pos(e) - pos(f)) >= noise) continue;
        e.w += f.w; e.v += f.v; e.b = f.b;
        W.splice((i + 1) % W.length, 1);
        changed = true;
      }
    }
    return W;
  };
  const isCurve = (W, i) => {
    // a slanted edge between two slanted edges turning the same way is part of a curve
    const n = W.length, p = W[(i - 1 + n) % n], e = W[i], q = W[(i + 1) % n];
    if (p.k !== 'd' || q.k !== 'd') return false;
    const cr = (u, v) => Math.sign((u.b.x - u.a.x) * (v.b.y - v.a.y) - (u.b.y - u.a.y) * (v.b.x - v.a.x));
    return cr(p, e) === cr(e, q) && cr(p, e) !== 0;
  };

  // a wall is noise when it is short, or when it is a slanted piece that only bites into one wall
  // (a V-shaped text notch: both neighbours on the same line) or cuts a small corner (between a
  // horizontal and a vertical wall, shorter than 1.5 × noise). Curve pieces are never noise.
  const droppable = (W, i) => {
    const e = W[i];
    if (isCurve(W, i)) return false;
    if (e.w < noise) return true;
    if (e.k !== 'd') return false;
    const n = W.length, p = W[(i - 1 + n) % n], q = W[(i + 1) % n];
    if (p.k === q.k && p.k !== 'd' && Math.abs(pos(p) - pos(q)) < noise) return true;
    if (p.k !== 'd' && q.k !== 'd' && p.k !== q.k && e.w < 1.5 * noise) return true;
    return false;
  };
  let W = mergeRuns(toWalls(P));
  for (let guard = 0; guard < 200 && W.length > 4; guard++) {
    // drop the shortest wall below the noise size (not a curve piece), then re-merge
    let idx = -1;
    for (let i = 0; i < W.length; i++) if (droppable(W, i) && (idx < 0 || W[i].w < W[idx].w)) idx = i;
    if (idx < 0) break;
    W.splice(idx, 1);
    W = mergeRuns(W);
  }

  // corners: where neighbouring walls meet
  const line = (e) => (e.k === 'h' ? { p: { x: 0, y: pos(e) }, d: { x: 1, y: 0 } } : e.k === 'v' ? { p: { x: pos(e), y: 0 }, d: { x: 0, y: 1 } } : { p: e.a, d: { x: e.b.x - e.a.x, y: e.b.y - e.a.y } });
  const meet = (e, f) => {
    const A = line(e), B = line(f);
    const den = A.d.x * B.d.y - A.d.y * B.d.x;
    if (Math.abs(den) < 1e-9 * Math.hypot(A.d.x, A.d.y) * Math.hypot(B.d.x, B.d.y) + 1e-12) return null;
    const t = ((B.p.x - A.p.x) * B.d.y - (B.p.y - A.p.y) * B.d.x) / den;
    return { x: A.p.x + A.d.x * t, y: A.p.y + A.d.y * t };
  };
  // distance from p to segment ab (the gap left between two walls after short walls were dropped)
  const segDist = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t); };
  const out = [];
  for (let i = 0; i < W.length; i++) {
    const e = W[i], f = W[(i + 1) % W.length];
    const q = meet(e, f);
    // accept the meeting point where the walls' gap is (short walls dropped in between), or near both walls;
    // nearly parallel walls meet far from both: a needle
    if (q && (segDist(q, e.b, f.a) <= noise || (Math.hypot(q.x - e.b.x, q.y - e.b.y) <= noise + 0.5 * e.w && Math.hypot(q.x - f.a.x, q.y - f.a.y) <= noise + 0.5 * f.w))) out.push(q);
    else if (e.k === f.k && e.k !== 'd') {
      // two parallel walls far enough apart: a real step between them
      if (e.k === 'h') out.push({ x: e.b.x, y: pos(e) }, { x: e.b.x, y: pos(f) });
      else out.push({ x: pos(e), y: e.b.y }, { x: pos(f), y: e.b.y });
    } else out.push(e.b, f.a);
  }
  // no needles, no small bites: drop corners sharper than 30° or whose triangle is tiny
  const area2 = (a, b, c2) => Math.abs((b.x - a.x) * (c2.y - a.y) - (b.y - a.y) * (c2.x - a.x));
  for (let guard = 0; guard < 100 && out.length > 3; guard++) {
    let worst = -1, ws = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c2 = out[(i + 1) % out.length];
      const ux = a.x - b.x, uy = a.y - b.y, vx = c2.x - b.x, vy = c2.y - b.y, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-6 || lv < 1e-6) { worst = i; ws = -1; break; }
      const ang = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
      const ar = area2(a, b, c2) / 2;
      const bad = ang < Math.PI / 6 ? ang : ar < 0.35 * noise * noise ? ar / (noise * noise) : Infinity;
      if (bad < ws) { ws = bad; worst = i; }
    }
    if (worst < 0 || ws === Infinity) break;
    out.splice(worst, 1);
  }
  const res = [];
  for (const p of out.map(back)) {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const l = res[res.length - 1];
    if (!l || Math.hypot(l.x - q.x, l.y - q.y) > 2) res.push(q);
  }
  if (res.length > 1 && Math.hypot(res[0].x - res[res.length - 1].x, res[0].y - res[res.length - 1].y) <= 2) res.pop();
  return res;
}

/** Ramer–Douglas–Peucker on a closed ring (split at the point farthest from the first). */
export function rdpRing(pts, eps) {
  if (pts.length < 4) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const rdp = (a) => {
    if (a.length < 3) return a;
    const s0 = a[0], e = a[a.length - 1], L = Math.hypot(e.x - s0.x, e.y - s0.y) || 1;
    let idx = 0, md = -1;
    for (let i = 1; i < a.length - 1; i++) {
      const d = Math.abs((e.x - s0.x) * (s0.y - a[i].y) - (s0.x - a[i].x) * (e.y - s0.y)) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (md <= eps) return [s0, e];
    const l = rdp(a.slice(0, idx + 1)), r = rdp(a.slice(idx));
    return [...l.slice(0, -1), ...r];
  };
  const A = rdp(pts.slice(0, far + 1)), B = rdp([...pts.slice(far), pts[0]]);
  return [...A.slice(0, -1), ...B.slice(0, -1)];
}

/** Nearest point on a closed outline. */
export function nearestOnRing(pts, d) {
  let bq = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], e = pts[(i + 1) % pts.length], dx = e.x - a.x, dy = e.y - a.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((d.x - a.x) * dx + (d.y - a.y) * dy) / L));
    const q = { x: a.x + dx * t, y: a.y + dy * t }, dd = Math.hypot(q.x - d.x, q.y - d.y);
    if (dd < bd) { bd = dd; bq = q; }
  }
  return { x: Math.round(bq.x), y: Math.round(bq.y), d: bd };
}

