// Find the map in a photo and straighten it (perspective correction).
// Pure functions on ImageData-like objects { data, width, height } so they run in Node tests;
// detectMapQuad() and rectifyCanvas() are the browser wrappers.
// Corners are always ordered top-left, top-right, bottom-right, bottom-left.

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Area of a polygon (always positive). */
export function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Sort four points into top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  const s = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  let k = 0;
  s.forEach((p, i) => { if (p.x + p.y < s[k].x + s[k].y) k = i; });
  return [...s.slice(k), ...s.slice(0, k)];
}

function segmentsCross(a, b, c, d) {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Why this quad (in drawing order) cannot be used, or null when it is fine. */
export function quadProblem(q, w, h) {
  if (segmentsCross(q[0], q[1], q[2], q[3]) || segmentsCross(q[1], q[2], q[3], q[0]))
    return '四個角交叉了，請把每個角拖回地圖對應的角';
  const signs = q.map((p, i) => Math.sign(cross(p, q[(i + 1) % 4], q[(i + 2) % 4])));
  if (!signs[0] || signs.some((s) => s !== signs[0])) return '框凹進去了，請把角拖到地圖的角上';
  if (polyArea(q) < 0.04 * w * h) return '框太小了，請把四個角拖到地圖的四個角';
  return null;
}

/** 3 × 3 homography (row-major, h[8] = 1) that maps src[i] → dst[i]. */
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // Gauss–Jordan elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((row, i) => row[8] / row[i]), 1];
}

export function applyH(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Width and height of the straightened map: averages of opposite edges, long edge ≤ maxEdge. */
export function outputSize(q, maxEdge) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Straighten the quad of src into an outW × outH image (bilinear sampling). */
export function warpRGBA(src, quad, outW, outH) {
  const { data: S, width: W, height: Hh } = src;
  const H = homography([{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }], quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const yy = y + 0.5;
    let nx = H[1] * yy + H[2] + H[0] * 0.5, ny = H[4] * yy + H[5] + H[3] * 0.5, nw = H[7] * yy + H[8] + H[6] * 0.5;
    for (let x = 0; x < outW; x++, nx += H[0], ny += H[3], nw += H[6]) {
      const u = Math.min(W - 1, Math.max(0, nx / nw - 0.5)), v = Math.min(Hh - 1, Math.max(0, ny / nw - 0.5));
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(Hh - 1, y0 + 1);
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = S[i00 + c] + (S[i10 + c] - S[i00 + c]) * fx;
        const bot = S[i01 + c] + (S[i11 + c] - S[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

function convexHull(pts) {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lo = [], hi = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** The largest quadrilateral with corners on the convex hull (O(n³), n capped). */
function maxAreaQuad(hull) {
  let h = hull;
  if (h.length > 120) { const k = h.length / 120; h = Array.from({ length: 120 }, (_, i) => hull[Math.floor(i * k)]); }
  const n = h.length;
  if (n < 4) return null;
  const tri = (a, b, c) => Math.abs(cross(a, b, c)) / 2;
  let best = -1, quad = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < i + n - 1; k++) {
      let bj = -1, aj = -1;
      for (let j = i + 1; j < k; j++) { const a = tri(h[i], h[j % n], h[k % n]); if (a > aj) { aj = a; bj = j; } }
      let bl = -1, al = -1;
      for (let l = k + 1; l < i + n; l++) { const a = tri(h[i], h[k % n], h[l % n]); if (a > al) { al = a; bl = l; } }
      if (aj + al > best) { best = aj + al; quad = [h[i], h[bj % n], h[k % n], h[bl % n]]; }
    }
  }
  return quad;
}

/**
 * Where is the map in this photo? Grows a region of the map's own colour out from the centre
 * (maps are photographed in the middle, against grass / walls / desks), fills the holes left by
 * the drawing, and fits the largest quadrilateral. Several colour tolerances are tried (sunlight
 * and glare make one board several shades); the one that looks most like a solid four-sided board
 * wins. A region that runs into the photo's edges is not a board in front of a background.
 * Returns { quad, full }: full = true means "the whole image is the map" (screenshots, scans,
 * or nothing convincing was found) and quad is then the image's own corners.
 */
export function findMapQuad(img, { maxEdge = 320, minArea = 0.15, maxArea = 0.92, tries = null } = {}) {
  const W = img.width, H = img.height;
  const whole = { full: true, quad: [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }] };
  const s = Math.min(1, maxEdge / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
  const sx = w / W, sy = h / H;
  // box-average downscale
  const acc = new Float32Array(w * h * 3), cnt = new Float32Array(w * h);
  const D = img.data;
  for (let y = 0; y < H; y++) {
    const ry = Math.min(h - 1, Math.floor(y * sy)) * w;
    for (let x = 0; x < W; x++) {
      const k = ry + Math.min(w - 1, Math.floor(x * sx)), i = (y * W + x) * 4;
      acc[k * 3] += D[i]; acc[k * 3 + 1] += D[i + 1]; acc[k * 3 + 2] += D[i + 2]; cnt[k]++;
    }
  }
  for (let k = 0; k < w * h; k++) for (let c = 0; c < 3; c++) acc[k * 3 + c] /= cnt[k] || 1;
  // 3 × 3 blur: stone speckle and paper texture
  const col = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const k = (yy * w + xx) * 3;
      r += acc[k]; g += acc[k + 1]; b += acc[k + 2]; n++;
    }
    const k = (y * w + x) * 3;
    col[k] = r / n; col[k + 1] = g / n; col[k + 2] = b / n;
  }
  // seed colour: median of the central patch
  const px0 = Math.floor(w * 0.42), px1 = Math.ceil(w * 0.58), py0 = Math.floor(h * 0.42), py1 = Math.ceil(h * 0.58);
  const ch = [[], [], []];
  for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) for (let c = 0; c < 3; c++) ch[c].push(col[(y * w + x) * 3 + c]);
  const seed = ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
  const d2 = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const r = col[k * 3] - seed[0], g = col[k * 3 + 1] - seed[1], b = col[k * 3 + 2] - seed[2];
    d2[k] = r * r + g * g + b * b;
  }

  const mask = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const spread = (k, test) => { // 4-neighbours of k that pass test()
    const x = k % w;
    if (x > 0 && test(k - 1)) queue[qt++] = k - 1;
    if (x < w - 1 && test(k + 1)) queue[qt++] = k + 1;
    if (k >= w && test(k - w)) queue[qt++] = k - w;
    if (k < w * (h - 1) && test(k + w)) queue[qt++] = k + w;
  };
  let qh = 0, qt = 0;
  let best = null;
  let edgeArea = 0; // largest region that runs into the photo's edges
  for (const T of [18, 26, 36, 48, 62, 80, 100, 120, 140]) {
    const T2 = T * T;
    const grow = (m) => (!mask[m] && d2[m] < T2 ? (mask[m] = 1) : 0);
    const fill = (m) => (!mask[m] && !outside[m] ? (outside[m] = 1) : 0);
    mask.fill(0);
    qh = qt = 0;
    for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) if (grow(y * w + x)) queue[qt++] = y * w + x;
    while (qh < qt) spread(queue[qh++], grow);
    // fill holes: everything not reachable from the border without crossing the region
    outside.fill(0);
    qh = qt = 0;
    for (let x = 0; x < w; x++) for (const k of [x, (h - 1) * w + x]) if (fill(k)) queue[qt++] = k;
    for (let y = 0; y < h; y++) for (const k of [y * w, y * w + w - 1]) if (fill(k)) queue[qt++] = k;
    while (qh < qt) spread(queue[qh++], fill);
    let count = 0;
    const pts = [];
    for (let y = 0; y < h; y++) {
      let x0 = -1, x1 = -1;
      for (let x = 0; x < w; x++) if (!outside[y * w + x]) { if (x0 < 0) x0 = x; x1 = x; count++; }
      if (x0 >= 0) pts.push({ x: x0, y }, { x: x0, y: y + 1 }, { x: x1 + 1, y }, { x: x1 + 1, y: y + 1 });
    }
    if (count < minArea * w * h) continue;
    const hull = convexHull(pts);
    const quad = maxAreaQuad(hull);
    if (!quad) continue;
    const qa = polyArea(quad), ha = polyArea(hull);
    const m = 0.01 * Math.max(w, h);
    const onEdge = quad.filter((p) => p.x <= m || p.y <= m || p.x >= w - m || p.y >= h - m).length;
    const score = (qa / ha) * (count / ha);
    const ok = onEdge < 2 && // runs into the photo's edges: the map itself fills the photo
      qa >= minArea * w * h && qa <= maxArea * w * h && // not tiny, not the whole photo
      qa >= 0.9 * ha && // four-sided, not a blob
      count >= 0.85 * ha && // solid
      !quadProblem(orderCorners(quad), w, h);
    if (ok && (!best || score > best.score)) best = { score, quad, qa };
    if (onEdge >= 2) edgeArea = Math.max(edgeArea, qa);
    tries?.push({ T, area: +(qa / (w * h)).toFixed(3), quadOfHull: +(qa / ha).toFixed(3), solid: +(count / ha).toFixed(3), onEdge, ok });
  }
  // a looser tolerance reaches the photo's edges: what was found is one block of a map that fills the photo
  if (!best || edgeArea > best.qa) return whole;
  const lum = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) lum[k] = (col[k * 3] + col[k * 3 + 1] + col[k * 3 + 2]) / 3;
  const quad = snapEdges(lum, w, h, orderCorners(best.quad), Math.max(3, Math.round(0.02 * Math.max(w, h))));
  return { full: false, quad: quad.map((p) => ({ x: p.x / sx, y: p.y / sy })) };
}

/**
 * Move each edge (both ends independently, up to r px along its normal) to where the
 * brightness differs most between just inside and just outside: the board's edge, not a
 * frame's outer rim or a shadow next to it. Corners are where the moved edges meet.
 */
function snapEdges(lum, w, h, q, r) {
  const L = (x, y) => lum[Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))];
  const c = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
  const edges = q.map((p, i) => {
    const e = q[(i + 1) % 4];
    const len = dist(p, e);
    let n = { x: (e.y - p.y) / len, y: -(e.x - p.x) / len };
    const mid = { x: (p.x + e.x) / 2, y: (p.y + e.y) / 2 };
    if ((mid.x - c.x) * n.x + (mid.y - c.y) * n.y < 0) n = { x: -n.x, y: -n.y }; // outward
    let best = { v: -1, a: 0, b: 0 };
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      let s = 0, k = 0;
      for (let t = 0.1; t <= 0.9; t += 0.05) {
        const x = p.x + (e.x - p.x) * t + n.x * (a + (b - a) * t), y = p.y + (e.y - p.y) * t + n.y * (a + (b - a) * t);
        s += L(x - 1.5 * n.x, y - 1.5 * n.y) - L(x + 1.5 * n.x, y + 1.5 * n.y);
        k++;
      }
      const v = Math.abs(s / k) - 0.5 * (Math.abs(a) + Math.abs(b)) / r; // prefer small moves on ties
      if (v > best.v) best = { v, a, b };
    }
    return [{ x: p.x + n.x * best.a, y: p.y + n.y * best.a }, { x: e.x + n.x * best.b, y: e.y + n.y * best.b }];
  });
  const meet = ([p1, p2], [p3, p4]) => {
    const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(d) < 1e-9) return p2;
    const a = p1.x * p2.y - p1.y * p2.x, b = p3.x * p4.y - p3.y * p4.x;
    return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
  };
  const out = q.map((_, i) => meet(edges[(i + 3) % 4], edges[i]));
  return quadProblem(out, w, h) ? q : out;
}

// ---------- browser ----------

/** findMapQuad on a canvas (any size); the quad is in that canvas's coordinates. */
export function detectMapQuad(canvas, maxEdge = 640) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, c.width, c.height);
  const f = findMapQuad(g.getImageData(0, 0, c.width, c.height));
  const kx = canvas.width / c.width, ky = canvas.height / c.height;
  return { full: f.full, quad: f.quad.map((p) => ({ x: p.x * kx, y: p.y * ky })) };
}

/**
 * Straighten the quad (in source coordinates) of a full-resolution image (canvas or ImageBitmap).
 * Only the quad's bounding box is read, at most 4096 px / 16 MP (phone canvas limits).
 */
export function rectifyCanvas(source, quad, maxEdge = 3000) {
  const { w, h } = outputSize(quad, maxEdge);
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(source.width, Math.ceil(Math.max(...xs))), y1 = Math.min(source.height, Math.ceil(Math.max(...ys)));
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const k = Math.min(1, 4096 / Math.max(bw, bh), Math.sqrt(16e6 / (bw * bh)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bw * k));
  c.height = Math.max(1, Math.round(bh * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, x0, y0, bw, bh, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const kx = c.width / bw, ky = c.height / bh;
  const out = warpRGBA(img, quad.map((p) => ({ x: (p.x - x0) * kx, y: (p.y - y0) * ky })), w, h);
  const oc = document.createElement('canvas');
  oc.width = w;
  oc.height = h;
  oc.getContext('2d').putImageData(new ImageData(out.data, w, h), 0, 0);
  return oc;
}
