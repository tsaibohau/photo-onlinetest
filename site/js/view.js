// Viewer: open .phop → choose start anchor → navigate (sensors or simulated steps).
import { readPhop, loadHandoff, json, PhopError } from './phop.js';
import { MapView, loadImageFromBytes } from './render.js';
import { Navigator, quantize, opposite } from './nav.js';
import { nearestLine } from './geometry.js';
import { nearestOnNetwork } from './curves.js';
import { registerTours, startTour, whenLoaded } from './tour.js';
import { gridFromGraph, findRoute, routeProgress, walkStep, snapToAnchor, lineFree, freeAt } from './route.js';
import { groupAnchors } from './anchorgroups.js';

const $ = (id) => document.getElementById(id);

registerTours(
  {
    'view-load': [
      { el: '#sec-load .dropzone', title: '打開 .phop 檔案', text: '選擇或拖曳一個 .phop 檔案。掃描主辦方的 QR code 也會直接打開到這裡。' },
    ],
    'view-start': [
      { el: '#anchor-list', title: '先告訴我你在哪', text: '沒有 GPS，所以由你選一個附近的定位點當起點。選之前，請面向地圖的上方站好。' },
      { el: '#btn-pick', title: '找不到名稱？', text: '也可以直接在地圖上點你所在的位置，程式會吸附到最近的走道。' },
    ],
    'view-nav': [
      { el: '#map', title: '開始走吧', text: '藍點是你，箭頭是方向。系統只沿走道上、下、左、右移動，不會穿牆。' },
      { el: '#place-anchors', title: '經過定位點時點一下', text: '走到清單上的地點時點它（或點地圖上的數字），位置立刻校正、誤差歸零。' },
      { el: '#btn-sensors', title: '手機計步', text: '在手機上按這裡，允許動作感測器，走路時保持螢幕開著，就會自動計步。' },
      { el: '#btn-flip', title: '方向反了？', text: '手機拿反、往北走卻顯示往南時按這裡。系統一直撞牆時也會自動幫你反轉。' },
      { el: '.dpad', title: '在電腦上試走', text: '沒有手機時，用這組方向鍵（或鍵盤方向鍵）模擬走路，每按一次＝一步。' },
    ],
  },
  () => (!$('sec-nav').classList.contains('hidden') ? 'view-nav' : !$('sec-start').classList.contains('hidden') ? 'view-start' : 'view-load')
);
whenLoaded(() => { if (!$('sec-load').classList.contains('hidden')) startTour('view-load'); });
const DIR_LABEL = { up: '↑ 上', down: '↓ 下', left: '← 左', right: '→ 右' };

let doc = null; // {manifest, license, graph, anchors, pois, calibration, image}
let nav = null;
let view = null;
let picking = false;
let theta0 = null;
let heading = null;
let lastDir = null;
let curvePos = null; // position on a curved path (no step-by-step tracking there)
const isCurve = (id) => (doc.graph.paths || []).some((P) => P.id === id);
/** Open-walk maps: walk anywhere except obstacles; steps move the position freely (not along a path). */
const isOpen = () => doc.manifest?.walkMode === 'open';
let grid = null; // free/blocked cells (open-walk maps)
let dest = null; // { name, pts: [{x,y}] } where to go
let route = null; // [{x,y}] px, a guide only
let freeSteps = 0;
let arrived = false;
let atAnchor = null; // the anchor the dot is shown on (the estimate itself keeps moving freely)
const SNAP_M = 6; // show the dot on an anchor only when one is this close (dense anchor grids)
const snapNow = () => (atAnchor = snapToAnchor(doc.anchors, curvePos, atAnchor, SNAP_M * ppmOf(), 0.75, (a) => !grid || lineFree(grid, curvePos, a)));
const ppmOf = () => doc.calibration.pxPerMeter || doc.image.width / (doc.manifest.coordinateSystem?.metersWidth || doc.image.width);
const stepPx = () => doc.calibration.defaultPxPerStep || ppmOf() * 0.7;
const anchorLabel = (a) => (a.landmark && !a.name.startsWith(a.landmark) ? `${a.name}（${a.landmark}）` : a.name);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------- loading ----------
$('in-file').addEventListener('change', (e) => e.target.files[0] && open(e.target.files[0]));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) open(f);
});

(async function boot() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  if (params.get('handoff')) {
    const blob = await loadHandoff();
    if (blob) return open(blob);
  }
  if (hash.get('src')) {
    try {
      const res = await fetch(hash.get('src'));
      if (!res.ok) throw new Error(res.status);
      return open(await res.blob());
    } catch (e) {
      showError(`無法下載檔案（${e.message}）。檔案主機可能不允許跨網域讀取（CORS）。`);
    }
  }
})();

function showError(msg) {
  const el = $('load-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function open(blob) {
  try {
    const { manifest, license, files } = await readPhop(blob);
    const mapName = (manifest.map || 'payload/map.webp').replace(/^payload\//, '');
    doc = {
      manifest,
      license,
      graph: json(files['graph.json']),
      anchors: json(files['anchors.json']),
      pois: files['pois.json'] ? json(files['pois.json']) : [],
      calibration: files['calibration.json'] ? json(files['calibration.json']) : {},
      image: await loadImageFromBytes(files[mapName], mapName.endsWith('png') ? 'image/png' : 'image/webp'),
    };
  } catch (e) {
    showError(e instanceof PhopError ? e.message : `無法開啟：${e.message}`);
    return;
  }
  showStart();
}

// ---------- start ----------
function showStart() {
  $('sec-load').classList.add('hidden');
  $('sec-start').classList.remove('hidden');
  $('title').textContent = doc.manifest.title || '未命名導覽';
  $('license').classList.toggle('hidden', doc.license.type !== 'UNLICENSED');
  const startBtn = (label, num, here, onClick) => {
    const b = document.createElement('button');
    b.className = 'btn';
    if (num) {
      const pin = document.createElement('span');
      pin.className = `pin${here ? ' here' : ''}`;
      pin.textContent = num;
      b.append(pin);
    }
    b.append(label);
    b.onclick = onClick;
    return b;
  };
  $('anchor-list').replaceChildren(...(denseAnchors()
    ? [groupedAnchors((a) => startBtn(anchorLabel(a), null, a.here, () => begin(a, a.line)), 'start-list')]
    : doc.anchors.map((a, i) => startBtn(anchorLabel(a), i + 1, a.here, () => begin(a, a.line)))));
  $('poi-list').replaceChildren(...otherPois().map((p) => startBtn(p.name, null, false, () => begin(p))));
  $('btn-pick').onclick = () => {
    picking = true;
    showNav();
    $('pick-hint').classList.remove('hidden');
    $('controls').classList.add('hidden');
  };
  setTimeout(() => startTour('view-start'), 500);
  const opt = (a, i) => Object.assign(document.createElement('option'), { value: i, textContent: denseAnchors() ? a.name : `${i + 1}. ${a.name}` });
  const index = new Map(doc.anchors.map((a, i) => [a, i]));
  $('sel-anchor').replaceChildren(...(denseAnchors()
    ? anchorGroups().map((gr) => {
      const og = Object.assign(document.createElement('optgroup'), { label: gr.name });
      og.append(...gr.anchors.map((a) => opt(a, index.get(a))));
      return og;
    })
    : doc.anchors.map(opt)));
}

/** Many anchors (a grid every few metres): lists show them grouped by place, folded away. */
const denseAnchors = () => doc.anchors.length > 40;
let groupsCache = null;
function anchorGroups() {
  if (!groupsCache || groupsCache.doc !== doc) {
    const places = [
      ...(doc.graph.obstacles || []).map((o) => ({ name: o.name, points: o.points })),
      ...doc.pois.map((p) => ({ name: p.name, x: p.x, y: p.y })),
    ];
    groupsCache = { doc, list: groupAnchors(doc.anchors, places, 40 * ppmOf(), { width: doc.image.width, height: doc.image.height }) };
  }
  return groupsCache.list;
}
/** A button that unfolds the anchors by place; each place fills in only when opened. */
function groupedAnchors(make, listClass) {
  const wrap = document.createElement('div');
  wrap.className = 'anchor-groups';
  const btn = Object.assign(document.createElement('button'), { className: 'btn soft anchor-toggle' });
  const box = document.createElement('div');
  box.className = 'anchor-groups hidden';
  const label = () => (btn.textContent = box.classList.contains('hidden') ? `📍 展開定位點（${doc.anchors.length} 個，依地點分類）` : '收起定位點');
  btn.onclick = () => {
    if (!box.childElementCount) {
      box.append(...anchorGroups().map((gr) => {
        const d = document.createElement('details');
        d.append(Object.assign(document.createElement('summary'), { textContent: `${gr.name}（${gr.anchors.length} 個）` }));
        d.addEventListener('toggle', () => {
          if (!d.open || d.childElementCount > 1) return;
          const list = document.createElement(listClass.startsWith('place') ? 'ul' : 'div');
          list.className = listClass;
          list.append(...gr.anchors.map(make));
          d.append(list);
        });
        return d;
      }));
    }
    box.classList.toggle('hidden');
    label();
  };
  label();
  wrap.append(btn, box);
  return wrap;
}

const otherPois = () => {
  const anchorNames = new Set(doc.anchors.map((a) => a.name));
  return doc.pois.filter((p) => !anchorNames.has(p.name));
};

/** Names live in a numbered list under the map; the map only shows numbered pins. */
function renderPlaceList() {
  const item = (num, here, name, onClick, highlight) => {
    const li = document.createElement('li');
    li.className = 'place';
    const badge = document.createElement('span');
    badge.className = num ? `pin${here ? ' here' : ''}` : 'dot';
    if (num) badge.textContent = num;
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = name;
    b.onclick = onClick;
    li.append(badge, b);
    li.addEventListener('mouseenter', () => view.set({ highlight }));
    li.addEventListener('mouseleave', () => view.set({ highlight: null }));
    return li;
  };
  const pick = (a) => () => (nav ? hereAt(a) : begin(a, a.line));
  $('place-anchors').classList.toggle('hidden', denseAnchors());
  $('place-anchor-groups').classList.toggle('hidden', !denseAnchors());
  if (denseAnchors()) $('place-anchor-groups').replaceChildren(groupedAnchors((a) => item(null, a.here, anchorLabel(a), pick(a), { x: a.x, y: a.y }), 'place-list cols'));
  else $('place-anchors').replaceChildren(...doc.anchors.map((a, i) => item(i + 1, a.here, anchorLabel(a), pick(a), { x: a.x, y: a.y })));
  const pois = otherPois();
  $('place-pois').replaceChildren(
    ...pois.map((p) => item(null, false, p.name, () => {
      view.set({ highlight: { x: p.x, y: p.y, box: p.box } });
      setTimeout(() => view.set({ highlight: null }), 1800);
    }, { x: p.x, y: p.y, box: p.box }))
  );
  $('place-pois-wrap').classList.toggle('hidden', !pois.length);
}

function showNav() {
  $('sec-start').classList.add('hidden');
  $('sec-nav').classList.remove('hidden');
  if (!view) {
    view = new MapView($('map'), doc.image, { zoom: true, onTap: onMapTap });
    view.set({ lines: doc.graph.lines, paths: doc.graph.paths || [], nodes: doc.graph.nodes, anchors: [] });
    document.querySelectorAll('[data-zoom]').forEach((b) => (b.onclick = () => {
      if (b.dataset.zoom === 'fit') view.fit();
      else view.zoomAt(b.dataset.zoom === 'in' ? 1.6 : 1 / 1.6);
    }));
    if (isOpen()) fillDestinations();
    renderPlaceList();
  }
}

function begin(point, lineId = null) {
  if (isPhone() && sensors === 'off') enableSensors();
  sensorStatus();
  // Curved paths: show the position, but dead reckoning only runs on straight corridors.
  const near = isOpen() ? null : nearestOnNetwork(doc.graph.lines, doc.graph.paths || [], point);
  if (isOpen() || !doc.graph.lines.length || (lineId ? isCurve(lineId) : near?.kind === 'path')) {
    nav = null;
    curvePos = near ? { x: near.x, y: near.y } : { x: point.x, y: point.y };
    showNav();
    $('pick-hint').classList.add('hidden');
    $('controls').classList.remove('hidden');
    if (isOpen()) {
      grid ??= gridFromGraph(doc.graph, { width: doc.image.width, height: doc.image.height }, ppmOf());
      freeSteps = 0;
      atAnchor = null;
      snapNow();
      $('dest-row').classList.remove('hidden');
      navigator.wakeLock?.request('screen').catch(() => {});
      planRoute();
    }
    update();
    toast(isOpen()
      ? (dest ? `已設定起點，往「${dest.name}」的路線已畫出` : '已設定起點。選一個目的地就會畫出路線；走路時位置會跟著移動')
      : '你在彎路上：步伐推算目前只支援直線走道。走到錨點時點一下地圖上的錨點更新位置');
    return;
  }
  curvePos = null;
  nav = new Navigator(doc.graph, doc.calibration);
  nav.start(point, lineId);
  theta0 = heading; // user was asked to face map-up
  showNav();
  $('pick-hint').classList.add('hidden');
  $('controls').classList.remove('hidden');
  navigator.wakeLock?.request('screen').catch(() => {});
  update();
  setTimeout(() => startTour('view-nav'), 500);
}

let calibrating = false;
function setCalibrating(on) {
  calibrating = on;
  $('calib-hint').classList.toggle('hidden', !on);
  $('btn-calib').textContent = on ? '✕ 取消校正' : '📍 校正位置';
  view.set({ anchors: on ? doc.anchors : [] });
}
$('btn-calib').onclick = () => setCalibrating(!calibrating);
$('btn-calib-cancel').onclick = () => setCalibrating(false);

function onMapTap(e) {
  const p = view.toMap(e);
  if (picking) {
    picking = false;
    begin(p);
    toast('已設定起點。請面向地圖上方後按「啟用感測器」或「重新對齊」');
    return;
  }
  // taps do nothing unless calibrating (so zooming and panning can't move you by mistake)
  if (!calibrating) return;
  const t = view.tol(18);
  let a = null; // the closest one: anchors can be only 5 m apart
  for (const q of doc.anchors) if (Math.hypot(q.x - p.x, q.y - p.y) < (a ? Math.hypot(a.x - p.x, a.y - p.y) : t)) a = q;
  if (a && grid && !lineFree(grid, p, a)) a = null; // behind a wall (e.g. tapped inside a building): use the spot itself
  if (a) {
    setCalibrating(false);
    return hereAt(a);
  }
  if (!(isOpen() && curvePos && grid)) return toast('請點地圖上的橘色定位點');
  if (!freeAt(grid, p)) return toast('那裡是不能走的地方（牆、水池…），請點你站的位置');
  // open-walk maps: anywhere you can stand works, indoors too
  setCalibrating(false);
  curvePos = { x: p.x, y: p.y };
  freeSteps = 0;
  atAnchor = null;
  snapNow();
  planRoute();
  update();
  toast('已校正到你點的位置，誤差歸零');
}

// ---------- navigation ----------
function doStep(dir) {
  if (!nav && isOpen() && curvePos) return freeStep({ up: 0, right: 0.5, down: 1, left: 1.5 }[dir] * Math.PI);
  if (!nav) {
    if (curvePos && !doStep.warned) {
      doStep.warned = true;
      toast(isOpen() ? '自由走動的場地目前不推算步伐；經過定位點時點一下更新位置' : '彎路上不推算步伐；走到錨點時點一下錨點更新位置');
    }
    return;
  }
  const ev = nav.step(dir);
  lastDir = ev.travel || ev.dir || lastDir;
  if (ev.type === 'autoFlip') toast('偵測到一直撞到走道盡頭，已自動反轉方向。如果不對，請按「⇅ 方向反了」');
  if (ev.type === 'ignored') toast(`這裡沒有往${DIR_LABEL[ev.dir].slice(2)}的走道，請走到路口再轉彎`);
  update();
}

function update() {
  if (!nav) {
    if (!curvePos) return;
    $('hud-pos').textContent = `(${Math.round(curvePos.x)}, ${Math.round(curvePos.y)})`;
    $('hud-line').textContent = isOpen() ? '自由走動' : '彎路';
    $('hud-prog').textContent = '–';
    $('hud-dir').textContent = '–';
    if (isOpen()) {
      $('hud-steps').textContent = freeSteps;
      $('drift').classList.toggle('hidden', freeSteps < 150);
      $('hud-dir').textContent = freeAngle != null ? `${Math.round((((freeAngle * 180) / Math.PI) % 360 + 360) % 360)}°` : '–';
      const left = route ? routeProgress(route, curvePos) : null;
      $('hud-prog').textContent = left ? `剩 ${Math.round(left.remaining / ppmOf())} m` : '–';
      $('dest-info').textContent = !dest ? '' : route ? `剩約 ${Math.round(left.remaining / ppmOf())} 公尺` : '找不到可以走到那裡的路';
      const at = atAnchor || curvePos;
      if (atAnchor) $('hud-line').textContent = `在「${atAnchor.landmark || atAnchor.name}」`;
      const shown = route && left ? [{ x: at.x, y: at.y }, left.at, ...route.slice(left.seg + 1)] : null;
      view.set({ user: { x: at.x, y: at.y, angle: freeAngle }, route: shown });
      return;
    }
    view.set({ user: { x: curvePos.x, y: curvePos.y } });
    return;
  }
  const s = nav.state;
  const L = doc.graph.lines.find((l) => l.id === s.line);
  $('hud-pos').textContent = `(${Math.round(s.x)}, ${Math.round(s.y)})`;
  $('hud-line').textContent = L ? `${L.id}: ${L.a ? 'x' : 'y'} = ${Math.round(L.c)}` : '–';
  $('hud-prog').textContent = `${Math.round(nav.progress() * 100)}%`;
  $('hud-steps').textContent = s.stepsSinceAnchor;
  $('hud-dir').textContent = lastDir ? DIR_LABEL[lastDir] : '–';
  $('hud-flip').classList.toggle('hidden', !nav.flipped);
  $('drift').classList.toggle('hidden', s.stepsSinceAnchor < 150);
  view.set({ user: { x: s.x, y: s.y, dir: lastDir } });
}

function hereAt(a) {
  if (!nav || isCurve(a.line)) {
    if (!nav && !curvePos) return;
    begin(a, a.line);
    if (curvePos) toast(`已在「${a.name}」重新定位${isOpen() ? '，誤差歸零' : '（彎路上）'}`);
    return;
  }
  const learned = nav.resetToAnchor(a);
  theta0 = heading ?? theta0;
  toast(
    learned
      ? `已在「${a.name}」重新定位，並更新這段走道的比例（每步 ${learned.pxPerStep.toFixed(1)} px）`
      : `已在「${a.name}」重新定位，誤差歸零`
  );
  update();
}

$('btn-here').onclick = () => hereAt(doc.anchors[$('sel-anchor').value]);
$('btn-flip').onclick = () => {
  if (!nav) return;
  nav.flip();
  toast(nav.flipped ? '已反轉方向' : '已恢復原本方向');
  update();
};
$('btn-align').onclick = () => {
  if (heading == null) return toast('尚未取得方向感測器資料，請先啟用感測器');
  theta0 = heading;
  toast('已對齊：現在你面向的方向＝地圖上方');
};

// simulated steps
const simulate = (dir) => doStep($('chk-reversed').checked ? opposite(dir) : dir);
document.querySelectorAll('[data-dir]').forEach((b) => (b.onclick = () => simulate(b.dataset.dir)));
document.addEventListener('keydown', (e) => {
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
  if (dir && (nav || (isOpen() && curvePos)) && !$('sec-nav').classList.contains('hidden')) {
    e.preventDefault();
    simulate(dir);
  }
});

// ---------- sensors ----------
let sensors = 'off'; // off | waiting | on | nocompass | denied
let sensorSteps = 0;
const isPhone = () => matchMedia('(pointer: coarse)').matches;
function sensorStatus() {
  const bar = $('sensor-bar');
  $('sensor-text').textContent = {
    off: isPhone() ? '⚠️ 感測器還沒開啟：走路時位置不會移動' : '💻 電腦上沒有感測器：用方向鍵或下方「電腦模擬」走路',
    waiting: '⏳ 正在等感測器資料…',
    on: `✅ 感測器運作中 · 已偵測 ${sensorSteps} 步${heading != null ? ` · 手機朝向 ${Math.round(heading)}°` : ''}`,
    nocompass: '❌ 讀不到方向（指南針）：這台裝置或瀏覽器不支援，只能用下方按鈕模擬',
    denied: '❌ 沒有允許「動作與方向」：請在瀏覽器設定允許後，再按一次開啟',
  }[sensors];
  bar.className = `notice sensor-bar ${sensors === 'on' ? 'ok' : sensors === 'nocompass' || sensors === 'denied' ? 'bad' : 'warn'}`;
  $('btn-sensors-top').classList.toggle('hidden', sensors === 'on' || sensors === 'waiting' || (sensors === 'off' && !isPhone()));
  $('btn-sensors').textContent = sensors === 'on' ? '感測器運作中' : '啟用感測器';
}
$('btn-sensors-top').onclick = () => enableSensors();
$('btn-sensors').onclick = () => enableSensors();
async function enableSensors() {
  if (sensors === 'on' || sensors === 'waiting') return;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') throw new Error('未授權動作感測器');
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') throw new Error('未授權方向感測器');
    }
  } catch (e) {
    sensors = 'denied';
    sensorStatus();
    return toast(e.message);
  }
  window.addEventListener('devicemotion', onMotion);
  const evName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(evName, onOrientation);
  $('hud-sensor').textContent = '等待資料…';
  sensors = 'waiting';
  sensorStatus();
  setTimeout(() => {
    if (heading == null) {
      $('hud-sensor').textContent = '此裝置沒有方向感測器（可用電腦模擬）';
      sensors = 'nocompass';
      sensorStatus();
    }
  }, 2500);
}

function onOrientation(e) {
  let h = e.webkitCompassHeading ?? (e.alpha != null ? 360 - e.alpha : null);
  if (h == null) return;
  h = (h + (screen.orientation?.angle || 0)) % 360; // compensate screen rotation
  const first = heading == null;
  heading = h;
  if (first) {
    if (theta0 == null) theta0 = h;
    $('hud-sensor').textContent = '運作中';
    sensors = 'on';
    sensorStatus();
  }
}

// Step detection: low-passed acceleration magnitude, peak above a slow baseline.
const det = { lp: 9.8, base: 9.8, armed: false, last: 0 };
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y, a.z);
  det.lp = det.lp * 0.8 + mag * 0.2;
  det.base = det.base * 0.98 + det.lp * 0.02;
  const now = performance.now();
  if (!det.armed && det.lp > det.base + 1.2) det.armed = true;
  if (det.armed && det.lp < det.base) {
    det.armed = false;
    if (now - det.last > 300) {
      det.last = now;
      sensorSteps++;
      if (sensors === 'on') {
        sensorStatus();
        const bar = $('sensor-bar');
        bar.classList.remove('pulse');
        void bar.offsetWidth; // restart the animation: each step flashes the bar
        bar.classList.add('pulse');
      }
      if (heading != null && theta0 != null) {
        if (isOpen() && curvePos && !nav) freeStep(((heading - theta0) * Math.PI) / 180);
        else {
          det.dir = quantize(heading, theta0, det.dir); // raw sensor direction (before any flip)
          doStep(det.dir);
        }
      }
    }
  }
}

// ---------- open-walk maps: destination, route, free steps ----------
let freeAngle = null;
/** One step heading angle (radians, 0 = map up, clockwise); stops at obstacles, never snaps to the route. */
function freeStep(angle) {
  if (!curvePos || !grid) return;
  freeAngle = angle;
  curvePos = walkStep(grid, curvePos, angle, stepPx());
  snapNow();
  freeSteps++;
  const left = route && routeProgress(route, curvePos);
  if (dest && (!route || left.off > 5 * ppmOf())) planRoute(); // wandered off: new route from here
  else if (left && !arrived && left.remaining < 3 * ppmOf()) {
    arrived = true;
    toast(`已抵達「${dest.name}」附近`);
  }
  update();
}

/** Route from the current position to the closest point of the destination. */
function planRoute() {
  route = null;
  arrived = false;
  if (!dest || !curvePos || !grid) return;
  let best = null;
  for (const p of dest.pts) {
    const r = findRoute(grid, curvePos, p);
    if (!r) continue;
    const L = r.slice(1).reduce((n, q, i) => n + Math.hypot(q.x - r[i].x, q.y - r[i].y), 0);
    if (!best || L < best.L) best = { r, L };
  }
  route = best && best.r;
}

/** Places to go: buildings (their doors, or the building itself), booths, anchors. */
function destinations() {
  const out = [];
  for (const o of doc.graph.obstacles || []) {
    if (!o.name) continue;
    const xs = o.points.map((q) => q.x), ys = o.points.map((q) => q.y);
    const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    out.push({ name: o.name, pts: (o.doors || []).length ? o.doors.map((d) => ({ x: d.x, y: d.y })) : [c] });
  }
  for (const p of otherPois()) if (!out.some((d) => d.name === p.name)) out.push({ name: p.name, pts: [{ x: p.x, y: p.y }] });
  // a dense anchor grid (every few metres) would bury the list; the places above are enough then
  if (doc.anchors.length <= 40) for (const a of doc.anchors) out.push({ name: `📍 ${anchorLabel(a)}`, pts: [{ x: a.x, y: a.y }] });
  return out;
}

let destList = [];
$('sel-dest').addEventListener('change', () => {
  dest = destList[$('sel-dest').value] || null;
  planRoute();
  update();
  if (dest && !route) toast(`找不到可以走到「${dest.name}」的路`);
});
function fillDestinations() {
  destList = destinations();
  $('sel-dest').replaceChildren(
    new Option('（選一個地方）', ''),
    ...destList.map((d, i) => new Option(d.name, i))
  );
}
