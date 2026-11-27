// Building interiors (the editor's "畫室內地圖" step): every building drawn as walls can hold floors,
// each a list of parts in venue metres — rooms (closed outlines with doors) and inner walls (two-point
// lines). Parts use the same { points, doors } shape as building walls, so the ground floor simply
// becomes more wall obstacles in the exported .phop (see groundParts in walkable.js). Pure, no DOM.
import { pointInPolygon, nearestOnRing, clipPolygon } from './walkable.js';
import { simplify } from './curves.js';

export const ROOM_DOOR_W = 1;
const r2 = (v) => Math.round(v * 100) / 100;

/** The buildings people can walk into (drawn as walls). */
export const buildings = (venue) => (venue.obstacles || []).filter((o) => o.shape === 'wall' && o.points.length >= 3);

/** A building's floors; one that has never been drawn inside has an empty 1F. */
export const floorsOf = (b) => (b.floors?.length ? b.floors : [{ label: '1F', parts: [] }]);

/** Add the next floor on top ("2F" after "1F"). */
export function addFloor(b) {
  const fl = floorsOf(b);
  const n = Math.max(0, ...fl.map((f) => parseInt(f.label, 10) || 0)) + 1;
  return { ...b, floors: [...fl, { label: `${n}F`, parts: [] }] };
}

/** Replace the parts of floor fi of building id. */
export function setFloorParts(venue, id, fi, parts) {
  return {
    ...venue,
    obstacles: venue.obstacles.map((o) => {
      if (o.id !== id) return o;
      const fl = floorsOf(o).map((f, i) => (i === fi ? { ...f, parts } : f));
      return { ...o, floors: fl };
    }),
  };
}

function nextPartId(parts) {
  let n = 0;
  for (const p of parts) n = Math.max(n, +(String(p.id).match(/(\d+)$/)?.[1] || 0));
  return `R${n + 1}`;
}

const centroid = (pts) => ({ x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length });

/** Room dragged as {x, y, w, h} inside building b (cut to its walls), with one door on the side facing the building's middle. */
export function makeRoom(b, parts, r, name = '') {
  // only the part of the dragged box inside the building: a slanted wall cuts the box
  const cut = clipPolygon(b.points, r.x, r.y, r.x + r.w, r.y + r.h).map((q) => ({ x: r2(q.x), y: r2(q.y) }));
  const points = cut.filter((q, i) => { const o = cut[(i + cut.length - 1) % cut.length]; return Math.hypot(q.x - o.x, q.y - o.y) > 0.01; });
  if (points.length < 3) return null;
  const xs = points.map((q) => q.x), ys = points.map((q) => q.y);
  if (Math.max(...xs) - Math.min(...xs) < 1 || Math.max(...ys) - Math.min(...ys) < 1) return null;
  const c = centroid(b.points);
  // the door goes on the side facing the middle of the building, never on the building's own wall
  const sides = points.map((q, i) => { const z = points[(i + 1) % points.length]; return { x: (q.x + z.x) / 2, y: (q.y + z.y) / 2 }; });
  const inner = sides.filter((m) => nearestOnRing(b.points, m).dist > 0.05);
  let door = null;
  for (const m of inner.length ? inner : sides) {
    const d = Math.hypot(m.x - c.x, m.y - c.y);
    if (!door || d < door.d) door = { x: r2(m.x), y: r2(m.y), d };
  }
  return { id: nextPartId(parts), name, points, doors: [{ x: door.x, y: door.y, w: ROOM_DOOR_W }] };
}

/** Inner wall from a drag p0→p1: snapped to the axes when within 10°, at least 1 m long. */
export function makeInnerWall(b, parts, p0, p1) {
  let q = { ...p1 };
  const ang = Math.abs(Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI) % 90;
  if (ang < 10 || ang > 80) {
    if (Math.abs(p1.x - p0.x) >= Math.abs(p1.y - p0.y)) q.y = p0.y; else q.x = p0.x;
  }
  if (Math.hypot(q.x - p0.x, q.y - p0.y) < 1) return null;
  return { id: nextPartId(parts), name: '', points: [{ x: r2(p0.x), y: r2(p0.y) }, { x: r2(q.x), y: r2(q.y) }], doors: [] };
}

/** Unit vector into building b at the door d (perpendicular to the wall the door is on). */
export function inwardAt(b, d) {
  const n = nearestOnRing(b.points, d);
  const a = b.points[n.edge], z = b.points[(n.edge + 1) % b.points.length];
  const L = Math.hypot(z.x - a.x, z.y - a.y) || 1;
  let v = { x: -(z.y - a.y) / L, y: (z.x - a.x) / L };
  if (!pointInPolygon({ x: n.x + v.x * 0.3, y: n.y + v.y * 0.3 }, b.points)) v = { x: -v.x, y: -v.y };
  return v;
}

/**
 * Floors walked with the survey (buildFloors output, survey frame) → building floors in venue metres.
 * The walk starts at target.door and its first straight run heads target.inward.
 */
export function interiorFromSurvey(built, target) {
  const pts = built[0]?.points || [];
  const s = pts[0] || { x: 0, y: 0 };
  // first direction: towards the first point at least 1.5 m from the start (or the farthest one)
  let f = pts.find((p) => Math.hypot(p.x - s.x, p.y - s.y) >= 1.5);
  if (!f) f = pts.reduce((best, p) => (Math.hypot(p.x - s.x, p.y - s.y) > Math.hypot(best.x - s.x, best.y - s.y) ? p : best), s);
  const L = Math.hypot(f.x - s.x, f.y - s.y);
  const u = L ? { x: (f.x - s.x) / L, y: (f.y - s.y) / L } : { x: 1, y: 0 };
  // rotation taking u to inward: cos = u·w, sin = u×w
  const w = target.inward;
  const c = u.x * w.x + u.y * w.y, sn = u.x * w.y - u.y * w.x;
  const T = (p) => {
    const x = p.x - s.x, y = p.y - s.y;
    return { x: r2(target.door.x + c * x - sn * y), y: r2(target.door.y + sn * x + c * y) };
  };
  return built.map((fl) => {
    const parts = [];
    // one part per straight piece of wall (a walked wall has a point at every step)
    for (const W of fl.walls) {
      const P = simplify(W, 0.15);
      for (let i = 1; i < P.length; i++) parts.push({ id: `R${parts.length + 1}`, name: '', points: [T(P[i - 1]), T(P[i])], doors: [] });
    }
    for (const r of fl.rooms || []) {
      const points = r.points.map(T);
      const m = fl.marks.find((x) => x.idx === r.idx);
      const doors = [];
      if (m) {
        const n = nearestOnRing(points, T(m));
        doors.push({ x: r2(n.x), y: r2(n.y), w: ROOM_DOOR_W });
      }
      parts.push({ id: `R${parts.length + 1}`, name: r.name, points, doors });
    }
    return { label: fl.label, parts };
  });
}
