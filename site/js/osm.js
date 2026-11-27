// OpenStreetMap helpers for the map editor: place search (Nominatim), real-world size and
// area of a place, and an OSM map image of a chosen area to trace over.
// Usage policies: Nominatim max 1 request/second; tiles need the attribution
// "© OpenStreetMap contributors". Only the search text the user types is sent to OSM.

import { clipPolygon } from './walkable.js';

const R = 6371008.8; // mean Earth radius (m)
const RAD = Math.PI / 180;
export const ATTRIBUTION = '© OpenStreetMap contributors';
const TILE = 256;
const MAX_ZOOM = 19;

/** Width (east–west) and height (north–south) of a bbox {s,w,n,e} in metres. */
export function bboxSize(b) {
  const lat = ((b.s + b.n) / 2) * RAD;
  return { width: (b.e - b.w) * RAD * R * Math.cos(lat), height: (b.n - b.s) * RAD * R };
}

function ringArea(ring, lat0) {
  // local equirectangular projection around lat0, then the shoelace formula
  const kx = RAD * R * Math.cos(lat0 * RAD);
  const ky = RAD * R;
  let a = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(a) / 2;
}

/** Area in m² of a GeoJSON Polygon / MultiPolygon (holes subtracted); null for other types. */
export function polygonArea(geo) {
  const polys = geo?.type === 'Polygon' ? [geo.coordinates] : geo?.type === 'MultiPolygon' ? geo.coordinates : null;
  if (!polys) return null;
  let total = 0;
  for (const rings of polys) {
    const lat0 = rings[0].reduce((s, p) => s + p[1], 0) / rings[0].length;
    rings.forEach((ring, i) => { total += (i ? -1 : 1) * ringArea(ring, lat0); });
  }
  return total;
}

// Web Mercator pixel coordinates at zoom z (256-px tiles).
export const lonToX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
export function latToY(lat, z) {
  const s = Math.sin(lat * RAD);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}
export const xToLon = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
export function yToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return Math.atan(Math.sinh(n)) / RAD;
}

/** Highest zoom (≤ 19) at which the bbox fits in maxPx on its longer side. */
export function pickZoom(b, maxPx) {
  for (let z = MAX_ZOOM; z > 0; z--) {
    const w = lonToX(b.e, z) - lonToX(b.w, z);
    const h = latToY(b.s, z) - latToY(b.n, z);
    if (Math.max(w, h) <= maxPx) return z;
  }
  return 1;
}

export function parseResult(r) {
  const [s, n, w, e] = r.boundingbox.map(Number);
  return {
    name: r.name || r.display_name.split(',')[0],
    display: r.display_name,
    osm: `${r.osm_type}/${r.osm_id}`,
    lat: +r.lat,
    lon: +r.lon,
    bbox: { s, w, n, e },
    geojson: r.geojson || null,
    area: polygonArea(r.geojson),
  };
}

let lastSearch = 0;
/** Search places by name (Nominatim). */
export async function searchPlaces(q) {
  const wait = lastSearch + 1100 - Date.now(); // ≤ 1 request per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearch = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q, format: 'jsonv2', polygon_geojson: '1', polygon_threshold: '0.00001', limit: '6', 'accept-language': 'zh-TW,zh,en',
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSM 搜尋失敗（${res.status}）`);
  return (await res.json()).map(parseResult);
}

function loadTile(z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });
}

// ---------- obstacles (buildings, water, woods, grass) from the Overpass API ----------
// Only the bbox of the framed area is sent. Used to pre-mark "can't walk here" areas.

/** Overpass QL for the obstacle features inside bbox. */
export function overpassQuery(b) {
  const B = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:25];
(
  way["building"]${B}; relation["building"]${B};
  way["natural"~"^(water|wood|scrub|grassland)$"]${B}; relation["natural"~"^(water|wood|scrub)$"]${B};
  way["landuse"~"^(forest|grass|meadow|reservoir|basin)$"]${B}; relation["landuse"~"^(forest|grass|meadow|reservoir|basin)$"]${B};
  way["waterway"="riverbank"]${B}; way["leisure"="swimming_pool"]${B};
  node["entrance"]${B}; node["amenity"="fountain"]${B}; node["historic"]${B}; node["tourism"="artwork"]${B};
  node["name"]["shop"]${B}; node["name"]["amenity"]${B}; node["name"]["tourism"]${B};
  way["highway"~"^(${PATH_TYPES})$"]${B};
);
out geom;`;
}

const PATH_TYPES = 'footway|path|pedestrian|steps|service|living_street|residential|unclassified|cycleway|track|tertiary';
const PATH_RE = new RegExp(`^(${PATH_TYPES})$`);

/** What a point looks like on site (used as the anchor's landmark text). */
function landmarkLabel(t) {
  if (t.amenity === 'fountain') return '噴水池';
  if (t.tourism === 'artwork') return /statue|sculpture/.test(t.artwork_type || '') ? '雕像' : '藝術品';
  if (t.historic === 'memorial' || t.historic === 'monument') return '紀念碑';
  if (t.historic) return '古蹟';
  return null;
}

const POI_LABEL = { shop: '商店', amenity: '設施', tourism: '景點' };

/** Overpass JSON → { nodes: [{type: entrance|landmark|poi, name, label, kind?, lat, lon}], ways: [{name, geometry}] }. */
export function parseOverpassExtras(json) {
  const nodes = [], ways = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.entrance && t.entrance !== 'no') nodes.push({ type: 'entrance', name: t.name || '', label: '入口', lat: el.lat, lon: el.lon });
      else if (landmarkLabel(t)) nodes.push({ type: 'landmark', name: t.name || '', label: landmarkLabel(t), lat: el.lat, lon: el.lon });
      else if (t.name) {
        const cat = ['shop', 'amenity', 'tourism'].find((c) => t[c]);
        if (!cat) continue;
        const kind = t.amenity === 'toilets' ? 'restroom' : t.tourism === 'information' ? 'info' : 'booth';
        nodes.push({ type: 'poi', name: t.name, label: POI_LABEL[cat], kind, lat: el.lat, lon: el.lon });
      }
    } else if (el.type === 'way' && PATH_RE.test(t.highway || '') && el.geometry?.length > 1) {
      ways.push({ name: t.name || '', geometry: el.geometry });
    }
  }
  return { nodes, ways };
}

/** (lat, lon) → venue metres, for a venue W m wide covering bbox (Web Mercator, like the background). */
function projector(b, W) {
  const z = 20;
  const x0 = lonToX(b.w, z), y0 = latToY(b.n, z);
  const k = W / (lonToX(b.e, z) - x0);
  return (lat, lon) => ({ x: (lonToX(lon, z) - x0) * k, y: (latToY(lat, z) - y0) * k });
}

/** All OSM data in venue metres: { areas (clipped), nodes inside the venue, ways }. */
export function projectOsm(data, b, W, H) {
  const P = projector(b, W);
  const nodes = data.nodes
    .map(({ lat, lon, ...n }) => ({ ...n, ...P(lat, lon) }))
    .filter((n) => n.x >= 0 && n.y >= 0 && n.x <= W && n.y <= H);
  const ways = data.ways.map((w) => ({ name: w.name, points: w.geometry.map((p) => P(p.lat, p.lon)) }));
  return { areas: projectToVenue(data.areas, b, W, H), nodes, ways };
}

function classify(t = {}) {
  if (t.building && t.building !== 'no') return 'building';
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.leisure === 'swimming_pool'
    || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water';
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') return 'trees';
  if (t.landuse === 'grass' || t.landuse === 'meadow' || t.natural === 'grassland') return 'grass';
  return null;
}

const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
const closed = (r) => r.length >= 4 && same(r[0], r[r.length - 1]);

/** Join way pieces (lists of {lat, lon}) into closed rings. */
function joinRings(pieces) {
  const rest = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings = [];
  while (rest.length) {
    let ring = rest.shift();
    let grew = true;
    while (!closed(ring) && grew) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i], end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        rest.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

/** Overpass JSON → [{ kind: building|water|trees|grass, name, rings: [[{lat, lon}]] }] (outer rings). */
export function parseOverpass(json) {
  const out = [];
  for (const el of json.elements || []) {
    const kind = classify(el.tags);
    if (!kind) continue;
    let rings = [];
    if (el.type === 'way' && el.geometry && closed(el.geometry)) rings = [el.geometry];
    else if (el.type === 'relation') {
      rings = joinRings((el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry));
    }
    if (rings.length) out.push({ kind, name: el.tags.name || '', rings });
  }
  return out;
}

/**
 * Features → venue polygons [{ kind, name, points }] in metres, for a venue of W × H m covering
 * bbox (Web Mercator, matching the OSM background), clipped to the venue.
 */
export function projectToVenue(features, b, W, H) {
  const z = 20;
  const x0 = lonToX(b.w, z), y0 = latToY(b.n, z);
  const k = W / (lonToX(b.e, z) - x0);
  const res = [];
  for (const f of features) {
    for (const ring of f.rings) {
      const pts = ring.slice(0, -1).map((p) => ({ x: (lonToX(p.lon, z) - x0) * k, y: (latToY(p.lat, z) - y0) * k }));
      const c = clipPolygon(pts, 0, 0, W, H);
      if (c.length >= 3) res.push({ kind: f.kind, name: f.name, points: c });
    }
  }
  return res;
}

/** Obstacle features inside bbox from the Overpass API. */
const OVERPASS = [ // public instances, tried in order when one is busy or down
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Everything the editor suggests from OSM inside bbox: { areas, nodes, ways } (lat/lon). */
export async function fetchOsmData(b) {
  const json = await fetchOverpass(b);
  return { areas: parseOverpass(json), ...parseOverpassExtras(json) };
}

async function fetchOverpass(b, wait = 10000) {
  // all instances at once; the first good answer wins, and nobody waits longer than `wait`
  const body = 'data=' + encodeURIComponent(overpassQuery(b));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), wait);
  try {
    return await Promise.any(OVERPASS.map(async (url) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal });
      if (!res.ok) throw new Error(`OSM 伺服器忙碌（${res.status}），請稍後再試`);
      return res.json();
    }));
  } catch {
    throw new Error('連不上 OSM 伺服器（需要網路）');
  } finally {
    clearTimeout(timer);
    ctl.abort(); // stop the slower ones
  }
}

/**
 * OSM map image of bbox, at most maxPx on its longer side. Returns
 * { canvas, toPx(lat, lon), toLatLon(x, y) } in the canvas's pixel coordinates.
 */
export async function renderArea(b, maxPx = 1024) {
  const z = pickZoom(b, maxPx);
  const x0 = lonToX(b.w, z), x1 = lonToX(b.e, z);
  const y0 = latToY(b.n, z), y1 = latToY(b.s, z);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(x1 - x0));
  canvas.height = Math.max(1, Math.round(y1 - y0));
  const g = canvas.getContext('2d');
  g.fillStyle = '#e5e7eb';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1e-9) / TILE); tx++) {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1e-9) / TILE); ty++) {
      jobs.push(loadTile(z, tx, ty).then((img) => img && g.drawImage(img, tx * TILE - x0, ty * TILE - y0)));
    }
  }
  await Promise.all(jobs);
  return {
    canvas,
    toPx: (lat, lon) => ({ x: lonToX(lon, z) - x0, y: latToY(lat, z) - y0 }),
    toLatLon: (x, y) => ({ lat: yToLat(y + y0, z), lon: xToLon(x + x0, z) }),
  };
}
