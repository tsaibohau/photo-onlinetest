// Navigation state machine: movement only up/down/left/right along corridor lines.
import { isH, along, pointAt, project, nearestLine, nodesOnLine } from './geometry.js';

export const DIRS = ['up', 'right', 'down', 'left'];
export const opposite = (d) => DIRS[(DIRS.indexOf(d) + 2) % 4];

/**
 * Quantize a compass heading to one of 4 map directions relative to θ0
 * (the heading recorded while the user faced "map up"). Hysteresis keeps the
 * previous direction when the user walks diagonally.
 */
export function quantize(heading, theta0, prev = null, hysteresis = 35) {
  const rel = (((heading - theta0) % 360) + 360) % 360;
  const k = Math.round(rel / 90);
  const dev = Math.abs(rel - k * 90);
  if (dev > hysteresis && prev) return prev;
  return DIRS[k % 4];
}

const dirSign = (d) => (d === 'right' || d === 'down' ? 1 : -1);
const dirIsH = (d) => d === 'left' || d === 'right';
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

export const TURN_TOLERANCE_STEPS = 2;
export const AUTO_FLIP_BUMPS = 3;
export const EARLY_STEPS = 12;
export const DRIFT_WARNING_STEPS = 150;

export class Navigator {
  constructor(graph, calibration = {}) {
    this.graph = graph;
    this.lineById = new Map(graph.lines.map((L) => [L.id, L]));
    this.defaultPx = calibration.defaultPxPerStep || 10;
    this.scale = new Map((calibration.segments || []).map((s) => [s.line, s.pxPerStep]));
    this.flipped = false;
    this.state = null;
  }

  pxPerStep(L) {
    return this.scale.get(L.id) ?? this.defaultPx;
  }

  /** Start (or reset) at a point; it is snapped onto the nearest corridor. */
  start(p, lineId = null) {
    const L = lineId ? this.lineById.get(lineId) : nearestLine(this.graph.lines, p).line;
    const q = project(L, p);
    this.state = {
      x: q.x, y: q.y, line: L.id,
      bumps: 0, stepsSinceAnchor: 0,
      seg: { line: L.id, t0: q.t, signedSteps: 0 },
      lastDir: null,
    };
    return this.state;
  }

  /**
   * Reset at an anchor. If the user walked straight along one line since the
   * last fix, learn that line's px-per-step from the real step count (problem 1).
   */
  resetToAnchor(anchor) {
    let learned = null;
    const s = this.state;
    if (s && s.seg.line === anchor.line && s.seg.signedSteps !== 0) {
      const L = this.lineById.get(anchor.line);
      const dist = Math.abs(along(L, anchor) - s.seg.t0);
      if (dist > 0) {
        learned = { line: L.id, pxPerStep: dist / Math.abs(s.seg.signedSteps) };
        this.scale.set(L.id, learned.pxPerStep);
      }
    }
    this.start(anchor, anchor.line);
    return learned;
  }

  /** Reverse direction interpretation and re-compute the current segment (problem 2). */
  flip() {
    this.flipped = !this.flipped;
    const s = this.state;
    if (!s) return;
    const L = this.lineById.get(s.seg.line);
    s.seg.signedSteps = -s.seg.signedSteps;
    const t = clamp(s.seg.t0 + s.seg.signedSteps * this.pxPerStep(L), L.range);
    Object.assign(s, pointAt(L, t));
    s.bumps = 0;
    s.follow = null;
  }

  progress() {
    const s = this.state;
    const L = this.lineById.get(s.line);
    const len = L.range[1] - L.range[0];
    return len ? (along(L, s) - L.range[0]) / len : 0;
  }

  /** One detected step in map direction rawDir. Returns an event describing what happened. */
  step(rawDir) {
    const s = this.state;
    if (!s) return { type: 'notStarted' };
    const dir = this.flipped ? opposite(rawDir) : rawDir;
    s.lastDir = dir;
    s.stepsSinceAnchor++;
    let L = this.lineById.get(s.line);
    let type = 'moved';
    // After an automatic corner, keep following the path while the user keeps
    // walking the same way (e.g. "up" along an up-and-right curve).
    let follow = s.follow && s.follow.input === dir && s.follow.line === s.line ? s.follow : null;
    // …but as soon as a corridor actually goes the user's way, take it (a side street is
    // not a staircase curve).
    if (follow && dirIsH(dir) !== isH(L) && this.findTurn(L, dir)) follow = null;
    if (!follow) s.follow = null;

    if (!follow && dirIsH(dir) !== isH(L)) {
      const turn = this.findTurn(L, dir);
      if (!turn) {
        const alt = this.searchMove(dir);
        if (alt) return this.applySearch(alt, dir);
        s.stepsSinceAnchor--;
        return { type: 'ignored', dir };
      }
      s.x = turn.node.x;
      s.y = turn.node.y;
      s.line = turn.line.id;
      L = turn.line;
      s.seg = { line: L.id, t0: along(L, s), signedSteps: 0 };
      type = 'turned';
    }

    // Move one step; at a pure corner (only one way to continue, e.g. a curved path
    // approximated as a staircase) keep walking around the corner automatically.
    let remaining = this.pxPerStep(L);
    let sign = follow ? follow.sign : dirSign(dir);
    let travel = follow ? follow.travel : dir;
    let moved = false;
    for (let guard = 0; remaining > 1e-9 && guard < 50; guard++) {
      const before = along(L, s);
      const end = sign > 0 ? L.range[1] : L.range[0];
      const avail = Math.abs(end - before);
      if (avail >= remaining) {
        Object.assign(s, pointAt(L, before + sign * remaining));
        moved = true;
        break;
      }
      if (avail > 1e-9) moved = true;
      Object.assign(s, pointAt(L, end));
      remaining -= avail;
      const corner = this.cornerAt(L, s);
      if (!corner) break;
      // never carry the user backwards (pressing "up" must not end up walking "down")
      const nextTravel = isH(corner.line) ? (corner.sign > 0 ? 'right' : 'left') : corner.sign > 0 ? 'down' : 'up';
      if (nextTravel === opposite(dir)) break;
      L = corner.line;
      sign = corner.sign;
      travel = isH(L) ? (sign > 0 ? 'right' : 'left') : sign > 0 ? 'down' : 'up';
      s.line = L.id;
      s.seg = { line: L.id, t0: along(L, s), signedSteps: 0 };
      s.follow = { input: dir, line: L.id, sign, travel };
      type = 'followed';
    }
    s.seg.signedSteps += sign;

    if (!moved) {
      const alt = this.searchMove(dir);
      if (alt) return this.applySearch(alt, dir);
      // Only a possible "phone held backwards" if walking the other way would work;
      // a plain dead end is not evidence of a reversed phone.
      const back = this.searchMove(opposite(dir)) || this.canMove(L, -sign);
      // A reversed phone shows up right after a fix (start / anchor), not after a long
      // stretch of successful walking — later dead ends are just dead ends.
      if (!back || s.stepsSinceAnchor > EARLY_STEPS) return { type: 'bump', dir };
      s.bumps++;
      if (s.bumps >= AUTO_FLIP_BUMPS) {
        this.flip();
        return { type: 'autoFlip', dir };
      }
      return { type: 'bump', dir };
    }
    s.bumps = 0;
    return {
      type,
      dir,
      travel,
      drift: s.stepsSinceAnchor >= DRIFT_WARNING_STEPS,
    };
  }

  /** Is there room to move along L in direction sign from the current position? */
  canMove(L, sign) {
    const t = along(L, this.state);
    return sign > 0 ? t < L.range[1] - 1e-6 : t > L.range[0] + 1e-6;
  }

  /** Nodes on a line with their coordinate along it, sorted (cached). */
  sortedNodes(lineId) {
    this.nodeCache ??= new Map();
    if (!this.nodeCache.has(lineId)) {
      const L = this.lineById.get(lineId);
      this.nodeCache.set(lineId, nodesOnLine(this.graph, L).map((node) => ({ node, t: along(L, node) })));
    }
    return this.nodeCache.get(lineId);
  }

  /**
   * Fallback for winding paths: search the corridor network around the user (up to 3 steps
   * of path length) for the route that moves them furthest in direction dir, stopping once
   * they have advanced one step's worth. Returns {x, y, line, proj} or null.
   */
  searchMove(dir) {
    const s = this.state;
    const L0 = this.lineById.get(s.line);
    const pps = this.pxPerStep(L0);
    const budget = 5 * pps;
    const [vx, vy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    const proj = (p) => (p.x - s.x) * vx + (p.y - s.y) * vy;
    let best = null;
    let calls = 0;
    const consider = (p, line, used) => {
      const pr = proj(p);
      if (!best || pr > best.proj + 1e-6 || (Math.abs(pr - best.proj) < 1e-6 && used < best.used)) {
        best = { x: p.x, y: p.y, line, used, proj: pr };
      }
    };
    const dfs = (line, t, sign, used, visited) => {
      if (++calls > 3000) return;
      const L = this.lineById.get(line);
      const nodes = this.sortedNodes(line);
      const next = sign > 0 ? nodes.find((n) => n.t > t + 1e-6) : [...nodes].reverse().find((n) => n.t < t - 1e-6);
      const endT = next ? next.t : sign > 0 ? L.range[1] : L.range[0];
      const segLen = Math.abs(endT - t);
      if (segLen < 1e-9) return;
      const remaining = budget - used;
      const pr0 = proj(pointAt(L, t)), pr1 = proj(pointAt(L, endT));
      if (pr1 > pr0 && pr0 < pps && pr1 >= pps) {
        const tt = t + (endT - t) * ((pps - pr0) / (pr1 - pr0));
        if (Math.abs(tt - t) <= remaining) return consider(pointAt(L, tt), line, used + Math.abs(tt - t));
      }
      if (segLen >= remaining) return consider(pointAt(L, t + sign * remaining), line, budget);
      consider(pointAt(L, endT), line, used + segLen);
      if (!next || visited.has(next.node.id)) return;
      visited.add(next.node.id);
      for (const id of next.node.lines) {
        const M = this.lineById.get(id);
        if (!M) continue;
        const tm = along(M, next.node);
        for (const sg of [1, -1]) {
          if (id === line && sg !== sign) continue;
          dfs(id, tm, sg, used + segLen, visited);
        }
      }
      visited.delete(next.node.id);
    };
    // Start along every corridor through the current point (standing on a junction, the
    // way on may be a different corridor than the one we arrived on).
    const here = this.graph.nodes.find((n) => Math.abs(n.x - s.x) < 0.5 && Math.abs(n.y - s.y) < 0.5);
    const startLines = here ? here.lines : [L0.id];
    for (const id of startLines) {
      const L = this.lineById.get(id);
      if (!L) continue;
      const t0 = along(L, s);
      const seen = new Set(here ? [here.id] : []);
      dfs(id, t0, 1, 0, seen);
      dfs(id, t0, -1, 0, new Set(seen));
    }
    return best && best.proj >= 0.5 * pps ? best : null;
  }

  applySearch(alt, dir) {
    const s = this.state;
    s.x = alt.x;
    s.y = alt.y;
    s.line = alt.line;
    const L = this.lineById.get(alt.line);
    s.seg = { line: L.id, t0: along(L, s), signedSteps: 0 };
    s.follow = null;
    s.bumps = 0;
    return { type: 'followed', dir, travel: dir, drift: s.stepsSinceAnchor >= DRIFT_WARNING_STEPS };
  }

  /**
   * If point p is the end of L and exactly one other (perpendicular) corridor starts
   * there, return it with the direction (+1/-1) leading away from p.
   */
  cornerAt(L, p) {
    const node = this.graph.nodes.find((n) => Math.abs(n.x - p.x) < 0.5 && Math.abs(n.y - p.y) < 0.5);
    if (!node || node.lines.length !== 2) return null;
    const P = this.lineById.get(node.lines.find((id) => id !== L.id));
    if (!P || isH(P) === isH(L)) return null;
    const t = along(P, node);
    if (Math.abs(t - P.range[0]) < 0.5 && P.range[1] > P.range[0]) return { line: P, sign: 1 };
    if (Math.abs(t - P.range[1]) < 0.5 && P.range[1] > P.range[0]) return { line: P, sign: -1 };
    return null;
  }

  /** A junction on L within tolerance with a perpendicular corridor continuing in dir. */
  findTurn(L, dir) {
    const s = this.state;
    const tol = TURN_TOLERANCE_STEPS * this.pxPerStep(L);
    let best = null;
    for (const n of nodesOnLine(this.graph, L)) {
      const d = Math.abs(along(L, n) - along(L, s));
      if (d > tol) continue;
      for (const id of n.lines) {
        const P = this.lineById.get(id);
        if (!P || id === L.id || isH(P) === isH(L)) continue;
        const tn = along(P, n);
        const canGo = dirSign(dir) > 0 ? tn < P.range[1] : tn > P.range[0];
        if (canGo && (!best || d < best.d)) best = { node: n, line: P, d };
      }
    }
    return best;
  }
}
