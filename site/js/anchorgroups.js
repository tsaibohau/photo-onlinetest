// Groups a dense set of anchors (e.g. one every 5 m) by the nearest named place, so people can
// find the one they stand next to: "樹人堂 (34)", "服務台 (5)", … Pure, no DOM. Coordinates in px.
import { pointInPolygon, nearestOnRing } from './walkable.js';

export const OTHER_GROUP = '其他位置';

/** Distance from p to a place: a polygon ({points}, 0 inside) or a point ({x, y}). */
function distTo(place, p) {
  if (place.points?.length > 2) return pointInPolygon(p, place.points) ? 0 : nearestOnRing(place.points, p).dist;
  return Math.hypot(place.x - p.x, place.y - p.y);
}

/** The nine areas of the map, in reading order. */
const AREAS = ['西北區', '北區', '東北區', '西區', '中央區', '東區', '西南區', '南區', '東南區'];
const areaOf = (p, size) => {
  const c = Math.min(2, Math.max(0, Math.floor((p.x / size.width) * 3)));
  const r = Math.min(2, Math.max(0, Math.floor((p.y / size.height) * 3)));
  return AREAS[r * 3 + c];
};

/**
 * [{ name, anchors }] sorted by place name (Traditional Chinese order). Anchors with no named
 * place within maxDist come last: by area of the map (西北區 … 東南區) when the map size is
 * given, otherwise all under OTHER_GROUP. Places with the same name share a group.
 */
export function groupAnchors(anchors, places, maxDist, size = null) {
  const named = places.filter((q) => q.name);
  const groups = new Map();
  for (const a of anchors) {
    let best = null, bd = maxDist;
    for (const q of named) {
      const d = distTo(q, a);
      if (d <= bd) { bd = d; best = q; }
    }
    const key = best ? best.name : size ? areaOf(a, size) : OTHER_GROUP;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  // named places first (by name), then the areas in map order, then the rest
  const rank = (n) => (n === OTHER_GROUP ? 20 : AREAS.includes(n) && !named.some((q) => q.name === n) ? 10 + AREAS.indexOf(n) : 0);
  return [...groups]
    .map(([name, list]) => ({ name, anchors: list }))
    .sort((x, y) => rank(x.name) - rank(y.name) || x.name.localeCompare(y.name, 'zh-Hant-TW'));
}
