// Map editor data model. Everything here is in metres; no DOM, so it runs in Node tests.
// A venue is drawn by hand (optionally traced over a photo) and turned into a normal .phop:
// the corridors are still horizontal/vertical lines a·x + b·y = c, just in real units.
import { hLine, vLine, isConnected, anchorsReachable } from './geometry.js';
import { buildNetwork, nearestOnNetwork, simplify, pathLength } from './curves.js';
import { obstaclePolygons, isWalkable, walkGrid, allReachable, unreachablePoints, nearestOnRing, pointInPolygon, groundParts } from './walkable.js';

export const GRID_M = 0.5; // snapping grid
export const JOIN_M = 1; // a new corridor this close to a parallel one joins its line
export const MIN_CORRIDOR_M = 1;
export const STEP_M = 0.7; // average step length used for the default scale
export const MAX_PX = 4096;
export const PREFERRED_PPM = 20;

export const KINDS = {
  booth: { label: '攤位', color: '#fde68a', stroke: '#d97706' },
  room: { label: '房間', color: '#e0e7ff', stroke: '#6366f1' },
  entrance: { label: '入口', color: '#bbf7d0', stroke: '#16a34a' },
  info: { label: '服務台', color: '#bae6fd', stroke: '#0284c7' },
  restroom: { label: '洗手間', color: '#e9d5ff', stroke: '#9333ea' },
  stage: { label: '舞台', color: '#fecaca', stroke: '#dc2626' },
  other: { label: '其他', color: '#e2e8f0', stroke: '#64748b' },
};

/** Areas people can't walk through in open-walk venues (blocks other than entrances count too). */
export const OBSTACLE_KINDS = {
  grass: { label: '草地', color: '#bbf7d0', stroke: '#16a34a' },
  trees: { label: '樹林', color: '#86efac', stroke: '#15803d' },
  water: { label: '水池', color: '#bae6fd', stroke: '#0284c7' },
  building: { label: '建築', color: '#d1d5db', stroke: '#4b5563' },
  other: { label: '不能走', color: '#fee2e2', stroke: '#dc2626', hatch: true },
};

/** walk: 'open' = walk anywhere except obstacles; 'roads' = only along the drawn corridors. */
export function newVenue(title = '我的場地', width = 30, height = 20, walk = 'roads') {
  return { version: 1, title, width, height, walk, corridors: [], paths: [], blocks: [], anchors: [], obstacles: [] };
}

/** Fill in fields missing from drafts saved by older editor versions. */
export function upgradeVenue(v) {
  return { ...v, walk: v.walk || 'roads', paths: v.paths || [], obstacles: v.obstacles || [] };
}

export const snap = (v, step = GRID_M) => Math.round(v / step) * step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function nextId(list, prefix) {
  let n = 0;
  for (const it of list) {
    const m = String(it.id).match(/(\d+)$/);
    if (m) n = Math.max(n, +m[1]);
  }
  return `${prefix}${n + 1}`;
}

/** Corridor from a drag p0→p1 (metres): axis-locked, grid-snapped, kept inside the venue. */
export function makeCorridor(venue, p0, p1, width = 3) {
  const horizontal = Math.abs(p1.x - p0.x) >= Math.abs(p1.y - p0.y);
  const axis = horizontal ? 'h' : 'v';
  const maxC = horizontal ? venue.height : venue.width;
  const maxT = horizontal ? venue.width : venue.height;
  let c = clamp(snap(horizontal ? p0.y : p0.x), 0, maxC);
  for (const k of venue.corridors) if (k.axis === axis && Math.abs(k.c - c) < JOIN_M) c = k.c;
  const a = clamp(snap(horizontal ? p0.x : p0.y), 0, maxT);
  const b = clamp(snap(horizontal ? p1.x : p1.y), 0, maxT);
  if (Math.abs(b - a) < MIN_CORRIDOR_M) return null;
  return { id: nextId(venue.corridors, 'C'), axis, c, from: Math.min(a, b), to: Math.max(a, b), width };
}

export function addCorridor(venue, corridor) {
  if (!corridor) return venue;
  return { ...venue, corridors: [...venue.corridors, corridor] };
}

/** Corridors as geometry lines, scaled by k (1 = metres, ppm = pixels). */
export function corridorLines(venue, k = 1) {
  return venue.corridors.map((c) =>
    c.axis === 'h' ? hLine(c.id, c.c * k, c.from * k, c.to * k) : vLine(c.id, c.c * k, c.from * k, c.to * k)
  );
}

/** Curved paths scaled by k (1 = metres, ppm = pixels). */
export function venuePaths(venue, k = 1) {
  return (venue.paths || []).map((P) => ({ id: P.id, points: P.points.map((q) => ({ x: q.x * k, y: q.y * k })) }));
}

const r2 = (v) => Math.round(v * 100) / 100;

/** Curved path from freehand points (metres): simplified, kept inside, ends snapped to the network. */
export function makePath(venue, raw, width = 3) {
  const inside = raw.map((q) => ({ x: clamp(q.x, 0, venue.width), y: clamp(q.y, 0, venue.height) }));
  const points = simplify(inside, 0.3).map((q) => ({ x: r2(q.x), y: r2(q.y) }));
  if (points.length < 2) return null;
  for (const end of [0, points.length - 1]) {
    const n = nearestOnNetwork(corridorLines(venue), venuePaths(venue), points[end]);
    if (n && n.dist <= JOIN_M) points[end] = { x: r2(n.x), y: r2(n.y) };
  }
  if (pathLength({ points }) < MIN_CORRIDOR_M) return null;
  return { id: nextId(venue.paths || [], 'P'), points, width };
}

const polyArea = (P) => Math.abs(P.reduce((s, q, i) => {
  const n = P[(i + 1) % P.length];
  return s + q.x * n.y - n.x * q.y;
}, 0)) / 2;

/** Obstacle polygon from freehand points (metres): closed, simplified, kept inside the venue. */
export function makeObstacle(venue, raw, kind = 'other', name = '') {
  const inside = raw.map((q) => ({ x: clamp(q.x, 0, venue.width), y: clamp(q.y, 0, venue.height) }));
  let points = simplify(inside, 0.3).map((q) => ({ x: r2(q.x), y: r2(q.y) }));
  const a = points[0], z = points[points.length - 1];
  if (points.length > 3 && Math.hypot(a.x - z.x, a.y - z.y) < 0.3) points = points.slice(0, -1); // already closed
  if (points.length < 3 || polyArea(points) < 0.5) return null;
  return { id: nextId(venue.obstacles || [], 'O'), kind, name, points };
}

export const DOOR_W = 2; // default door width (m)

/** Building outline (metres): only the walls block, doors [{x, y, w}] are the ways in. */
export function makeWall(venue, raw, name = '', doors = []) {
  const o = makeObstacle(venue, raw, 'building', name);
  return o && { ...o, shape: 'wall', doors: doors.map((d) => ({ x: r2(d.x), y: r2(d.y), w: d.w || DOOR_W })) };
}

/** Add a door on the wall nearest to p, or remove the door p is on. */
export function toggleDoor(o, p, w = DOOR_W) {
  const doors = o.doors || [];
  const i = doors.findIndex((d) => Math.hypot(d.x - p.x, d.y - p.y) <= Math.max(1, d.w / 2));
  if (i >= 0) return { ...o, doors: doors.filter((_, j) => j !== i) };
  const n = nearestOnRing(o.points, p);
  return { ...o, doors: [...doors, { x: r2(n.x), y: r2(n.y), w }] };
}

/** Rectangular obstacle {x, y, w, h} (metres). */
export function rectObstacle(venue, r, kind = 'other', name = '') {
  return makeObstacle(venue, [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], kind, name);
}

export function addPath(venue, path) {
  if (!path) return venue;
  return { ...venue, paths: [...(venue.paths || []), path] };
}

/** Nearest point on any corridor or curve (metres), or null when there are none. */
export function snapToCorridor(venue, p) {
  const n = nearestOnNetwork(corridorLines(venue), venuePaths(venue), p);
  return n ? { x: n.x, y: n.y, dist: n.dist } : null;
}

export function pxPerMeterFor(venue, maxPx = MAX_PX, preferred = PREFERRED_PPM) {
  return Math.max(1, Math.min(preferred, Math.floor(maxPx / Math.max(venue.width, venue.height))));
}

/** The .phop payload pieces (in image pixels) for a venue rendered at ppm pixels per metre. */
export function buildPayload(venue, ppm) {
  const open = venue.walk === 'open';
  const graph = buildNetwork(corridorLines(venue, ppm), venuePaths(venue, ppm), ppm * JOIN_M);
  const anchors = venue.anchors.map((a) => {
    let out;
    if (open) out = { id: a.id, name: a.name, x: a.x * ppm, y: a.y * ppm, line: null };
    else {
      const n = nearestOnNetwork(graph.lines, graph.paths, { x: a.x * ppm, y: a.y * ppm });
      out = { id: a.id, name: a.name, x: n.x, y: n.y, line: n.id };
    }
    if (a.landmark) out.landmark = a.landmark;
    return out;
  });
  if (open) {
    graph.obstacles = obstaclePolygons(venue).map((o) => ({
      ...o, points: o.points.map((q) => ({ x: q.x * ppm, y: q.y * ppm })),
      ...(o.doors ? { doors: o.doors.map((d) => ({ x: d.x * ppm, y: d.y * ppm, w: d.w * ppm })) } : {}),
    }));
  }
  const pois = venue.blocks.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    x: (b.x + b.w / 2) * ppm,
    y: (b.y + b.h / 2) * ppm,
    box: { x0: b.x * ppm, y0: b.y * ppm, x1: (b.x + b.w) * ppm, y1: (b.y + b.h) * ppm },
    conf: 100,
  }));
  return {
    walkMode: open ? 'open' : 'corridors',
    size: { width: Math.round(venue.width * ppm), height: Math.round(venue.height * ppm) },
    graph,
    anchors,
    pois,
    calibration: { pxPerMeter: ppm, defaultPxPerStep: Math.round(ppm * STEP_M), segments: [] },
  };
}

/** Structural checks; all must pass before export. */
export function checkVenue(venue) {
  if (venue.walk === 'open') return checkOpenVenue(venue);
  const ppm = pxPerMeterFor(venue);
  const nPaths = (venue.paths || []).length;
  const hasLines = venue.corridors.length + nPaths > 0;
  const p = hasLines ? buildPayload({ ...venue, anchors: [] }, ppm) : null;
  const connected = hasLines && isConnected(p.graph);
  const enough = venue.anchors.length >= 2;
  let reachable = false;
  if (hasLines && venue.anchors.length) reachable = anchorsReachable(p.graph, buildPayload(venue, ppm).anchors);
  return [
    { step: 3, ok: hasLines, label: hasLines ? `走道 ${venue.corridors.length} 條${nPaths ? `、彎路 ${nPaths} 條` : ''}` : '至少要畫 1 條走道' },
    { step: 3, ok: connected, label: connected ? '所有走道都連在一起' : '有走道沒有接上（端點要碰到其他走道）' },
    { step: 5, ok: enough, label: enough ? `錨點 ${venue.anchors.length} 個` : `錨點 ${venue.anchors.length} 個（需 ≥ 2）` },
    { step: 5, ok: reachable, label: reachable ? '每個錨點都走得到' : '錨點要放在相連的走道上' },
  ];
}

/** Checks for open-walk venues: anchors on free ground and reachable from each other. */
function checkOpenVenue(venue) {
  const n = venue.anchors.length;
  const nObs = obstaclePolygons(venue).length - groundParts(venue).length; // rooms inside buildings are not counted
  const bad = venue.anchors.filter((a) => !isWalkable(venue, a));
  const enough = n >= 2;
  const onFree = n > 0 && !bad.length;
  const reachable = enough && onFree && allReachable(walkGrid(venue), venue.anchors);
  // the usual reason: an anchor inside a building whose walls have no door
  let shut = null;
  if (enough && onFree && !reachable) {
    for (const a of venue.anchors) {
      const w = (venue.obstacles || []).find((o) => o.shape === 'wall' && !(o.doors || []).length && pointInPolygon(a, o.points));
      if (w) { shut = `定位點「${a.name}」在「${w.name || '建築'}」裡，但這棟建築還沒有門（點這棟建築，按「開門」在牆上點一下）`; break; }
    }
    if (!shut) {
      // name the ones cut off from the rest, so they can be moved or removed
      const cut = unreachablePoints(walkGrid(venue), venue.anchors).map((i) => venue.anchors[i].name);
      if (cut.length) shut = `定位點「${cut[0]}」${cut.length > 1 ? `等 ${cut.length} 個` : ''}被不能走的地方圍住，和其他定位點之間走不到（移動或刪除它）`;
    }
  }
  return [
    { step: 3, ok: true, label: nObs ? `不能走的地方 ${nObs} 處，其他地方都可以走` : '整個場地都可以走' },
    { step: 5, ok: enough, label: enough ? `定位點 ${n} 個` : `定位點 ${n} 個（需 ≥ 2）` },
    {
      step: 5, ok: onFree,
      label: onFree ? '每個定位點都在能走的地方' : bad.length ? `定位點「${bad[0].name}」在不能走的地方` : '還沒有定位點',
    },
    { step: 5, ok: reachable, label: reachable ? '定位點之間都走得到' : shut || '有定位點被不能走的地方圍住，走不到' },
  ];
}
