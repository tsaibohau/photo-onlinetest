// Draws a venue (metres) as a clean map image: ground, corridor bands, coloured blocks with
// names, a scale bar. Used both for the editor preview and for the exported map image.
import { KINDS, OBSTACLE_KINDS } from './venue.js';
import { wallSegments, groundParts } from './walkable.js';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

/** Draw venue onto ctx, where 1 m = ppm units of the current transform. */
export function drawVenue(ctx, venue, ppm, { ground = true, labels = true, scaleBar = true, style = 'plain' } = {}) {
  if (style === 'stone') return drawStone(ctx, venue, ppm, { ground, labels, scaleBar });
  const W = venue.width * ppm;
  const H = venue.height * ppm;
  if (ground) {
    ctx.fillStyle = '#f8f6f0';
    ctx.fillRect(0, 0, W, H);
  }

  for (const o of [...(venue.obstacles || []), ...groundParts(venue)]) drawObstacle(ctx, o, ppm, labels);

  // corridors: light bands with a soft edge, the actual route is drawn by the viewer on top
  ctx.lineCap = 'square';
  ctx.lineJoin = 'round';
  for (const pass of [0, 1]) {
    for (const P of venue.paths || []) {
      const w = Math.max(0.5, P.width || 3) * ppm;
      ctx.strokeStyle = pass ? '#ffffff' : '#d6d3c8';
      ctx.lineWidth = pass ? w : w + Math.max(2, ppm * 0.15);
      ctx.lineCap = 'round';
      ctx.beginPath();
      P.points.forEach((q, i) => (i ? ctx.lineTo(q.x * ppm, q.y * ppm) : ctx.moveTo(q.x * ppm, q.y * ppm)));
      ctx.stroke();
      ctx.lineCap = 'square';
    }
    for (const c of venue.corridors) {
      const w = Math.max(0.5, c.width || 3) * ppm;
      ctx.strokeStyle = pass ? '#ffffff' : '#d6d3c8';
      ctx.lineWidth = pass ? w : w + Math.max(2, ppm * 0.15);
      ctx.beginPath();
      if (c.axis === 'h') {
        ctx.moveTo(c.from * ppm, c.c * ppm);
        ctx.lineTo(c.to * ppm, c.c * ppm);
      } else {
        ctx.moveTo(c.c * ppm, c.from * ppm);
        ctx.lineTo(c.c * ppm, c.to * ppm);
      }
      ctx.stroke();
    }
  }

  for (const b of venue.blocks) {
    const k = KINDS[b.kind] || KINDS.other;
    const x = b.x * ppm, y = b.y * ppm, w = b.w * ppm, h = b.h * ppm;
    const r = Math.min(w, h, ppm) * 0.25;
    ctx.fillStyle = k.color;
    ctx.strokeStyle = k.stroke;
    ctx.lineWidth = Math.max(1, ppm * 0.08);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.stroke();
    if (labels && b.name) fitText(ctx, b.name, x + w / 2, y + h / 2, w * 0.9, h * 0.8, '#1f2937');
  }

  if (scaleBar) drawScaleBar(ctx, venue, ppm);
}

/** Obstacle polygon (grass, water, building, or a hatched "can't walk" area). */
export function drawObstacle(ctx, o, ppm, labels = true) {
  const k = OBSTACLE_KINDS[o.kind] || OBSTACLE_KINDS.other;
  if (o.shape === 'wall') {
    // building you can walk into: faint floor, thick walls, gaps at the doors
    ctx.beginPath();
    o.points.forEach((q, i) => (i ? ctx.lineTo(q.x * ppm, q.y * ppm) : ctx.moveTo(q.x * ppm, q.y * ppm)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(209,213,219,.35)';
    ctx.fill();
    ctx.strokeStyle = k.stroke;
    ctx.lineWidth = Math.max(2, ppm * 0.3);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const [a, b] of wallSegments(o.points, o.doors || [])) { ctx.moveTo(a.x * ppm, a.y * ppm); ctx.lineTo(b.x * ppm, b.y * ppm); }
    ctx.stroke();
    ctx.fillStyle = '#16a34a';
    for (const d of o.doors || []) { ctx.beginPath(); ctx.arc(d.x * ppm, d.y * ppm, Math.max(3, ppm * 0.35), 0, Math.PI * 2); ctx.fill(); }
    if (labels && o.name) {
      const xs = o.points.map((q) => q.x * ppm), ys = o.points.map((q) => q.y * ppm);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      // a building with rooms drawn inside: a small name along the top, so the rooms stay readable
      if (o.floors?.some((f) => f.parts?.length)) fitText(ctx, o.name, Math.min(...xs) + w / 2, Math.min(...ys) + h * 0.07, w * 0.4, h * 0.09, '#374151');
      else fitText(ctx, o.name, Math.min(...xs) + w / 2, Math.min(...ys) + h / 2, w * 0.6, h * 0.5, '#374151');
    }
    return;
  }
  ctx.beginPath();
  o.points.forEach((q, i) => (i ? ctx.lineTo(q.x * ppm, q.y * ppm) : ctx.moveTo(q.x * ppm, q.y * ppm)));
  ctx.closePath();
  ctx.fillStyle = k.color;
  ctx.fill();
  if (k.hatch) {
    ctx.save();
    ctx.clip();
    const xs = o.points.map((q) => q.x * ppm), ys = o.points.map((q) => q.y * ppm);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const gap = Math.max(6, ppm * 0.8);
    ctx.strokeStyle = k.stroke;
    ctx.globalAlpha *= 0.35;
    ctx.lineWidth = Math.max(1, ppm * 0.08);
    ctx.beginPath();
    for (let d = x0 - (y1 - y0); d < x1; d += gap) { ctx.moveTo(d, y1); ctx.lineTo(d + (y1 - y0), y0); }
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = k.stroke;
  ctx.lineWidth = Math.max(1, ppm * 0.08);
  ctx.stroke();
  if (labels && o.name) {
    const xs = o.points.map((q) => q.x * ppm), ys = o.points.map((q) => q.y * ppm);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    fitText(ctx, o.name, Math.min(...xs) + w / 2, Math.min(...ys) + h / 2, w * 0.6, h * 0.5, '#1f2937');
  }
}

/** Centred text, shrunk to fit; wraps onto two lines when that allows a bigger font. */
function fitText(ctx, text, cx, cy, maxW, maxH, color) {
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const sizeFor = (lines) => {
    let s = Math.min(maxH / (lines.length * 1.25), 48);
    while (s > 6) {
      ctx.font = `600 ${s}px ${FONT}`;
      if (lines.every((l) => ctx.measureText(l).width <= maxW)) break;
      s -= 1;
    }
    return s;
  };
  const one = [text];
  let lines = one;
  let size = sizeFor(one);
  if (text.length > 3) {
    const mid = Math.ceil(text.length / 2);
    const two = [text.slice(0, mid), text.slice(mid)];
    const s2 = sizeFor(two);
    if (s2 > size * 1.3) { lines = two; size = s2; }
  }
  if (size <= 6) return; // too small to read; the name is still in the list under the map
  ctx.font = `600 ${size}px ${FONT}`;
  lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * size * 1.2));
}

function drawScaleBar(ctx, venue, ppm) {
  const nice = [1, 2, 5, 10, 20, 50, 100, 200];
  const m = nice.find((n) => n >= venue.width / 6) || 200;
  const px = m * ppm;
  const H = venue.height * ppm;
  const pad = Math.max(8, ppm * 0.6);
  const fs = Math.max(10, Math.min(28, ppm * 0.7));
  const x = pad, y = H - pad;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(x - 4, y - fs * 1.6, px + 8, fs * 1.6 + 4);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = Math.max(1.5, fs * 0.12);
  ctx.beginPath();
  ctx.moveTo(x, y - fs * 0.4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - fs * 0.4);
  ctx.stroke();
  ctx.fillStyle = '#334155';
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${m} m`, x + px / 2, y - fs * 0.3);
}

/** Full-size map image for export. */
export function renderVenue(venue, ppm, style = 'plain', base = null) {
  const c = document.createElement('canvas');
  c.width = Math.round(venue.width * ppm);
  c.height = Math.round(venue.height * ppm);
  const g = c.getContext('2d');
  if (style === 'osm' && base) return drawOsmStyle(g, venue, ppm, base, c);
  drawVenue(g, venue, ppm, { style: style === 'osm' ? 'stone' : style });
  // small credit, bottom-right
  const fs = Math.max(10, Math.min(22, ppm * 0.6));
  const f = style === 'stone' ? frameWidth(venue, ppm) : 0;
  if (style === 'stone') {
    stoneLegendBox(g, venue, c.width, c.height, f, Math.max(1.2, Math.min(4, ppm * 0.12)));
    stoneFrame(g, c.width, c.height, f);
  }
  g.font = `600 ${fs}px ${FONT}`;
  g.fillStyle = style === 'stone' ? 'rgba(36,38,42,.7)' : 'rgba(100,116,139,.7)';
  g.textAlign = 'right';
  g.textBaseline = 'bottom';
  g.fillText('PhotoPath', c.width - f - fs * 0.6, c.height - f - fs * 0.5);
  return c;
}

/**
 * 'osm' style: the OpenStreetMap image of the venue's bbox, exactly as the user saw it while
 * editing, plus only what is not on OSM (blocks and obstacles drawn by hand), a scale bar and
 * the required attribution.
 */
function drawOsmStyle(g, venue, ppm, base, c) {
  g.drawImage(base, 0, 0, c.width, c.height);
  for (const o of [...(venue.obstacles || []).filter((x) => !x.src), ...groundParts(venue)]) drawObstacle(g, o, ppm, true);
  drawVenue(g, { ...venue, obstacles: [], corridors: [], paths: (venue.paths || []).filter((P) => !P.src) }, ppm, { ground: false, scaleBar: true });
  const fs = Math.max(11, Math.min(22, c.width / 70));
  g.font = `600 ${fs}px ${FONT}`;
  const text = '© OpenStreetMap contributors · PhotoPath';
  const w = g.measureText(text).width;
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillRect(c.width - w - fs * 1.2, c.height - fs * 1.7, w + fs * 1.2, fs * 1.7);
  g.fillStyle = '#334155';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText(text, c.width - fs * 0.6, c.height - fs * 0.85);
  return c;
}

// ---------- "stone" style: an engraved granite plaque, like the campus map signs ----------
// Granite with speckles, outlines cut into the stone (dark groove + light lip), some areas
// painted yellow or white, engraved names, a bevelled dark frame and a legend.

/** Small seeded random generator so the same venue always gets the same speckles. */
export function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Paint used for each kind on the stone map: 'yellow', 'white' or null (only engraved). */
export const STONE_PAINT = {
  booth: 'yellow', stage: 'yellow', info: 'yellow',
  entrance: 'white', restroom: 'white',
  room: null, other: null,
  building: null, grass: null, trees: null, water: null,
};
const PAINT = { yellow: 'rgba(214,176,52,.88)', white: 'rgba(226,225,218,.72)' };
const CUT = 'rgba(28,29,31,.78)'; // groove
const LIP = 'rgba(235,235,232,.42)'; // light edge of the cut

const granites = new Map();
/** Speckled granite pattern (a 256 px tile), light or dark variant. */
function granite(ctx, tone = 'mid') {
  if (granites.has(tone)) return ctx.createPattern(granites.get(tone), 'repeat');
  const T = 256;
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d');
  const base = { mid: [138, 141, 141], light: [160, 162, 161], paint: [255, 255, 255] }[tone];
  const img = g.createImageData(T, T);
  const rnd = seeded(tone.length * 7919 + 17);
  for (let i = 0; i < T * T; i++) {
    const r = rnd();
    let v = (rnd() - 0.5) * 22; // fine grain
    if (r < 0.05) v -= 40 + rnd() * 30; // black mica
    else if (r < 0.1) v += 28 + rnd() * 25; // white quartz
    const a = 255;
    img.data[i * 4] = Math.max(0, Math.min(255, base[0] + v));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + v));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + v));
    img.data[i * 4 + 3] = tone === 'paint' ? (r < 0.05 ? 110 : 0) : a;
  }
  g.putImageData(img, 0, 0);
  granites.set(tone, c);
  return ctx.createPattern(c, 'repeat');
}

/** Stroke the current path as a cut in the stone. */
function engrave(ctx, width) {
  const o = Math.max(0.8, width * 0.45);
  ctx.save();
  ctx.lineWidth = width;
  ctx.strokeStyle = LIP;
  ctx.translate(o, o);
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = width;
  ctx.strokeStyle = CUT;
  ctx.stroke();
}

function polyPath(ctx, pts, ppm) {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x * ppm, q.y * ppm) : ctx.moveTo(q.x * ppm, q.y * ppm)));
  ctx.closePath();
}

function paintFill(ctx, paint) {
  ctx.fillStyle = PAINT[paint];
  ctx.fill();
  ctx.fillStyle = granite(ctx, 'paint'); // worn paint: grains of stone show through
  ctx.fill();
}

/** Engraved text: dark letters with a light lower-right lip. */
function stoneText(ctx, text, cx, cy, maxW, maxH, painted) {
  const lip = painted ? 'rgba(255,255,255,.35)' : LIP;
  ctx.save();
  ctx.translate(1, 1);
  fitText(ctx, text, cx, cy, maxW, maxH, lip);
  ctx.restore();
  fitText(ctx, text, cx, cy, maxW, maxH, '#24262a');
}

function stoneObstacle(ctx, o, ppm, labels, cut) {
  const xs = o.points.map((q) => q.x * ppm), ys = o.points.map((q) => q.y * ppm);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // buildings are painted like on the plaque: named ones yellow, the rest white
  const paint = o.kind === 'building' ? (o.name ? 'yellow' : 'white') : STONE_PAINT[o.kind] ?? null;
  polyPath(ctx, o.points, ppm);
  if (o.shape === 'wall') {
    ctx.save();
    ctx.globalAlpha = 0.75;
    if (paint) paintFill(ctx, paint);
    ctx.restore();
    ctx.beginPath();
    for (const [a, b] of wallSegments(o.points, o.doors || [])) { ctx.moveTo(a.x * ppm, a.y * ppm); ctx.lineTo(b.x * ppm, b.y * ppm); }
    ctx.lineCap = 'butt';
    engrave(ctx, Math.max(cut * 1.6, ppm * 0.3));
    ctx.fillStyle = '#24262a';
    for (const d of o.doors || []) { ctx.beginPath(); ctx.arc(d.x * ppm, d.y * ppm, Math.max(1.6, ppm * 0.25), 0, Math.PI * 2); ctx.fill(); }
  } else {
    if (paint) paintFill(ctx, paint);
    // texture inside: dots for grass/trees, ripples for water, hatching for "can't walk"
    if (o.kind === 'grass' || o.kind === 'trees' || o.kind === 'water' || o.kind === 'other') {
      ctx.save();
      ctx.clip();
      const gap = Math.max(6, ppm * (o.kind === 'trees' ? 1.2 : 1.8));
      ctx.fillStyle = CUT;
      ctx.strokeStyle = CUT;
      ctx.lineWidth = Math.max(0.8, cut * 0.6);
      ctx.beginPath();
      if (o.kind === 'water') {
        for (let y = y0 + gap / 2; y < y1; y += gap) {
          ctx.moveTo(x0, y);
          for (let x = x0; x < x1; x += gap / 2) ctx.quadraticCurveTo(x + gap / 4, y - gap / 5, x + gap / 2, y);
        }
        ctx.stroke();
      } else if (o.kind === 'other') {
        for (let d = x0 - (y1 - y0); d < x1; d += gap) { ctx.moveTo(d, y1); ctx.lineTo(d + (y1 - y0), y0); }
        ctx.stroke();
      } else {
        const r = Math.max(0.9, cut * (o.kind === 'trees' ? 0.9 : 0.55));
        let row = 0;
        for (let y = y0 + gap / 2; y < y1; y += gap, row++) {
          for (let x = x0 + (row % 2 ? gap / 2 : 0); x < x1; x += gap) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
        }
        ctx.fill();
      }
      ctx.restore();
    }
    polyPath(ctx, o.points, ppm);
    ctx.lineJoin = 'round';
    engrave(ctx, cut);
  }
  if (labels && o.name) {
    const w = x1 - x0, h = y1 - y0;
    stoneText(ctx, o.name, x0 + w / 2, y0 + h / 2, w * 0.6, h * 0.5, !!paint);
  }
}

/** The stone version of drawVenue. */
function drawStone(ctx, venue, ppm, { ground, labels, scaleBar }) {
  const W = venue.width * ppm;
  const H = venue.height * ppm;
  const cut = Math.max(1.6, Math.min(4, ppm * 0.14));
  if (ground) {
    ctx.fillStyle = granite(ctx, 'mid');
    ctx.fillRect(0, 0, W, H);
    // soft weathering: lighter towards the middle, darker at the edges
    const gr = ctx.createRadialGradient(W * 0.55, H * 0.45, 0, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, 'rgba(255,255,255,.12)');
    gr.addColorStop(1, 'rgba(0,0,0,.14)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  }

  // roads: two engraved edges with lighter stone between
  const strokeWays = (style, extra) => {
    ctx.lineJoin = 'round';
    for (const P of venue.paths || []) {
      ctx.lineCap = 'round';
      ctx.beginPath();
      P.points.forEach((q, i) => (i ? ctx.lineTo(q.x * ppm, q.y * ppm) : ctx.moveTo(q.x * ppm, q.y * ppm)));
      style(Math.max(0.5, P.width || 3) * ppm + extra);
    }
    ctx.lineCap = 'square';
    for (const c of venue.corridors) {
      ctx.beginPath();
      if (c.axis === 'h') { ctx.moveTo(c.from * ppm, c.c * ppm); ctx.lineTo(c.to * ppm, c.c * ppm); }
      else { ctx.moveTo(c.c * ppm, c.from * ppm); ctx.lineTo(c.c * ppm, c.to * ppm); }
      style(Math.max(0.5, c.width || 3) * ppm + extra);
    }
  };
  strokeWays((w) => engrave(ctx, w), cut * 2);
  const light = granite(ctx, 'light');
  strokeWays((w) => { ctx.lineWidth = w; ctx.strokeStyle = light; ctx.stroke(); }, 0);

  for (const o of [...(venue.obstacles || []), ...groundParts(venue)]) stoneObstacle(ctx, o, ppm, labels, cut);

  for (const b of venue.blocks) {
    const x = b.x * ppm, y = b.y * ppm, w = b.w * ppm, h = b.h * ppm;
    const paint = STONE_PAINT[b.kind] ?? null;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    if (paint) paintFill(ctx, paint);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.lineJoin = 'miter';
    engrave(ctx, cut);
    if (labels && b.name) stoneText(ctx, b.name, x + w / 2, y + h / 2, w * 0.9, h * 0.8, !!paint);
  }

  if (scaleBar) stoneScaleBar(ctx, venue, ppm, cut);
}

function stoneScaleBar(ctx, venue, ppm, cut) {
  const nice = [1, 2, 5, 10, 20, 50, 100, 200];
  const m = nice.find((n) => n >= venue.width / 6) || 200;
  const px = m * ppm;
  const H = venue.height * ppm;
  const f = frameWidth(venue, ppm);
  const fs = Math.max(10, Math.min(28, ppm * 0.7));
  const x = f + fs, y = H - f - fs * 0.8;
  ctx.beginPath();
  ctx.moveTo(x, y - fs * 0.4);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - fs * 0.4);
  ctx.lineCap = 'square';
  engrave(ctx, Math.max(cut, fs * 0.1));
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = LIP;
  ctx.fillText(`${m} m`, x + px / 2 + 1, y - fs * 0.3 + 1);
  ctx.fillStyle = '#24262a';
  ctx.fillText(`${m} m`, x + px / 2, y - fs * 0.3);
}

const frameWidth = (venue, ppm) => Math.round(Math.max(10, Math.min(48, Math.min(venue.width, venue.height) * ppm * 0.022)));

/** Dark bevelled frame drawn inside the image (the image size, and so all coordinates, stay the same). */
function stoneFrame(ctx, W, H, f) {
  const side = (pts, color) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  side([[0, 0], [W, 0], [W - f, f], [f, f]], '#45484d'); // top, lit
  side([[0, 0], [f, f], [f, H - f], [0, H]], '#3a3d42'); // left
  side([[W, 0], [W, H], [W - f, H - f], [W - f, f]], '#1f2124'); // right, shade
  side([[0, H], [f, H - f], [W - f, H - f], [W, H]], '#18191c'); // bottom
  ctx.lineWidth = Math.max(1, f * 0.12);
  ctx.strokeStyle = 'rgba(176,150,92,.85)'; // worn brass edge
  ctx.strokeRect(f - ctx.lineWidth / 2, f - ctx.lineWidth / 2, W - 2 * f + ctx.lineWidth, H - 2 * f + ctx.lineWidth);
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [a, b, c, d] of [[0, 0, f, f], [W, 0, W - f, f], [0, H, f, H - f], [W, H, W - f, H - f]]) { ctx.moveTo(a, b); ctx.lineTo(c, d); }
  ctx.stroke();
}

/** Which legend rows a venue needs: [{label, paint, mark}] */
export function stoneLegend(venue) {
  const rows = [];
  const has = (k) => venue.blocks.some((b) => b.kind === k);
  const hasO = (k) => (venue.obstacles || []).some((o) => o.kind === k && o.shape !== 'wall');
  if (has('restroom')) rows.push({ label: '廁所', paint: 'white' });
  if (has('entrance') || (venue.obstacles || []).some((o) => o.shape === 'wall' && (o.doors || []).length)) rows.push({ label: '入口', paint: 'white', mark: 'door' });
  if (has('info')) rows.push({ label: '服務台', paint: 'yellow' });
  if (has('stage')) rows.push({ label: '舞台', paint: 'yellow' });
  if (has('booth')) rows.push({ label: '攤位', paint: 'yellow' });
  if (hasO('grass') || hasO('trees')) rows.push({ label: '草地', mark: 'dots' });
  if (hasO('water')) rows.push({ label: '水池', mark: 'water' });
  if (hasO('other')) rows.push({ label: '不能走', mark: 'hatch' });
  return rows;
}

function stoneLegendBox(ctx, venue, W, H, f, cut) {
  const rows = stoneLegend(venue);
  if (!rows.length) return;
  const fs = Math.round(Math.max(12, Math.min(30, Math.min(W, H) * 0.028)));
  const sw = fs * 1.4, lh = fs * 1.7;
  ctx.font = `700 ${fs}px ${FONT}`;
  const tw = Math.max(...rows.map((r) => ctx.measureText(r.label).width));
  const bw = sw + fs * 2.2 + tw + fs, bh = rows.length * lh + fs * 0.6;
  const bx = W - f - bw - fs * 0.6, by = H - f - bh - fs * 1.6;
  ctx.fillStyle = 'rgba(150,152,151,.55)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.beginPath();
  ctx.rect(bx, by, bw, bh);
  engrave(ctx, Math.max(1, cut * 0.7));
  rows.forEach((r, i) => {
    const y = by + fs * 0.3 + i * lh + lh / 2;
    const sx = bx + fs * 0.5;
    ctx.beginPath();
    ctx.rect(sx, y - sw * 0.35, sw, sw * 0.7);
    if (r.paint) paintFill(ctx, r.paint);
    if (r.mark) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = CUT; ctx.strokeStyle = CUT; ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (r.mark === 'dots') for (let k = 0; k < 4; k++) { const px = sx + sw * (0.2 + k * 0.2); ctx.moveTo(px + 1.5, y); ctx.arc(px, y, 1.5, 0, Math.PI * 2); }
      if (r.mark === 'water') { ctx.moveTo(sx, y); ctx.quadraticCurveTo(sx + sw / 4, y - 4, sx + sw / 2, y); ctx.quadraticCurveTo(sx + sw * 0.75, y + 4, sx + sw, y); }
      if (r.mark === 'hatch') for (let d = -sw; d < sw; d += 5) { ctx.moveTo(sx + d, y + sw); ctx.lineTo(sx + d + sw, y - sw); }
      if (r.mark === 'door') { ctx.fillStyle = '#24262a'; ctx.moveTo(sx + sw / 2 + 3, y); ctx.arc(sx + sw / 2, y, 3, 0, Math.PI * 2); }
      if (r.mark === 'dots' || r.mark === 'door') ctx.fill(); else ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.rect(sx, y - sw * 0.35, sw, sw * 0.7);
    engrave(ctx, Math.max(1, cut * 0.7));
    // "—— 廁所" as on the plaque
    const lx = sx + sw + fs * 0.4;
    ctx.beginPath();
    ctx.moveTo(lx, y);
    ctx.lineTo(lx + fs * 1.2, y);
    engrave(ctx, Math.max(1, cut * 0.6));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = LIP;
    ctx.fillText(r.label, lx + fs * 1.6 + 1, y + 1);
    ctx.fillStyle = '#24262a';
    ctx.fillText(r.label, lx + fs * 1.6, y);
  });
}
