// Infer axis-aligned corridors from a walkable mask (1 = free space, 0 = blocked).
// Long free runs in consecutive rows form a horizontal band → line y = band centre.
// Same for columns → vertical lines. Pure function, no DOM.
import { hLine, vLine } from './geometry.js';

function runsOf(get, n, minLen) {
  const runs = [];
  let s = -1;
  for (let i = 0; i <= n; i++) {
    const free = i < n && get(i);
    if (free && s < 0) s = i;
    if (!free && s >= 0) {
      if (i - s >= minLen) runs.push([s, i - 1]);
      s = -1;
    }
  }
  return runs;
}

const median = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};

function bands(free, w, h, vertical, minLen, minThick) {
  const nRows = vertical ? w : h;
  const nCols = vertical ? h : w;
  const get = vertical ? (r) => (i) => free[i * w + r] : (r) => (i) => free[r * w + i];
  const out = [];
  let active = [];
  for (let r = 0; r <= nRows; r++) {
    const runs = r < nRows ? runsOf(get(r), nCols, minLen) : [];
    const next = [];
    for (const run of runs) {
      const b = active.find((band) => {
        const [s, e] = band.last;
        const ov = Math.min(e, run[1]) - Math.max(s, run[0]);
        return ov >= 0.5 * Math.min(e - s, run[1] - run[0]) && !next.includes(band);
      });
      if (b) {
        b.r1 = r;
        b.last = run;
        b.starts.push(run[0]);
        b.ends.push(run[1]);
        next.push(b);
      } else {
        next.push({ r0: r, r1: r, last: run, starts: [run[0]], ends: [run[1]] });
      }
    }
    for (const b of active) if (!next.includes(b)) out.push(b);
    active = next;
  }
  return out
    .filter((b) => b.r1 - b.r0 + 1 >= minThick)
    .map((b) => ({
      c: (b.r0 + b.r1) / 2,
      thick: b.r1 - b.r0 + 1,
      range: [median(b.starts), median(b.ends)],
    }));
}

/** Merge parallel bands whose centres are close and ranges overlap. */
function mergeClose(list, gap) {
  const sorted = [...list].sort((a, b) => a.c - b.c);
  const out = [];
  for (const b of sorted) {
    const prev = out.find(
      (o) => Math.abs(o.c - b.c) <= gap && Math.min(o.range[1], b.range[1]) > Math.max(o.range[0], b.range[0])
    );
    if (prev) {
      const wsum = prev.thick + b.thick;
      prev.c = (prev.c * prev.thick + b.c * b.thick) / wsum;
      prev.thick = wsum;
      prev.range = [Math.min(prev.range[0], b.range[0]), Math.max(prev.range[1], b.range[1])];
    } else out.push({ ...b, range: [...b.range] });
  }
  return out;
}

/**
 * Keep only the largest 4-connected free region. Enclosed booth/room interiors are
 * separate regions, so this leaves the connected corridor network.
 */
export function keepLargestComponent(free, w, h) {
  const { label, comps } = connectedComponents(free, w, h);
  const best = comps.reduce((b, c) => (!b || c.size > b.size ? c : b), null);
  return Uint8Array.from(label, (l) => (best && l === best.id ? 1 : 0));
}

/** 4-connected components of a binary mask, with size and bounding box. */
export function connectedComponents(free, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!free[i] || label[i]) continue;
    const c = { id: comps.length + 1, size: 0, x0: w, y0: h, x1: 0, y1: 0 };
    comps.push(c);
    let sp = 0;
    stack[sp++] = i;
    label[i] = c.id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      c.size++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
        if (q >= 0 && q < w * h && free[q] && !label[q]) {
          label[q] = c.id;
          stack[sp++] = q;
        }
      }
    }
  }
  return { label, comps };
}

/**
 * @param {Uint8Array} free  w*h mask, 1 = walkable
 * @returns {{lines: object[], thickness: number}}  lines in mask pixel coordinates
 */
export function inferCorridors(input, w, h, opt = {}) {
  const free = opt.largestOnly === false ? input : keepLargestComponent(input, w, h);
  const minLenRatio = opt.minLenRatio ?? 0.2;
  const minThick = Math.max(2, Math.round(Math.min(w, h) * (opt.minThickRatio ?? 0.03)));
  const hb = mergeClose(bands(free, w, h, false, minLenRatio * w, minThick), minThick * 1.5);
  const vb = mergeClose(bands(free, w, h, true, minLenRatio * h, minThick), minThick * 1.5);
  const lines = [
    ...hb.map((b, i) => hLine(`H${i + 1}`, b.c, b.range[0], b.range[1])),
    ...vb.map((b, i) => vLine(`V${i + 1}`, b.c, b.range[0], b.range[1])),
  ];
  const thick = [...hb, ...vb].map((b) => b.thick);
  return { lines, thickness: thick.length ? median(thick) : minThick };
}
