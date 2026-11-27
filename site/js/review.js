// Review step of the free path (create.html): every recognised corridor, anchor and place can be
// kept or dropped with a check box, and the user can draw more on top. Pure functions, no DOM.
// Keys: 'L:<line id>' recognised corridor, 'C:<id>' recognised curve (slanted / curved road),
// 'A:<id>' recognised anchor, 'P:<id>' other place, 'D:<id>' something the user drew (never
// unchecked, only deleted).
import { project, isH } from './geometry.js';
import { buildNetwork, nearestOnNetwork, projectPath, pathLength } from './curves.js';
import { UNSURE_CONF } from './candidates.js';

const unsure = (conf) => conf != null && conf < UNSURE_CONF;

/** The check list for a recognition result: one item per corridor, anchor and other place.
 * Items read with low OCR confidence start unchecked and are flagged. */
export function reviewItems(result, { linesFailed = false, navOk = null, size = null } = {}) {
  const objOf = (id) => result.objects.find((o) => o.id === id);
  const items = [];
  const n = { h: 0, v: 0 };
  for (const L of result.graph.lines) {
    const h = isH(L);
    items.push({ key: `L:${L.id}`, group: 'line', ref: L, label: h ? `橫向走道 ${++n.h}` : `直向走道 ${++n.v}`, unsure: false });
  }
  (result.graph.paths || []).forEach((P, i) => {
    items.push({ key: `C:${P.id}`, group: 'path', ref: P, label: `彎路 ${i + 1}`, unsure: false });
  });
  for (const a of result.anchors) {
    items.push({ key: `A:${a.id}`, group: 'anchor', ref: a, label: a.name, unsure: unsure(objOf(a.id)?.conf) });
  }
  const anchored = new Set(result.anchors.map((a) => a.id));
  for (const o of result.objects) {
    if (anchored.has(o.id)) continue;
    items.push({ key: `P:${o.id}`, group: 'poi', ref: o, label: o.name, unsure: unsure(o.conf) });
  }
  // Recognition failed what navigation needs: its corridors are usually wrong (stone texture, borders),
  // so they start unchecked — listed, and one tap brings each back.
  // Corridors start unchecked when they look wrong, not just because place names are unsure:
  // navigation fails even with every anchor counted (navOk(kept) on everything), or the "roads"
  // are texture — many short pieces, on average under 3 % of the map (stone, grass, hatching).
  const keep = new Set(items.filter((i) => !i.unsure).map((i) => i.key));
  const roads = result.graph.lines.length + (result.graph.paths || []).length;
  const none = { lines: [], anchors: [] };
  const texture = () => {
    if (!size || !roads) return false;
    const len = result.graph.lines.reduce((t, L) => t + (L.range[1] - L.range[0]), 0) +
      (result.graph.paths || []).reduce((t, P) => t + pathLength(P), 0);
    return len / roads < 0.03 * Math.max(size.w, size.h);
  };
  const failed = linesFailed || (!!navOk && roads > 0 && !navOk(keptResult(result, keep, none)) &&
    (!navOk(keptResult(result, new Set(items.map((i) => i.key)), none)) || texture()));
  if (failed) for (const i of items) if (i.group === 'line' || i.group === 'path') keep.delete(i.key);
  return { items, keep, linesFailed: failed };
}

const strip = ({ key, ...rest }) => rest;

/** What is shown and exported: the checked recognition results plus what the user drew.
 * drawn = { lines: [corridor], paths?: [{ id, points }], anchors: [{ id, name, x, y, here? }] }.
 * Inputs are not changed. */
export function keptResult(result, keep, drawn, tol = result.tol ?? 0) {
  const lines = [
    ...result.graph.lines.filter((L) => keep.has(`L:${L.id}`)).map((L) => ({ ...L, range: [...L.range], key: `L:${L.id}` })),
    ...drawn.lines.map((L) => ({ ...L, range: [...L.range], key: `D:${L.id}` })),
  ];
  const copy = (P, key) => ({ ...P, points: P.points.map((q) => ({ x: q.x, y: q.y })), key });
  const paths = [
    ...(result.graph.paths || []).filter((P) => keep.has(`C:${P.id}`)).map((P) => copy(P, `C:${P.id}`)),
    ...(drawn.paths || []).map((P) => copy(P, `D:${P.id}`)),
  ];
  const graph = buildNetwork(lines.map(strip), paths.map(strip), tol);
  const snap = (a, key) => {
    const s = graph.lines.length + graph.paths.length ? nearestOnNetwork(graph.lines, graph.paths, a) : null;
    return { id: a.id, name: a.name, x: s ? s.x : a.x, y: s ? s.y : a.y, line: s ? s.id : null, ...(a.here ? { here: true } : {}), key };
  };
  const anchors = [
    ...result.anchors.filter((a) => keep.has(`A:${a.id}`)).map((a) => snap(a, `A:${a.id}`)),
    ...drawn.anchors.map((a) => snap(a, `D:${a.id}`)),
  ];
  const ids = new Set(anchors.map((a) => a.id));
  const objects = result.objects.filter((o) => keep.has(`P:${o.id}`) || ids.has(o.id));
  return { lines, paths, graph, anchors, objects };
}

/** What the erase tool hits at p: an anchor first, then a corridor or curve (as drawn, before merging).
 * Recognised things are unchecked (they can be checked again); drawn ones are deleted. */
export function eraseAt(kept, p, tol) {
  let key = null;
  let best = tol;
  for (const a of kept.anchors) {
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d < best) { best = d; key = a.key; }
  }
  if (!key) {
    for (const L of kept.lines) {
      const d = project(L, p).dist;
      if (d < best) { best = d; key = L.key; }
    }
    for (const P of kept.paths || []) {
      if (P.points.length < 2) continue;
      const d = projectPath(P, p).dist;
      if (d < best) { best = d; key = P.key; }
    }
  }
  return key ? { action: key.startsWith('D:') ? 'delete' : 'uncheck', key } : null;
}
