// 3-D view of the venue: a cut-away "doll's house" seen from above at an angle. The ground map is
// drawn flat, every building floor is lifted FLOOR_H metres above the one below, and walls stand up
// WALL_H metres (low, so the rooms inside stay visible). Projection and scene are pure; drawIso
// paints onto a 2-D canvas context.
import { wallSegments } from './walkable.js';
import { buildings, floorsOf } from './interior.js';
import { drawVenue } from './mapgen.js';

export const FLOOR_H = 4;
export const WALL_H = 1.4;
const ANG = (30 * Math.PI) / 180, TILT = 0.6;
const C = Math.cos(ANG), S = Math.sin(ANG);

/** Venue metres (+ height z) → view metres: turned 30°, squashed, raised by z. */
export const isoProject = (p, z = 0) => ({ x: p.x * C - p.y * S, y: (p.x * S + p.y * C) * TILT - z });

/** View metres → the point on the ground (z = 0). */
export function isoUnproject(q) {
  const yr = q.y / TILT;
  return { x: q.x * C + yr * S, y: -q.x * S + yr * C };
}

/** The ground-plane projection as a canvas transform [a, b, c, d, e, f] (before scaling). */
export const ISO_MATRIX = [C, S * TILT, -S, C * TILT, 0, 0];

const depthOf = (a, b) => ((a.x + b.x) / 2) * S + ((a.y + b.y) / 2) * C;

/**
 * Everything that stands up: { floors: [{ b, fi, label, z, points }], walls: [{ a, b, z0, h, depth, outer }],
 * labels: [{ x, y, z, text }] }, walls sorted bottom floor first, then far to near.
 */
export function isoScene(venue) {
  const floors = [], walls = [], labels = [];
  for (const b of buildings(venue)) {
    floorsOf(b).forEach((f, fi) => {
      const z = fi * FLOOR_H;
      floors.push({ b, fi, label: f.label, z, points: b.points });
      for (const [p, q] of wallSegments(b.points, fi === 0 ? b.doors || [] : [])) walls.push({ a: p, b: q, z0: z, h: WALL_H, depth: depthOf(p, q), outer: true });
      for (const part of f.parts || []) {
        // a two-point inner wall comes back as there-and-back: keep each piece once
        const seen = new Set();
        for (const [p, q] of wallSegments(part.points, part.doors || [])) {
          const key = [(p.x + q.x) / 2, (p.y + q.y) / 2].map((v) => v.toFixed(3)).join();
          if (seen.has(key)) continue;
          seen.add(key);
          walls.push({ a: p, b: q, z0: z, h: WALL_H, depth: depthOf(p, q), outer: false });
        }
        if (part.name) {
          const n = part.points.length;
          labels.push({ x: part.points.reduce((s, r) => s + r.x, 0) / n, y: part.points.reduce((s, r) => s + r.y, 0) / n, z, text: part.name });
        }
      }
      const xs = b.points.map((r) => r.x), ys = b.points.map((r) => r.y);
      labels.push({ x: Math.max(...xs), y: Math.min(...ys), z: z + WALL_H, text: `${b.name ? `${b.name} ` : ''}${f.label}`, floor: true });
    });
  }
  walls.sort((p, q) => p.z0 - q.z0 || p.depth - q.depth);
  return { floors, walls, labels };
}

/** Bounds of the whole scene in view metres. */
export function isoBounds(venue) {
  const s = isoScene(venue);
  const top = Math.max(0, ...s.floors.map((f) => f.z + WALL_H));
  const pts = [[0, 0], [venue.width, 0], [venue.width, venue.height], [0, venue.height]].flatMap(([x, y]) => [isoProject({ x, y }, 0), isoProject({ x, y }, top)]);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Paint the 3-D view. view: { k (screen px per metre), ox, oy (screen offset) }, dpr: device pixels.
 * highlight: id of a building to outline.
 */
export function drawIso(ctx, venue, view, dpr = 1, highlight = null) {
  const k = view.k;
  const P = (p, z) => { const q = isoProject(p, z); return [q.x * k, q.y * k]; };
  // the flat map on the ground plane, with the ground floor of each building drawn flat too
  ctx.save();
  ctx.setTransform(dpr * ISO_MATRIX[0], dpr * ISO_MATRIX[1], dpr * ISO_MATRIX[2], dpr * ISO_MATRIX[3], view.ox * dpr, view.oy * dpr);
  ctx.fillStyle = '#f8f6f0';
  ctx.fillRect(0, 0, venue.width * k, venue.height * k);
  drawVenue(ctx, venue, k, { ground: false, labels: false, scaleBar: false });
  ctx.restore();
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, view.ox * dpr, view.oy * dpr);
  const s = isoScene(venue);
  const levels = [...new Set([...s.floors.map((f) => f.z), ...s.walls.map((w) => w.z0)])].sort((a, b) => a - b);
  for (const z of levels) {
    // upper floor slabs: a light, slightly see-through floor
    for (const f of s.floors.filter((x) => x.z === z && x.z > 0)) {
      ctx.beginPath();
      f.points.forEach((q, i) => { const [x, y] = P(q, z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(241,245,249,.6)';
      ctx.fill();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const w of s.walls.filter((x) => x.z0 === z)) {
      const a0 = P(w.a, w.z0), b0 = P(w.b, w.z0), b1 = P(w.b, w.z0 + w.h), a1 = P(w.a, w.z0 + w.h);
      // light from the upper left: walls facing it are brighter
      const nx = -(w.b.y - w.a.y), ny = w.b.x - w.a.x, L = Math.hypot(nx, ny) || 1;
      const lit = 0.5 + 0.5 * Math.abs((nx * 0.6 + ny * 0.8) / L);
      const base = w.outer ? [75, 85, 99] : [129, 140, 248];
      const col = base.map((c) => Math.round(c + (255 - c) * lit * 0.45));
      ctx.beginPath();
      ctx.moveTo(...a0); ctx.lineTo(...b0); ctx.lineTo(...b1); ctx.lineTo(...a1); ctx.closePath();
      ctx.fillStyle = `rgb(${col.join(',')})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,41,59,.35)';
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
    if (highlight) {
      for (const f of s.floors.filter((x) => x.z === z && x.b.id === highlight)) {
        ctx.beginPath();
        f.points.forEach((q, i) => { const [x, y] = P(q, z + WALL_H); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.closePath();
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
    ctx.font = '600 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of s.labels.filter((x) => x.z === z || (x.floor && x.z === z + WALL_H))) {
      const [x, y] = P(l, l.z + (l.floor ? 0.3 : 0.2));
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeText(l.text, x, y);
      ctx.fillStyle = l.floor ? '#4f46e5' : '#1e293b';
      ctx.fillText(l.text, x, y);
    }
  }
  ctx.restore();
}
