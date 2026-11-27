// Walkable-area analysis for illustrated / street-style maps (pure functions, no DOM):
// colour clustering → mask clean-up → remove wide open areas → skeleton →
// trace skeleton into paths → straight roads: orthogonalize (only up/down/left/right) → corridor
// lines; slanted or curved roads: simplified polylines (curves).
import { hLine, vLine } from './geometry.js';
import { simplify } from './curves.js';

// ---------- shrinking (the same on every browser) ----------
/**
 * Shrink RGBA pixels from W × H to w × h by taking the pixel at the centre of each output
 * pixel's block. Done here rather than by the browser's drawImage: browsers shrink differently
 * (iPhone Safari averages), and averaging blends roads only a few pixels wide into the ground,
 * so the same map gave very different road networks on different devices.
 */
export function sampleRGBA(data, W, H, w, h) {
  if (w === W && h === H) return Uint8ClampedArray.from(data);
  const out = new Uint8ClampedArray(w * h * 4);
  const xs = Int32Array.from({ length: w }, (_, x) => Math.min(W - 1, Math.floor(((x + 0.5) * W) / w)));
  for (let y = 0; y < h; y++) {
    const sy = Math.min(H - 1, Math.floor(((y + 0.5) * H) / h)) * W;
    for (let x = 0; x < w; x++) {
      const i = (sy + xs[x]) * 4, o = (y * w + x) * 4;
      out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
    }
  }
  return out;
}

/** Area-average W × H down to w × h (every source pixel counted in exactly one output pixel). */
export function boxRGBA(data, W, H, w, h) {
  if (w === W && h === H) return Uint8ClampedArray.from(data);
  const acc = new Float64Array(w * h * 4), cnt = new Float64Array(w * h);
  const xs = Int32Array.from({ length: W }, (_, x) => Math.min(w - 1, Math.floor((x * w) / W)));
  for (let y = 0; y < H; y++) {
    const ry = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0; x < W; x++) {
      const k = ry + xs[x], i = (y * W + x) * 4;
      acc[k * 4] += data[i]; acc[k * 4 + 1] += data[i + 1]; acc[k * 4 + 2] += data[i + 2]; acc[k * 4 + 3] += data[i + 3];
      cnt[k]++;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) for (let c = 0; c < 4; c++) out[k * 4 + c] = Math.round(acc[k * 4 + c] / (cnt[k] || 1));
  return out;
}

/**
 * Shrink for analysis, the same on every browser: average down to twice the target size
 * (smooths paper texture, hatching and JPEG noise), then sample every other pixel (sampleRGBA).
 * Roads a few pixels wide are still several pixels wide at twice the size, so the samples
 * always land on road colour instead of a blend with the ground.
 */
export function shrinkRGBA(data, W, H, w, h) {
  const mw = Math.min(W, 2 * w), mh = Math.min(H, 2 * h);
  return sampleRGBA(boxRGBA(data, W, H, mw, mh), mw, mh, w, h);
}

/**
 * Small mask from a full-size test: an output pixel is set when at least minShare of the
 * full-size pixels in its block pass test(r, g, b). Thin features (white roads 6 px wide on a
 * 1500 px map) survive, whatever the browser would have done when shrinking.
 */
export function coverageMask(data, W, H, w, h, test, minShare) {
  const hit = new Uint32Array(w * h), cnt = new Uint32Array(w * h);
  const xs = Int32Array.from({ length: W }, (_, x) => Math.min(w - 1, Math.floor((x * w) / W)));
  for (let y = 0; y < H; y++) {
    const ry = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0; x < W; x++) {
      const k = ry + xs[x], i = (y * W + x) * 4;
      cnt[k]++;
      if (test(data[i], data[i + 1], data[i + 2])) hit[k]++;
    }
  }
  return Uint8Array.from(hit, (v, k) => (cnt[k] && v / cnt[k] >= minShare ? 1 : 0));
}

// ---------- colour clustering ----------
/** Deterministic k-means on RGB pixels. rgb: Uint8Array(3n). Returns {centers, labels, counts}. */
export function kmeans(rgb, n, k = 6, iters = 20) {
  const step = Math.max(1, Math.floor(n / 40000));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  const d2 = (i, c) => {
    const r = rgb[i * 3] - c[0], g = rgb[i * 3 + 1] - c[1], b = rgb[i * 3 + 2] - c[2];
    return r * r + g * g + b * b;
  };
  // Deterministic start (k-means++ picks random pixels, so a 1-pixel shift of the same map
  // could merge the path colour into a neighbour): the peaks of a smoothed 32³ colour
  // histogram, largest first, at least 24 apart; each starts at its neighbourhood's mean colour.
  const B = 32, idx = (r, g, b) => ((r >> 3) * B + (g >> 3)) * B + (b >> 3);
  const hist = new Float64Array(B * B * B), sums = new Float64Array(B * B * B * 3);
  for (const i of sample) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2], q = idx(r, g, b);
    hist[q]++; sums[q * 3] += r; sums[q * 3 + 1] += g; sums[q * 3 + 2] += b;
  }
  const around = (q, f) => {
    const r = Math.floor(q / (B * B)), g = Math.floor(q / B) % B, b = q % B;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const R = r + dr, G = g + dg, Bb = b + db;
      if (R >= 0 && G >= 0 && Bb >= 0 && R < B && G < B && Bb < B) f((R * B + G) * B + Bb);
    }
  };
  const smooth = new Float64Array(B * B * B);
  for (let q = 0; q < smooth.length; q++) if (hist[q]) around(q, (o) => { smooth[o] += hist[q]; });
  const peaks = [];
  for (let q = 0; q < smooth.length; q++) {
    if (!hist[q]) continue;
    let top = true;
    // ties on a flat plateau go to the bin with the most pixels of its own, then the lower index
    around(q, (o) => {
      if (smooth[o] > smooth[q] || (smooth[o] === smooth[q] && (hist[o] > hist[q] || (hist[o] === hist[q] && o < q)))) top = false;
    });
    if (top) peaks.push(q);
  }
  peaks.sort((a, b) => smooth[b] - smooth[a] || a - b);
  const centers = [];
  for (const q of peaks) {
    if (centers.length >= k) break;
    const m = [0, 0, 0, 0];
    around(q, (o) => { m[0] += sums[o * 3]; m[1] += sums[o * 3 + 1]; m[2] += sums[o * 3 + 2]; m[3] += hist[o]; });
    const c = [m[0] / m[3], m[1] / m[3], m[2] / m[3]];
    if (centers.every((d) => Math.hypot(c[0] - d[0], c[1] - d[1], c[2] - d[2]) >= 24)) centers.push(c);
  }
  if (!centers.length && sample.length) centers.push([rgb[sample[0] * 3], rgb[sample[0] * 3 + 1], rgb[sample[0] * 3 + 2]]);
  const nearest = (i) => {
    let best = 0, bd = Infinity;
    centers.forEach((c, j) => {
      const d = d2(i, c);
      if (d < bd) { bd = d; best = j; }
    });
    return best;
  };
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const i of sample) {
      const a = acc[nearest(i)];
      a[0] += rgb[i * 3]; a[1] += rgb[i * 3 + 1]; a[2] += rgb[i * 3 + 2]; a[3]++;
    }
    acc.forEach((a, j) => { if (a[3]) centers[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const labels = new Uint8Array(n);
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[(labels[i] = nearest(i))]++;
  return { centers, labels, counts };
}

// ---------- morphology ----------
function boxFilter(mask, w, h, r, wantMax) {
  // separable square min/max filter
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const agg = wantMax ? (a, b) => a | b : (a, b) => a & b;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = wantMax ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        v = agg(v, mask[y * w + xx]);
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = wantMax ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        v = agg(v, tmp[yy * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
export const dilate = (m, w, h, r) => boxFilter(m, w, h, r, true);
export const erode = (m, w, h, r) => boxFilter(m, w, h, r, false);
/** Closing: fills small gaps (dashes, thin text strokes) inside a region. */
export const closing = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);
/** Opening: removes specks and hair-thin bridges. */
export const opening = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);

/** Chamfer distance from every 1-pixel to the nearest 0-pixel (outside the image counts as 1). */
export function distanceTransform(mask, w, h) {
  const INF = 1e9, D = 1.4142;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Remove wide open areas (plazas, page background) and keep narrow structures (paths, roads):
 * pixels farther than R from any edge are "core"; everything within R of a core pixel is wide.
 */
export function removeWide(mask, w, h, R) {
  const d = distanceTransform(mask, w, h);
  const notCore = Uint8Array.from(d, (v) => (v > R ? 0 : 1));
  const toCore = distanceTransform(notCore, w, h);
  return Uint8Array.from(mask, (v, i) => (v && toCore[i] > R + 1 ? 1 : 0));
}

/**
 * Fill small holes inside a region: enclosed non-region blobs (trees, icons, characters
 * drawn on a path or plaza) smaller than maxArea pixels become part of the region.
 */
export function fillSmallHoles(mask, w, h, maxArea, minRim = 0) {
  const out = Uint8Array.from(mask);
  // Only fill holes that sit inside a wide area (a tree on an avenue), not the blocks
  // enclosed by a network of thin roads: the region around the hole must be ≥ minRim thick.
  const dt = minRim ? distanceTransform(mask, w, h) : null;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blob = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i] || seen[i]) continue;
    let sp = 0, touchesEdge = false, rim = 0;
    blob.length = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp) {
      const q = stack[--sp];
      blob.push(q);
      const x = q % w, y = (q - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
      for (const r of [q - w, q + w, x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1]) {
        if (r < 0 || r >= w * h) continue;
        if (mask[r]) { if (dt && dt[r] > rim) rim = dt[r]; continue; }
        if (!seen[r]) { seen[r] = 1; stack[sp++] = r; }
      }
    }
    if (!touchesEdge && blob.length <= maxArea && (!minRim || rim >= minRim)) for (const q of blob) out[q] = 1;
  }
  return out;
}

// ---------- skeleton ----------
/** Zhang–Suen thinning. */
export function skeletonize(mask, w, h) {
  const m = Uint8Array.from(mask);
  for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1];
          const p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

const RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** Number of 0→1 transitions around the 8-ring: 1 = endpoint, ≥3 = junction. */
function crossing(sk, w, h, x, y) {
  let c = 0;
  for (let k = 0; k < 8; k++) {
    const [ax, ay] = RING[k], [bx, by] = RING[(k + 1) % 8];
    const a = sk[(y + ay) * w + x + ax] || 0, b = sk[(y + by) * w + x + bx] || 0;
    if (!a && b) c++;
  }
  return c;
}

/**
 * Trace a skeleton into paths between nodes (endpoints / junctions).
 * Returns [{pts:[{x,y}], a:'end'|'junction', b:'end'|'junction'}].
 */
export function traceSkeleton(sk, w, h) {
  const kind = new Uint8Array(w * h); // 0 none, 1 path, 2 endpoint, 3 junction
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!sk[i]) continue;
      const c = crossing(sk, w, h, x, y);
      kind[i] = c === 1 ? 2 : c >= 3 ? 3 : c === 0 ? 2 : 1;
    }
  }
  // Group adjacent junction pixels; each group is represented by its first pixel.
  const rep = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (kind[i] !== 3 || rep[i] >= 0) continue;
    const stack = [i];
    rep[i] = i;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      for (const [dx, dy] of RING) {
        const q = (y + dy) * w + x + dx;
        if (kind[q] === 3 && rep[q] < 0) { rep[q] = i; stack.push(q); }
      }
    }
  }
  const nodeOf = (i) => (kind[i] === 3 ? rep[i] : i);
  const pt = (i) => ({ x: i % w, y: Math.floor(i / w) });
  const visited = new Uint8Array(w * h);
  const paths = [];

  const walk = (start, first) => {
    const pts = [pt(nodeOf(start)), pt(first)];
    let prev = start, cur = first;
    while (kind[cur] === 1 && !visited[cur]) {
      visited[cur] = 1;
      const x = cur % w, y = (cur - x) / w;
      let next = -1;
      // prefer 4-neighbours, then diagonals
      for (const k of [0, 2, 4, 6, 1, 3, 5, 7]) {
        const [dx, dy] = RING[k];
        const q = (y + dy) * w + x + dx;
        if (!sk[q] || q === prev || (kind[q] === 1 && visited[q])) continue;
        if (kind[q] === 3 && nodeOf(q) === nodeOf(start) && pts.length < 3) continue;
        next = q;
        break;
      }
      if (next < 0) break;
      prev = cur;
      cur = next;
      pts.push(kind[cur] === 3 ? pt(nodeOf(cur)) : pt(cur));
    }
    const endKind = kind[cur] === 3 ? 'junction' : 'end';
    return { pts, a: kind[start] === 3 ? 'junction' : 'end', b: endKind };
  };

  for (let i = 0; i < w * h; i++) {
    if (kind[i] < 2) continue;
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of RING) {
      const q = (y + dy) * w + x + dx;
      if (!sk[q]) continue;
      if (kind[q] === 1 && visited[q]) continue;
      if (kind[q] === 3 && nodeOf(q) === nodeOf(i)) continue;
      if (kind[q] >= 2) {
        // two nodes touching directly
        if (q > i) paths.push({ pts: [pt(nodeOf(i)), pt(nodeOf(q))], a: 'junction', b: 'junction' });
        continue;
      }
      paths.push(walk(i, q));
    }
  }
  // closed loops with no node at all
  for (let i = 0; i < w * h; i++) {
    if (kind[i] === 1 && !visited[i]) {
      const x = i % w, y = (i - x) / w;
      const q = RING.map(([dx, dy]) => (y + dy) * w + x + dx).find((j) => kind[j] === 1 && !visited[j]);
      visited[i] = 1;
      if (q !== undefined) {
        const p = walk(i, q);
        p.pts.push(pt(i));
        paths.push(p);
      }
    }
  }
  // A walk can stop a pixel or two short of a junction (tiny loops around the junction
  // block it). Snap such loose ends onto the nearest junction so the network stays connected.
  const junctions = [];
  for (const p of paths) {
    if (p.a === 'junction') junctions.push(p.pts[0]);
    if (p.b === 'junction') junctions.push(p.pts.at(-1));
  }
  const SNAP = 4;
  for (const p of paths) {
    for (const end of ['a', 'b']) {
      if (p[end] !== 'end') continue;
      const q = end === 'a' ? p.pts[0] : p.pts.at(-1);
      let best = null, bd = SNAP;
      for (const j of junctions) {
        const d = Math.hypot(j.x - q.x, j.y - q.y);
        if (d > 0 && d <= bd) { bd = d; best = j; }
      }
      if (best) {
        if (end === 'a') p.pts.unshift({ ...best });
        else p.pts.push({ ...best });
        p[end] = 'junction';
      }
    }
  }
  return paths.filter((p) => p.pts.length >= 2);
}

const pathLen = (pts) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
};

/** Drop short dead-end spurs (one end free, other end at a junction). */
export function pruneSpurs(paths, minLen) {
  return paths.filter((p) => !(p.a !== p.b && pathLen(p.pts) < minLen));
}

/**
 * Convert a pixel path into axis-aligned segments (greedy): keep going horizontally or
 * vertically until the path drifts more than `tol` off-axis, then turn 90°. The first and
 * last points are kept exactly, so paths sharing a junction stay connected.
 */
export function orthogonalize(pts, tol) {
  const segs = [];
  let s = { ...pts[0] };
  let dir = null;
  const push = (a, b) => { if (a.x !== b.x || a.y !== b.y) segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }); };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const dx = p.x - s.x, dy = p.y - s.y;
    if (!dir) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) > tol) dir = Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V';
      continue;
    }
    if (dir === 'H' && Math.abs(dy) > tol) {
      const c = { x: p.x, y: s.y };
      push(s, c);
      s = c;
      dir = 'V';
    } else if (dir === 'V' && Math.abs(dx) > tol) {
      const c = { x: s.x, y: p.y };
      push(s, c);
      s = c;
      dir = 'H';
    }
  }
  const e = pts[pts.length - 1];
  const c = dir === 'V' ? { x: s.x, y: e.y } : { x: e.x, y: s.y };
  push(s, c);
  push(c, e);
  return segs;
}

/**
 * Is this traced path a straight (horizontal / vertical) road? Simplified to a polyline, every
 * piece must run within maxDeg of an axis; pieces shorter than minLen (junction wiggles) are ignored.
 */
export function isAxisPath(poly, maxDeg = 12, minLen = 0) {
  for (let i = 1; i < poly.length; i++) {
    const dx = Math.abs(poly[i].x - poly[i - 1].x), dy = Math.abs(poly[i].y - poly[i - 1].y);
    if (Math.hypot(dx, dy) < minLen) continue;
    const off = (Math.atan2(Math.min(dx, dy), Math.max(dx, dy)) * 180) / Math.PI;
    if (off > maxDeg) return false;
  }
  return true;
}

/**
 * Skeleton-based corridors (mask coordinates). Roads that run horizontally or vertically become
 * straight corridors (orthogonal segments, as before); slanted or curved roads become curves
 * { id, points } along their middle instead of a staircase. opt.curves = false: everything as
 * a staircase (the old behaviour).
 */
export function skeletonCorridors(mask, w, h, opt = {}) {
  const maxEdge = Math.max(w, h);
  const sk = skeletonize(mask, w, h);
  let paths = traceSkeleton(sk, w, h);
  const minSpur = opt.minSpur ?? maxEdge * 0.04;
  for (let k = 0; k < 2; k++) paths = pruneSpurs(paths, minSpur);
  const tol = opt.tol ?? Math.max(2, maxEdge * 0.02);
  const eps = opt.curveEps ?? Math.max(2, maxEdge * 0.01);
  const lines = [], curves = [];
  let n = 0;
  let dist = null; // distance to the road's edge, computed once a curve turns up
  for (const p of paths) {
    const poly = simplify(p.pts, eps);
    if (opt.curves !== false && !isAxisPath(poly, opt.maxDeg ?? 12, 2 * eps)) {
      // Keep the curve inside the road: on thin roads simplify to half the road's half-width.
      let outEps = opt.curveOutEps;
      if (outEps == null) {
        dist ??= distanceTransform(mask, w, h);
        const ds = p.pts.map((q) => dist[q.y * w + q.x]).sort((a, b) => a - b);
        outEps = Math.min(eps, Math.max(1, 0.5 * (ds[ds.length >> 1] || 0)));
      }
      curves.push({ id: `C${curves.length + 1}`, points: outEps < eps ? simplify(p.pts, outEps) : poly }); // ends stay exactly on the junctions
      continue;
    }
    for (const s of orthogonalize(p.pts, tol)) {
      n++;
      lines.push(s.y0 === s.y1 ? hLine(`S${n}`, s.y0, s.x0, s.x1) : vLine(`S${n}`, s.x0, s.y0, s.y1));
    }
  }
  return { lines, paths: curves, skeletonPixels: sk.reduce((a, b) => a + b, 0) };
}
