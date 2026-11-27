// Guided tour: spotlight on one element at a time with a short explanation card.
// Each tour runs automatically the first time a screen is seen; the header "導覽" button replays it.

const tours = new Map();
let currentKey = () => null;
let active = null;

/** Register tours: { key: [{ el: selector, title, text, place?: 'top'|'bottom' }] }. */
export function registerTours(map, getCurrentKey) {
  for (const [k, steps] of Object.entries(map)) tours.set(k, steps);
  currentKey = getCurrentKey;
  const btn = document.getElementById('tour-btn');
  if (btn) btn.onclick = () => startTour(currentKey(), { force: true });
}

/** Run fn after the page (and its loading splash) has finished. */
export function whenLoaded(fn, delay = 700) {
  if (document.readyState === 'complete') setTimeout(fn, delay);
  else window.addEventListener('load', () => setTimeout(fn, delay), { once: true });
}

const seen = (key) => {
  try { return localStorage.getItem(`photopath:tour:${key}`) === 'done'; } catch { return false; }
};
const markSeen = (key) => {
  try { localStorage.setItem(`photopath:tour:${key}`, 'done'); } catch { /* private mode */ }
};

/** Start the tour for `key` (only if not seen before, unless force). */
export function startTour(key, { force = false } = {}) {
  const steps = (tours.get(key) || []).filter((s) => visible(document.querySelector(s.el)));
  if (!steps.length || (!force && seen(key)) || active) return;
  active = { key, steps, i: 0, ...build() };
  show();
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function build() {
  const hole = document.createElement('div');
  hole.className = 'tour-hole';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.innerHTML = `
    <div class="tour-step"></div>
    <h3 class="tour-title"></h3>
    <p class="tour-text"></p>
    <div class="tour-actions">
      <button class="btn ghost sm tour-skip">略過導覽</button>
      <span style="flex:1"></span>
      <button class="btn sm tour-prev">上一步</button>
      <button class="btn primary sm tour-next">下一步</button>
    </div>`;
  const shield = document.createElement('div');
  shield.className = 'tour-shield';
  document.body.append(shield, hole, card);
  card.querySelector('.tour-skip').onclick = () => end();
  card.querySelector('.tour-prev').onclick = () => go(-1);
  card.querySelector('.tour-next').onclick = () => go(1);
  shield.onclick = () => go(1);
  const onKey = (e) => {
    if (e.key === 'Escape') end();
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
  };
  const onMove = () => place();
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  return { hole, card, shield, cleanup: () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
  } };
}

function go(d) {
  if (!active) return;
  const i = active.i + d;
  if (i < 0) return;
  if (i >= active.steps.length) return end();
  active.i = i;
  show();
}

function show() {
  const { steps, i, card } = active;
  const s = steps[i];
  card.querySelector('.tour-step').textContent = `${i + 1} / ${steps.length}`;
  card.querySelector('.tour-title').textContent = s.title;
  card.querySelector('.tour-text').textContent = s.text;
  card.querySelector('.tour-prev').style.visibility = i ? 'visible' : 'hidden';
  card.querySelector('.tour-next').textContent = i === steps.length - 1 ? '完成' : '下一步';
  const el = document.querySelector(s.el);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  place();
  setTimeout(place, 350); // after smooth scroll
  card.querySelector('.tour-next').focus({ preventScroll: true });
}

function place() {
  if (!active) return;
  const { steps, i, hole, card } = active;
  const el = document.querySelector(steps[i].el);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 8;
  Object.assign(hole.style, {
    left: `${r.left - pad}px`, top: `${r.top - pad}px`,
    width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
  });
  const cw = Math.min(340, window.innerWidth - 24);
  card.style.width = `${cw}px`;
  const ch = card.offsetHeight;
  const below = r.bottom + pad + 12;
  const above = r.top - pad - 12 - ch;
  let top = below + ch < window.innerHeight ? below : above > 8 ? above : Math.max(8, window.innerHeight - ch - 12);
  let left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), window.innerWidth - cw - 12);
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

function end() {
  if (!active) return;
  markSeen(active.key);
  active.cleanup();
  active.hole.remove();
  active.card.remove();
  active.shield.remove();
  active = null;
}
