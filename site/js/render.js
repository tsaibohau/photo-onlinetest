// Draws a map image plus corridors, nodes, anchors, objects and the user dot on a canvas.
import { isH } from './geometry.js';

export class MapView {
  /**
   * opt.zoom: pinch / wheel / drag to zoom and pan (k = 1 shows the whole map); opt.onTap(e) is
   * called for a tap that was not part of a drag or pinch, so zooming never counts as a tap.
   */
  constructor(canvas, image, opt = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = image;
    this.layers = {};
    this.k = 1; // zoom
    this.ox = 0; // map px at the view's top-left corner
    this.oy = 0;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas.parentElement);
    if (opt.zoom) this.gestures(opt.onTap);
  }

  /** Map px per css px of the canvas when the whole map is shown. */
  get fitK() {
    return this.image.width / (this.canvas.getBoundingClientRect().width || 1);
  }

  clampPan() {
    this.k = Math.min(12, Math.max(1, this.k));
    this.ox = Math.min(this.image.width * (1 - 1 / this.k), Math.max(0, this.ox));
    this.oy = Math.min(this.image.height * (1 - 1 / this.k), Math.max(0, this.oy));
  }

  /** Zoom by factor keeping the map point under client point (cx, cy) in place. */
  zoomAt(factor, cx, cy) {
    const rc = this.canvas.getBoundingClientRect();
    const centre = cx == null;
    if (centre) { cx = rc.left + rc.width / 2; cy = rc.top + rc.height / 2; }
    const m = this.toMap({ clientX: cx, clientY: cy });
    this.k *= factor;
    this.clampPan();
    this.ox = m.x - ((cx - rc.left) * this.fitK) / this.k;
    this.oy = m.y - ((cy - rc.top) * this.fitK) / this.k;
    if (centre && this.layers.user) { // buttons: zoom around the user's dot
      this.ox = this.layers.user.x - this.image.width / this.k / 2;
      this.oy = this.layers.user.y - this.image.height / this.k / 2;
    }
    this.clampPan();
    this.draw();
  }

  fit() {
    this.k = 1;
    this.ox = this.oy = 0;
    this.draw();
  }

  /** Keep p (map px) on screen when zoomed in: recentre once it gets near an edge. */
  follow(p) {
    if (this.k <= 1 || !p) return;
    const w = this.image.width / this.k, h = this.image.height / this.k;
    const m = 0.15;
    if (p.x < this.ox + w * m || p.x > this.ox + w * (1 - m) || p.y < this.oy + h * m || p.y > this.oy + h * (1 - m)) {
      this.ox = p.x - w / 2;
      this.oy = p.y - h / 2;
      this.clampPan();
    }
  }

  gestures(onTap) {
    const c = this.canvas;
    const pts = new Map();
    let g = null; // { kind: 'one', x, y, ox, oy, moved } | { kind: 'pinch', d0, k0, m0 }
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 }; };
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) g = { kind: 'one', x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, moved: false };
      else if (pts.size === 2) {
        const q = mid();
        g = { kind: 'pinch', d0: q.d, k0: this.k, m0: this.toMap({ clientX: q.x, clientY: q.y }) };
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g?.kind === 'pinch' && pts.size >= 2) {
        const q = mid();
        const rc = c.getBoundingClientRect();
        this.k = (g.k0 * q.d) / g.d0;
        this.clampPan();
        this.ox = g.m0.x - ((q.x - rc.left) * this.fitK) / this.k;
        this.oy = g.m0.y - ((q.y - rc.top) * this.fitK) / this.k;
        this.clampPan();
        this.draw();
      } else if (g?.kind === 'one') {
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
        if (g.moved && this.k > 1) {
          this.ox = g.ox - (dx * this.fitK) / this.k;
          this.oy = g.oy - (dy * this.fitK) / this.k;
          this.clampPan();
          this.draw();
        }
      }
    });
    const end = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (e.type === 'pointerup' && g?.kind === 'one' && !g.moved && pts.size === 0) onTap?.(e);
      if (pts.size === 0) g = null;
      else if (g?.kind === 'pinch') g = { kind: 'done' }; // lifting one finger of a pinch is not a tap
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
  }

  setImage(image) {
    this.image = image;
    this.draw();
  }

  get scale() {
    return this.canvas.width / this.image.width;
  }

  /** Pointer event → map pixel coordinates. */
  toMap(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.image.width / r.width / this.k;
    return { x: this.ox + (e.clientX - r.left) * k, y: this.oy + (e.clientY - r.top) * k };
  }

  /** Map-pixel tolerance equal to `cssPx` on screen. */
  tol(cssPx) {
    return (cssPx * this.image.width) / this.canvas.getBoundingClientRect().width / this.k;
  }

  set(layers) {
    Object.assign(this.layers, layers);
    if (layers.user) this.follow(layers.user);
    this.draw();
  }

  draw() {
    if (!this.image) return;
    const dpr = window.devicePixelRatio || 1;
    // Fit the width, but keep tall (portrait) maps within ~75% of the screen height.
    const maxH = Math.max(320, window.innerHeight * 0.75);
    const cssW = Math.min(this.canvas.parentElement.clientWidth, (maxH * this.image.width) / this.image.height);
    const cssH = (cssW * this.image.height) / this.image.width;
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    const g = this.ctx;
    const s = this.scale * this.k;
    const px = (v) => (v * dpr) / s; // screen px → map units before scaling
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#e2e8f0';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(s, 0, 0, s, -this.ox * s, -this.oy * s);
    g.drawImage(this.image, 0, 0, this.image.width, this.image.height);

    const { lines = [], paths = [], nodes = [], objects = [], anchors = [], user, draft, showLines = true, highlight, route } = this.layers;

    if (showLines) {
      g.lineCap = 'round';
      const path = (L) => {
        g.beginPath();
        if (isH(L)) { g.moveTo(L.range[0], L.c); g.lineTo(L.range[1], L.c); }
        else { g.moveTo(L.c, L.range[0]); g.lineTo(L.c, L.range[1]); }
        g.stroke();
      };
      const curve = (P) => {
        g.beginPath();
        P.points.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
        g.stroke();
      };
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)'; // casing
      g.lineWidth = px(7);
      lines.forEach(path);
      paths.forEach(curve);
      g.strokeStyle = 'rgba(79, 70, 229, 0.85)';
      g.lineWidth = px(3.5);
      lines.forEach(path);
      paths.forEach(curve);
      g.fillStyle = '#4338ca';
      for (const n of nodes) {
        if (n.lines.length < 3) continue; // real junctions only
        g.beginPath();
        g.arc(n.x, n.y, px(3), 0, Math.PI * 2);
        g.fill();
      }
    }

    // Booth / room outlines (faint). Names are listed below the map, not drawn on it.
    g.strokeStyle = 'rgba(16, 185, 129, 0.55)';
    g.lineWidth = px(1.5);
    g.setLineDash([px(5), px(4)]);
    for (const o of objects) {
      if (!o.box || o.box.open) continue;
      g.strokeRect(o.box.x0, o.box.y0, o.box.x1 - o.box.x0, o.box.y1 - o.box.y0);
    }
    g.setLineDash([]);

    // Highlighted list item.
    if (highlight) {
      const o = highlight;
      if (o.box) {
        g.fillStyle = 'rgba(250, 204, 21, 0.25)';
        g.strokeStyle = '#eab308';
        g.lineWidth = px(3);
        g.fillRect(o.box.x0, o.box.y0, o.box.x1 - o.box.x0, o.box.y1 - o.box.y0);
        g.strokeRect(o.box.x0, o.box.y0, o.box.x1 - o.box.x0, o.box.y1 - o.box.y0);
      }
      g.strokeStyle = '#eab308';
      g.lineWidth = px(4);
      g.beginPath();
      g.arc(o.x, o.y, px(18), 0, Math.PI * 2);
      g.stroke();
    }

    // Route to the destination (only a guide: the user's position is not tied to it).
    if (route && route.length > 1) {
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      route.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = px(9);
      g.stroke();
      g.strokeStyle = '#ef4444';
      g.lineWidth = px(5);
      g.stroke();
      const end = route[route.length - 1];
      g.fillStyle = '#ef4444';
      g.strokeStyle = '#fff';
      g.lineWidth = px(3);
      g.beginPath();
      g.arc(end.x, end.y, px(10), 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    // Anchors: numbered pins matching the list under the map.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // many anchors (a grid every ~10 m): small dots, numbers would cover the map
    const dense = anchors.length > 40;
    // zoomed out, a grid every few metres would carpet the map: dots shrink with the map then
    const gap = dense ? Math.sqrt((this.image.width * this.image.height) / anchors.length) : 0;
    const dotR = Math.min(px(3.5), gap * 0.12);
    anchors.forEach((a, i) => {
      if (dense && !a.here) {
        g.fillStyle = 'rgba(234,88,12,.85)';
        g.strokeStyle = '#fff';
        g.lineWidth = Math.min(px(1.2), dotR * 0.35);
        g.beginPath();
        g.arc(a.x, a.y, dotR, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        return;
      }
      const r = px(11);
      g.fillStyle = a.here ? '#dc2626' : '#ea580c';
      g.beginPath();
      g.arc(a.x, a.y, r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = px(2.5);
      g.stroke();
      g.fillStyle = '#fff';
      g.font = `700 ${px(12)}px system-ui, sans-serif`;
      g.fillText(String(i + 1), a.x, a.y + px(0.5));
    });

    if (draft) {
      g.strokeStyle = 'rgba(255, 0, 120, 0.8)';
      g.lineWidth = px(5);
      g.beginPath();
      g.moveTo(draft.x0, draft.y0);
      g.lineTo(draft.x1, draft.y1);
      g.stroke();
    }

    if (user) {
      g.fillStyle = 'rgba(30, 110, 255, 0.2)';
      g.beginPath();
      g.arc(user.x, user.y, px(22), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1e6eff';
      g.beginPath();
      g.arc(user.x, user.y, px(9), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = px(3);
      g.stroke();
      if (user.dir || user.angle != null) {
        const d = user.angle != null ? [Math.sin(user.angle), -Math.cos(user.angle)] : { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[user.dir];
        g.fillStyle = '#1e6eff';
        g.beginPath();
        const tip = px(26), base = px(14), half = px(7);
        const [dx, dy] = d;
        g.moveTo(user.x + dx * tip, user.y + dy * tip);
        g.lineTo(user.x + dx * base - dy * half, user.y + dy * base + dx * half);
        g.lineTo(user.x + dx * base + dy * half, user.y + dy * base - dx * half);
        g.fill();
      }
    }
  }
}

export function loadImageFromBytes(bytes, type = 'image/webp') {
  return createImageBitmap(new Blob([bytes], { type }));
}
