// Magic wand for the map editor: take the similar-coloured region around a tapped pixel of the
// tracing photo and turn its outline into a polygon. Pure functions on RGBA image data, no DOM.

/** Pixels 4-connected to (sx, sy) whose colour is within tol (RGB distance) of the seed. */
export function floodRegion(img, sx, sy, tol = 40, maxCount = Infinity) {
  const { data, width: w, height: h } = img;
  const mask = new Uint8Array(w * h);
  sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
  const s = (sy * w + sx) * 4;
  const r0 = data[s], g0 = data[s + 1], b0 = data[s + 2];
  const t2 = tol * tol;
  const similar = (i) => {
    const dr = data[i * 4] - r0, dg = data[i * 4 + 1] - g0, db = data[i * 4 + 2] - b0;
    return dr * dr + dg * dg + db * db <= t2;
  };
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0, count = 0;
  queue[tail++] = sy * w + sx;
  mask[sy * w + sx] = 1;
  while (head < tail) {
    const i = queue[head++];
    if (++count > maxCount) return { mask, count, overflow: true };
    const x = i % w, y = (i / w) | 0;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const n of next) {
      if (n < 0 || mask[n] || !similar(n)) continue;
      mask[n] = 1;
      queue[tail++] = n;
    }
  }
  return { mask, count, overflow: false };
}

/**
 * Outer outline of the region in mask, along pixel edges (corner coordinates, so a pixel
 * x = 3 spans 3..4). Collinear points are dropped. Returns [] for an empty mask.
 */
export function traceOutline(mask, w, h) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const out = new Map(); // "x,y" → list of edge end points (clockwise boundary edges)
  const add = (ax, ay, bx, by) => {
    const k = `${ax},${ay}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([bx, by]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  let best = [], bestArea = 0;
  for (const start of [...out.keys()]) {
    while (out.get(start)?.length) {
      const loop = [];
      let k = start;
      while (out.get(k)?.length) {
        const [x, y] = k.split(',').map(Number);
        loop.push({ x, y });
        const [nx, ny] = out.get(k).pop();
        k = `${nx},${ny}`;
      }
      const a = Math.abs(loop.reduce((s, p, i) => {
        const q = loop[(i + 1) % loop.length];
        return s + p.x * q.y - q.x * p.y;
      }, 0)) / 2;
      if (a > bestArea) { bestArea = a; best = loop; }
    }
  }
  // drop collinear points
  return best.filter((p, i) => {
    const a = best[(i - 1 + best.length) % best.length], b = best[(i + 1) % best.length];
    return (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x) !== 0;
  });
}
