// Free path UI: capture → frame the map (skipped when the whole photo is the map) → automatic
// recognition → review (check what to keep, draw the rest) → download.
import { loadToCanvas, recognize, evaluate } from './recognize.js';
import { drawSampleMap } from './sample-map.js';
import { MapView } from './render.js';
import { hLine, vLine, isH } from './geometry.js';
import { nearestOnNetwork, simplify, pathLength } from './curves.js';
import { buildPhop, saveHandoff } from './phop.js';
import { registerTours, startTour, whenLoaded } from './tour.js';
import { reviewItems, keptResult, eraseAt } from './review.js';
import { detectMapQuad, rectifyCanvas, quadProblem, orderCorners } from './rectify.js';
import { createProgress } from './progress.js';

registerTours(
  {
    'create-capture': [
      { el: '#dropzone', title: '第一步：給我一張地圖', text: '活動現場的導覽圖、樓層簡介圖都可以。正對地圖拍，讓四個角都入鏡，避開燈光反射。' },
      { el: '#dropzone .btn.primary', title: '用手機直接拍', text: '在手機上會直接打開相機；在電腦上則是選擇檔案。' },
      { el: '#btn-sample', title: '先試試看', text: '手邊沒有地圖？用範例地圖跑一次完整流程。' },
    ],
    'create-frame': [
      { el: '.framewrap', title: '框出地圖', text: '照片裡除了地圖還有背景。拖曳四個圓點對準地圖的四個角，拖的時候會出現放大鏡。' },
      { el: '#btn-frame-ok', title: '拉正再辨識', text: '框裡的地圖會拉成正的長方形、背景切掉，再交給自動辨識。斜著拍也沒關係。' },
    ],
    'create-review': [
      { el: '.mapwrap', title: '辨識結果', text: '藍線是程式找到的走道：直的是方程式，斜的、彎的是彎路。橘色數字是定位點，名稱列在地圖下方。地圖只畫你勾選的項目。' },
      { el: '.places', title: '勾選要保留的', text: '每一項都可以勾選或取消。標示「可能有錯」的是文字看不太清楚的，預設不勾，確認後再勾。名稱可以直接點文字修改。' },
      { el: '#toolbar', title: '自己補畫', text: '辨識不完整也沒關係：拖曳畫直走道、用「彎路」沿著斜路描、點一下放定位點。刪除工具點到辨識的項目會取消勾選，點到自己畫的會刪掉。' },
      { el: '#checks', title: '導航需要的檢查', text: '這三項都打勾就能下載。下面的「辨識品質」只是提醒，不會擋下載。' },
      { el: '#btn-download', title: '下載 .phop', text: '只輸出勾選的和你自己畫的。按「在這台裝置開啟」可以直接試走。' },
    ],
  },
  () => (!$('step-review').classList.contains('hidden') ? 'create-review'
    : !$('step-frame').classList.contains('hidden') ? 'create-frame' : 'create-capture')
);
whenLoaded(() => startTour('create-capture'));

const $ = (id) => document.getElementById(id);

let photo = null; // the photo as taken (2000 px canvas, full-resolution original in .source)
let frameQuad = null; // the map's four corners in photo coordinates
let canvas = null; // the (straightened) map that is recognised and exported
let view = null;
let autoResult = null;
let review = { items: [], keep: new Set() }; // recognised items and which of them are kept
let drawn = { lines: [], paths: [], anchors: [] }; // what the user drew
let kept = { lines: [], graph: { lines: [], nodes: [], edges: [] }, anchors: [], objects: [] };
let quality = [];
let tol = 20;
let tool = null;
let seq = 0;
let lastTips = [];
let linesUnchecked = false; // recognition failed the navigation checks: its corridors start unchecked

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function showStep(n) {
  ['step-capture', 'step-frame', 'step-process', 'step-review'].forEach((id, i) =>
    $(id).classList.toggle('hidden', i !== n - 1)
  );
  ['s1', 's2', 's3', 's4'].forEach((id, i) => $(id).classList.toggle('on', i === n - 1));
}

/** Stepper step 2: "框出地圖", or "已自動判斷" when the whole photo was taken as the map. */
function markFrameStep(auto) {
  $('s2').lastChild.textContent = auto ? '框出地圖：已自動判斷' : '框出地圖';
  $('s2').classList.toggle('auto', auto);
}

// ---------- capture ----------
for (const id of ['in-camera', 'in-file']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) start(f);
  });
}
$('btn-sample').addEventListener('click', () => start(drawSampleMap()));

// drag & drop onto the capture card
const drop = $('dropzone');
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) start(f);
});

async function start(src) {
  showStep(3);
  setProgress('讀取影像', 0);
  try {
    photo = await loadToCanvas(src);
  } catch {
    showStep(1);
    toast('無法讀取這張圖片');
    return;
  }
  const found = detectMapQuad(photo);
  frameQuad = found.quad;
  markFrameStep(found.full);
  if (found.full) await runRecognition(photo); // screenshot / scan / the map fills the photo
  else showFrame();
}

async function runRecognition(c) {
  showStep(3);
  canvas = c;
  // One bar for the whole run: Tesseract reports 0 → 100 % for every piece of text it reads.
  const prog = createProgress();
  setProgress('準備中', 0);
  const result = await recognize(canvas, (m) => {
    const { label, value } = prog.update(m);
    setProgress(label, value);
  });
  setProgress('完成', prog.done().value);
  autoResult = result;
  window.__photopath = { result, canvas }; // for debugging in devtools
  review = reviewItems(result, {
    navOk: (k) => evaluate(k.graph, k.objects, k.anchors.map(asObj)).checks.slice(2).every((c) => c.ok),
    size: { w: canvas.width, h: canvas.height },
  });
  linesUnchecked = review.linesFailed;
  drawn = { lines: [], paths: [], anchors: [] };
  tol = result.tol;
  if (!$('title').value) $('title').value = result.title || '我的導覽圖';
  showReview();
}

function setProgress(status, v) {
  $('proc-status').textContent = `${status}（${Math.round(v * 100)}%）`;
  $('proc-bar').value = v;
}

// ---------- frame the map ----------
const fcv = $('frame-canvas');
let fscale = 1; // frame canvas px per photo px
let dragCorner = -1;

const isWhole = (q) => {
  const full = [{ x: 0, y: 0 }, { x: photo.width, y: 0 }, { x: photo.width, y: photo.height }, { x: 0, y: photo.height }];
  return q.every((p, i) => Math.hypot(p.x - full[i].x, p.y - full[i].y) < 0.005 * Math.max(photo.width, photo.height));
};

function showFrame() {
  showStep(2);
  fscale = Math.min(1, 1400 / Math.max(photo.width, photo.height));
  fcv.width = Math.round(photo.width * fscale);
  fcv.height = Math.round(photo.height * fscale);
  drawFrame();
  setTimeout(() => startTour('create-frame'), 400);
}

function drawFrame() {
  const g = fcv.getContext('2d');
  const k = fscale;
  const u = fcv.width / Math.max(1, fcv.clientWidth || fcv.width); // canvas px per CSS px
  g.drawImage(photo, 0, 0, fcv.width, fcv.height);
  const path = () => {
    g.beginPath();
    frameQuad.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p.x * k, p.y * k));
    g.closePath();
  };
  // darken what will be cut away
  g.save();
  g.beginPath();
  g.rect(0, 0, fcv.width, fcv.height);
  frameQuad.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p.x * k, p.y * k));
  g.closePath();
  g.fillStyle = 'rgba(15, 23, 42, .55)';
  g.fill('evenodd');
  g.restore();
  const bad = quadProblem(frameQuad, photo.width, photo.height);
  path();
  g.lineWidth = 3 * u;
  g.strokeStyle = bad ? '#f43f5e' : '#06b6d4';
  g.stroke();
  frameQuad.forEach((p, i) => {
    g.beginPath();
    g.arc(p.x * k, p.y * k, (i === dragCorner ? 16 : 13) * u, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255, 255, 255, .35)';
    g.fill();
    g.lineWidth = 3 * u;
    g.strokeStyle = bad ? '#f43f5e' : '#06b6d4';
    g.stroke();
  });
  $('frame-problem').textContent = bad || '';
  $('frame-problem').classList.toggle('hidden', !bad);
  $('btn-frame-ok').disabled = !!bad;
}

/** Pointer position in photo coordinates. */
function framePoint(e) {
  const r = fcv.getBoundingClientRect();
  return {
    x: Math.min(photo.width, Math.max(0, ((e.clientX - r.left) / r.width) * photo.width)),
    y: Math.min(photo.height, Math.max(0, ((e.clientY - r.top) / r.height) * photo.height)),
  };
}

function showLoupe(e) {
  const lp = $('frame-loupe');
  const r = fcv.getBoundingClientRect();
  const wrap = fcv.parentElement.getBoundingClientRect();
  const c = frameQuad[dragCorner];
  const g = lp.getContext('2d');
  const side = (lp.width / 3) * (photo.width / r.width); // 3× the on-screen size
  g.fillStyle = '#000';
  g.fillRect(0, 0, lp.width, lp.height);
  g.drawImage(photo, c.x - side / 2, c.y - side / 2, side, side, 0, 0, lp.width, lp.height);
  g.strokeStyle = '#06b6d4';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(lp.width / 2, 0); g.lineTo(lp.width / 2, lp.height);
  g.moveTo(0, lp.height / 2); g.lineTo(lp.width, lp.height / 2);
  g.stroke();
  // above-left of the finger, or wherever it fits
  const fx = e.clientX - wrap.left, fy = e.clientY - wrap.top;
  let x = fx - lp.width - 28, y = fy - lp.height - 28;
  if (x < 4) x = fx + 28;
  if (y < 4) y = fy + 28;
  lp.style.left = `${Math.min(wrap.width - lp.width - 4, x)}px`;
  lp.style.top = `${Math.min(wrap.height - lp.height - 4, y)}px`;
  lp.classList.remove('hidden');
}

fcv.addEventListener('pointerdown', (e) => {
  const r = fcv.getBoundingClientRect();
  const p = framePoint(e);
  const reach = (40 * photo.width) / r.width; // 40 CSS px: easy to grab with a finger
  let best = -1, bd = Infinity;
  frameQuad.forEach((c, i) => { const d = Math.hypot(c.x - p.x, c.y - p.y); if (d < bd) { bd = d; best = i; } });
  if (bd > reach) return;
  dragCorner = best;
  fcv.setPointerCapture(e.pointerId);
  showLoupe(e);
  drawFrame();
});
fcv.addEventListener('pointermove', (e) => {
  if (dragCorner < 0) return;
  frameQuad = frameQuad.map((c, i) => (i === dragCorner ? framePoint(e) : c));
  drawFrame();
  showLoupe(e);
});
for (const ev of ['pointerup', 'pointercancel']) {
  fcv.addEventListener(ev, () => {
    if (dragCorner < 0) return;
    dragCorner = -1;
    $('frame-loupe').classList.add('hidden');
    drawFrame();
  });
}

$('btn-frame-full').addEventListener('click', () => {
  frameQuad = [{ x: 0, y: 0 }, { x: photo.width, y: 0 }, { x: photo.width, y: photo.height }, { x: 0, y: photo.height }];
  drawFrame();
});

$('btn-frame-rotate').addEventListener('click', async () => {
  const src = photo.source || photo;
  const k = Math.min(1, 4096 / Math.max(src.width, src.height)); // phone canvas limits
  const c = document.createElement('canvas');
  c.width = Math.round(src.height * k);
  c.height = Math.round(src.width * k);
  const g = c.getContext('2d');
  g.translate(c.width, 0);
  g.rotate(Math.PI / 2); // clockwise: (u, v) → (1 − v, u)
  g.drawImage(src, 0, 0, src.width * k, src.height * k);
  const old = { w: photo.width, h: photo.height };
  photo = await loadToCanvas(c);
  frameQuad = orderCorners(frameQuad.map((p) => ({ x: (1 - p.y / old.h) * photo.width, y: (p.x / old.w) * photo.height })));
  showFrame();
});

$('btn-frame-ok').addEventListener('click', async () => {
  if (quadProblem(frameQuad, photo.width, photo.height)) return;
  showStep(3);
  setProgress('拉正地圖', 0);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))); // let the screen show it
  let c = photo;
  if (!isWhole(frameQuad)) {
    const k = photo.sourceScale || 1; // straighten from the full-resolution original
    c = await loadToCanvas(rectifyCanvas(photo.source || photo, frameQuad.map((p) => ({ x: p.x * k, y: p.y * k }))));
  }
  markFrameStep(false);
  await runRecognition(c);
});

// ---------- review ----------
const asObj = (a) => ({ id: a.id, name: a.name, cx: a.x, cy: a.y, here: a.here });

/** Blocking checks: what navigation needs (≥ 2 anchors, connected corridors, every anchor reachable). */
function navChecks() {
  return evaluate(kept.graph, kept.objects, kept.anchors.map(asObj)).checks.slice(2);
}

/** Warnings only: how well the photo was read (does not change while the user edits). */
function qualityChecks() {
  const r = autoResult;
  const q = r.quality.issues.map((i) => ({ ok: false, label: i.msg, tip: i.msg }));
  const all = evaluate(r.graph, r.objects, r.anchors.map(asObj), { w: canvas.width, h: canvas.height }).checks;
  const nav = new Set(evaluate(r.graph, r.objects, r.anchors.map(asObj)).checks.slice(2).map((c) => c.label));
  return [...q, ...all.filter((c) => !nav.has(c.label))];
}

function showReview() {
  showStep(4);
  setTimeout(() => startTour('create-review'), 500);
  if (!view) {
    view = new MapView($('map'), canvas);
    bindEditor();
  } else view.setImage(canvas);
  quality = qualityChecks();
  refresh();

  const notice = $('result-notice');
  const tips = [...new Set([...quality, ...navChecks()].filter((c) => !c.ok).map((c) => c.tip))];
  if (autoResult.ocrError) tips.unshift('文字辨識引擎載入失敗（可能沒有網路）');
  lastTips = tips;
  if (!tips.length) {
    notice.className = 'notice ok';
    notice.textContent = '自動辨識成功！請確認勾選的走道和定位點，沒問題就可以下載。';
  } else {
    notice.className = 'notice warn';
    const unsureAnchors = review.items.filter((i) => i.group === 'anchor' && i.unsure && !review.keep.has(i.key)).length;
    notice.innerHTML = `辨識不完整。可以重拍，或直接勾選要保留的結果、用上面的工具自己補畫。${linesUnchecked ? '<br>找到的走道可能大多是錯的，所以先全部不勾；確認哪幾條是對的再勾回來。' : ''}${unsureAnchors ? `<br>有 ${unsureAnchors} 個定位點的文字可能讀錯，預設沒勾：請在下面的清單確認名稱（可以直接修改），勾選後就能下載。` : ''}<br>原因：${tips.join('；')}`;
    const row = document.createElement('div');
    row.className = 'row';
    if (!navChecks().every((c) => c.ok)) {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = '全部清除，我自己畫';
      b.addEventListener('click', () => {
        review.keep = new Set();
        refresh();
        if (tool !== 'line') setTool('line');
        $('toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      row.append(b);
    }
    const f = document.createElement('button');
    f.className = 'btn sm';
    f.textContent = '⬚ 重新框選';
    f.addEventListener('click', () => showFrame());
    row.append(f);
    notice.append(row);
  }
}

function refresh() {
  kept = keptResult(autoResult, review.keep, drawn, tol);
  view.set({ lines: kept.graph.lines, paths: kept.graph.paths, nodes: kept.graph.nodes, anchors: kept.anchors, objects: kept.objects });

  const nav = navChecks();
  const li = (c, bad) => `<li class="${c.ok ? 'ok' : bad}">${c.label}</li>`;
  $('checks').innerHTML = nav.map((c) => li(c, 'bad')).join('');
  $('quality').innerHTML = quality.map((c) => li(c, 'warn')).join('');
  const canDownload = nav.every((c) => c.ok);
  $('btn-download').disabled = !canDownload;
  $('btn-open').disabled = !canDownload;
  renderLists();
}

// ---------- check lists under the map (names are listed here, not drawn on the map) ----------
function tag(text, cls) {
  const s = document.createElement('span');
  s.className = `mini-tag ${cls}`;
  s.textContent = text;
  return s;
}

function row({ pin, check, drawnItem, unsure, name, onName, highlight, actions = [] }) {
  const li = document.createElement('li');
  li.className = `place${check && !check.checked ? ' off' : ''}`;
  if (check) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'keep';
    box.checked = check.checked;
    box.title = '勾選＝保留這一項';
    box.addEventListener('change', () => check.onChange(box.checked));
    li.append(box);
  }
  if (pin !== undefined) {
    const badge = document.createElement('span');
    badge.className = pin ? `pin${pin.here ? ' here' : ''}` : 'pin off';
    if (pin) badge.textContent = pin.num;
    li.append(badge);
  }
  if (onName) {
    const input = document.createElement('input');
    input.className = 'place-name';
    input.value = name;
    input.title = '點一下可修改名稱（修正辨識錯字）';
    input.addEventListener('change', () => onName(input.value.trim() || name));
    input.addEventListener('focus', () => view.set({ highlight }));
    input.addEventListener('blur', () => view.set({ highlight: null }));
    li.append(input);
  } else {
    const t = document.createElement('span');
    t.className = 'place-text';
    t.textContent = name;
    li.append(t);
  }
  if (unsure) li.append(tag('可能有錯，請確認', 'unsure'));
  if (drawnItem) li.append(tag('自己畫的', 'mine'));
  for (const [label, fn, cls, tip] of actions) {
    const b = document.createElement('button');
    b.className = `btn sm ${cls || 'ghost'}`;
    b.textContent = label;
    if (tip) b.title = tip;
    b.onclick = fn;
    li.append(b);
  }
  li.addEventListener('mouseenter', () => view.set({ highlight }));
  li.addEventListener('mouseleave', () => view.set({ highlight: null }));
  return li;
}

/** Highlight for a corridor: a thin box along it. */
function lineMark(L) {
  const pad = view.tol(8);
  const [t0, t1] = L.range;
  const mid = (t0 + t1) / 2;
  return isH(L)
    ? { x: mid, y: L.c, box: { x0: t0, y0: L.c - pad, x1: t1, y1: L.c + pad } }
    : { x: L.c, y: mid, box: { x0: L.c - pad, y0: t0, x1: L.c + pad, y1: t1 } };
}

/** Highlight box around a curve. */
function pathMark(P) {
  const pad = view.tol(8);
  const xs = P.points.map((q) => q.x), ys = P.points.map((q) => q.y);
  const mid = P.points[P.points.length >> 1];
  return { x: mid.x, y: mid.y, box: { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad } };
}

const checkOf = (key) => ({
  checked: review.keep.has(key),
  onChange: (on) => { if (on) review.keep.add(key); else review.keep.delete(key); refresh(); },
});

function renderLists() {
  const group = (g) => review.items.filter((i) => i.group === g);
  const objOf = (id) => autoResult.objects.find((o) => o.id === id);
  const count = (id, n, m) => { $(id).textContent = `已保留 ${n}／共 ${m}`; };

  // corridors
  const lineItems = group('line');
  const n = { h: lineItems.filter((i) => isH(i.ref)).length, v: lineItems.filter((i) => !isH(i.ref)).length }; // drawn ones go on from these
  $('line-items').replaceChildren(
    ...lineItems.map((i) => row({ check: checkOf(i.key), name: i.label, highlight: lineMark(i.ref) })),
    ...drawn.lines.map((L) => row({
      drawnItem: true, name: isH(L) ? `橫向走道 ${++n.h}` : `直向走道 ${++n.v}`, highlight: lineMark(L),
      actions: [['✕', () => { drawn.lines = drawn.lines.filter((x) => x !== L); refresh(); }, 'ghost', '刪除這條走道']],
    }))
  );
  count('line-count', kept.lines.length, lineItems.length + drawn.lines.length);
  $('line-empty').classList.toggle('hidden', lineItems.length + drawn.lines.length > 0);

  // curves (slanted / curved roads)
  const pathItems = group('path');
  let pn = pathItems.length;
  $('path-items').replaceChildren(
    ...pathItems.map((i) => row({ check: checkOf(i.key), name: i.label, highlight: pathMark(i.ref) })),
    ...drawn.paths.map((P) => row({
      drawnItem: true, name: `彎路 ${++pn}`, highlight: pathMark(P),
      actions: [['✕', () => { drawn.paths = drawn.paths.filter((x) => x !== P); refresh(); }, 'ghost', '刪除這條彎路']],
    }))
  );
  count('path-count', kept.paths.length, pathItems.length + drawn.paths.length);
  $('path-empty').classList.toggle('hidden', pathItems.length + drawn.paths.length > 0);

  // anchors: kept ones carry the number shown on the map
  const numOf = new Map(kept.anchors.map((a, i) => [a.key, { num: i + 1, here: a.here }]));
  const keptAt = (key) => kept.anchors.find((a) => a.key === key);
  const anchorItems = group('anchor');
  $('anchor-items').replaceChildren(
    ...anchorItems.map((i) => {
      const a = i.ref, at = keptAt(i.key) || a;
      return row({
        check: checkOf(i.key), pin: numOf.get(i.key) || null, unsure: i.unsure, name: a.name,
        highlight: { x: at.x, y: at.y, box: objOf(a.id)?.box },
        onName: (v) => { a.name = v; const o = objOf(a.id); if (o) o.name = v; refresh(); },
      });
    }),
    ...drawn.anchors.map((a) => {
      const key = `D:${a.id}`, at = keptAt(key) || a;
      return row({
        drawnItem: true, pin: numOf.get(key) || null, name: a.name,
        highlight: { x: at.x, y: at.y, box: objOf(a.id)?.box },
        onName: (v) => { a.name = v; refresh(); },
        actions: [['✕', () => { drawn.anchors = drawn.anchors.filter((x) => x !== a); refresh(); }, 'ghost', '刪除這個定位點']],
      });
    })
  );
  count('anchor-count', kept.anchors.length, anchorItems.length + drawn.anchors.length);
  $('anchor-empty').classList.toggle('hidden', anchorItems.length + drawn.anchors.length > 0);

  // other places (a place made into an anchor by hand is listed with the anchors instead)
  const made = new Set(drawn.anchors.map((a) => a.id));
  const pois = group('poi').filter((i) => !made.has(i.ref.id));
  $('poi-items').replaceChildren(
    ...pois.map((i) => {
      const o = i.ref;
      return row({
        check: checkOf(i.key), unsure: i.unsure, name: o.name,
        highlight: { x: o.cx, y: o.cy, box: o.box },
        onName: (v) => { o.name = v; },
        actions: [['設為定位點', () => {
          if (!kept.graph.lines.length && !kept.graph.paths.length) return toast('請先畫出走道，定位點必須在走道上');
          drawn.anchors = [...drawn.anchors, { id: o.id, name: o.name, x: o.cx, y: o.cy }];
          refresh();
        }, 'soft']],
      });
    })
  );
  count('poi-count', pois.filter((i) => review.keep.has(i.key)).length, pois.length);
  $('poi-empty').classList.toggle('hidden', pois.length > 0);
}

$('btn-keep-all').addEventListener('click', () => {
  review.keep = new Set(review.items.map((i) => i.key));
  refresh();
});
$('btn-drop-all').addEventListener('click', () => {
  review.keep = new Set();
  refresh();
  toast('已取消勾選所有辨識結果，可以自己畫了');
});

$('btn-reframe').addEventListener('click', () => showFrame());

$('btn-retake').addEventListener('click', () => {
  const n = $('retake-notice');
  n.classList.toggle('hidden', !lastTips.length);
  n.textContent = `上次的問題：${lastTips.join('；')}`;
  showStep(1);
});

// ---------- drawing tools (always shown; tap the active tool again to put it down) ----------
const HINTS = {
  line: '在地圖上拖曳畫出走道；會自動變成水平或垂直線，並接上附近的走道。',
  anchor: '點一下走道附近的位置放置定位點，並輸入名稱，例如「東側入口」。',
  curve: '用手指沿著斜路或彎路畫，放開後會變成一條彎路，兩端會接上附近的走道。',
  erase: '點一下要刪除的定位點、走道或彎路：辨識出來的會取消勾選（可以在清單勾回來），自己畫的會刪掉。',
};

function setTool(t) {
  tool = tool === t ? null : t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('tool-hint').textContent = tool ? HINTS[tool] : '';
  $('tool-hint').classList.toggle('hidden', !tool);
}

function bindEditor() {
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  const cv = $('map');
  let drag = null;
  let stroke = null; // freehand curve being drawn
  cv.addEventListener('pointerdown', (e) => {
    if (!tool) return;
    const p = view.toMap(e);
    if (tool === 'line') {
      drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      cv.setPointerCapture(e.pointerId);
    } else if (tool === 'curve') {
      stroke = [p];
      cv.setPointerCapture(e.pointerId);
    } else if (tool === 'anchor') addAnchor(p);
    else if (tool === 'erase') erase(p);
  });
  cv.addEventListener('pointermove', (e) => {
    if (stroke) {
      stroke.push(view.toMap(e));
      view.set({ paths: [...kept.graph.paths, { id: 'draft', points: stroke }] });
      return;
    }
    if (!drag) return;
    const p = view.toMap(e);
    // preview snapped to axis
    if (Math.abs(p.x - drag.x0) >= Math.abs(p.y - drag.y0)) Object.assign(drag, { x1: p.x, y1: drag.y0 });
    else Object.assign(drag, { x1: drag.x0, y1: p.y });
    view.set({ draft: drag });
  });
  cv.addEventListener('pointerup', () => {
    if (stroke) {
      const pts = simplify(stroke, view.tol(3));
      stroke = null;
      if (pts.length >= 2 && pathLength({ points: pts }) >= view.tol(20)) addCurve(pts);
      else refresh();
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    view.set({ draft: null });
    const len = Math.hypot(d.x1 - d.x0, d.y1 - d.y0);
    if (len < view.tol(20)) return;
    addLine(d);
  });
}

function addLine(d) {
  const snap = view.tol(14);
  const horizontal = d.y0 === d.y1;
  // snap the constant coordinate to an existing parallel corridor if close
  let c = horizontal ? d.y0 : d.x0;
  for (const L of kept.graph.lines) if (isH(L) === horizontal && Math.abs(L.c - c) < snap) c = L.c;
  const id = `M${++seq}`;
  const L = horizontal ? hLine(id, c, d.x0, d.x1) : vLine(id, c, d.y0, d.y1);
  drawn.lines = [...drawn.lines, L];
  tol = Math.max(tol, snap);
  refresh();
}

function addCurve(points) {
  const snap = view.tol(14);
  drawn.paths = [...drawn.paths, { id: `M${++seq}`, points }];
  tol = Math.max(tol, snap); // its ends join a corridor or curve within reach
  refresh();
}

function addAnchor(p) {
  if (!kept.graph.lines.length && !kept.graph.paths.length) {
    toast('請先畫出走道，定位點必須在走道上');
    return;
  }
  const near = autoResult.objects.find((o) => o.box && p.x >= o.box.x0 && p.x <= o.box.x1 && p.y >= o.box.y0 && p.y <= o.box.y1);
  const name = prompt('定位點名稱（例如：東側入口、服務台）', near?.name || '');
  if (!name) return;
  const n = nearestOnNetwork(kept.graph.lines, kept.graph.paths, p);
  drawn.anchors = [...drawn.anchors, { id: `A${Date.now().toString(36)}`, name, x: n.x, y: n.y }];
  refresh();
}

function erase(p) {
  const hit = eraseAt(kept, p, view.tol(16));
  if (!hit) return;
  if (hit.action === 'uncheck') {
    review.keep.delete(hit.key);
    toast('已取消勾選，可以在清單裡勾回來');
  } else {
    const id = hit.key.slice(2);
    drawn.lines = drawn.lines.filter((L) => L.id !== id);
    drawn.paths = drawn.paths.filter((P) => P.id !== id);
    drawn.anchors = drawn.anchors.filter((a) => a.id !== id);
  }
  refresh();
}

// ---------- export ----------
function watermarked() {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0);
  g.save();
  g.globalAlpha = 0.13;
  g.fillStyle = '#d6336c';
  const fs = Math.round(Math.max(c.width, c.height) / 28);
  g.font = `bold ${fs}px sans-serif`;
  g.translate(c.width / 2, c.height / 2);
  g.rotate(-Math.PI / 8);
  const text = '未經授權 UNLICENSED · PhotoPath';
  const step = fs * 4;
  for (let y = -c.height; y < c.height; y += step) {
    for (let x = -c.width; x < c.width; x += g.measureText(text).width + fs * 2) g.fillText(text, x, y);
  }
  g.restore();
  return c;
}

async function exportPhop() {
  const map = watermarked();
  const blob = await new Promise((r) => map.toBlob(r, 'image/webp', 0.85));
  const ext = blob.type === 'image/webp' ? 'webp' : 'png';
  const title = $('title').value.trim() || '我的導覽圖';
  const payload = {
    [`map.${ext}`]: new Uint8Array(await blob.arrayBuffer()),
    'graph.json': JSON.stringify(kept.graph),
    'anchors.json': JSON.stringify(kept.anchors.map(({ key, ...a }) => a)),
    'pois.json': JSON.stringify(
      kept.objects.map((o) => ({ id: o.id, name: o.name, x: o.cx, y: o.cy, box: o.box, conf: Math.round(o.conf) }))
    ),
    'calibration.json': JSON.stringify({
      defaultPxPerStep: Math.round(Math.max(canvas.width, canvas.height) / 100),
      segments: [],
    }),
  };
  const manifest = {
    title,
    map: `payload/map.${ext}`,
    source: drawn.lines.length || drawn.paths.length || drawn.anchors.length ? 'manual' : 'auto',
    coordinateSystem: {
      origin: 'top-left', xAxis: 'right', yAxis: 'down', unit: 'px',
      width: canvas.width, height: canvas.height,
      allowedDirections: ['up', 'down', 'left', 'right'],
    },
    floors: [{ id: 'F1', name: '1F', z: 0 }],
  };
  return { blob: await buildPhop(manifest, payload, 'UNLICENSED'), title };
}

$('btn-download').addEventListener('click', async () => {
  const { blob, title } = await exportPhop();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}.phop`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已下載 .phop');
});

$('btn-open').addEventListener('click', async () => {
  const { blob } = await exportPhop();
  await saveHandoff(blob);
  location.href = 'view.html?handoff=1';
});
