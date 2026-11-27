// "Walk the walls" survey page: record steps (accelerometer) and heading (gyroscope) while the
// user walks along walls and marks doors, stairs and landmarks; then straighten it into a floor
// map and hand each floor to the editor to export a .phop.
import { StepDetector, headingFromAlpha, stepLengthFor } from './pdr.js';
import { trackPoints, wallLines, buildFloors, floorToVenue, measureAcross, detectStairTurn, similarity } from './surveymap.js';
import { renderVenue } from './mapgen.js';
import { readPlate } from './plate.js';
import { putBlob, getBlob, delBlob } from './blobstore.js';
import { interiorFromSurvey } from './interior.js';

const $ = (id) => document.getElementById(id);
const KEY = 'photopath:survey';
const RAW_KEY = 'photopath:survey:raw';
const DRAFT_KEY = 'photopath:editor:draft';
const WIZ_KEY = 'photopath:editor:wizard';
const MARK_ICON = { door: '🚪', stairs: '🪜', elevator: '🛗', landmark: '📍', loop: '🔁' };
const MARK_LABEL = { door: '門', stairs: '樓梯', elevator: '電梯', landmark: '地標', loop: '回到標記點' };
const TREAD = 0.3; // how far one step on stairs goes forward (one tread)
const EDITOR_BG = 'editor-bg'; // aligned evacuation map handed to the editor (IndexedDB)
const SURVEY_TARGET = 'photopath:survey:target'; // editor → survey: the building to walk ({ id, name, floor, door, inward })
const SURVEY_RESULT = 'photopath:survey:interior'; // survey → editor: { id, floors: [{ label, parts }] }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- session (saved after every change, so a reload loses nothing) ----------
// S = { v, name, stepLen, cur, width? (corridor), depth (rooms), onStairs?: { from },
//   floors: [{ label, link?, stairAsk?, evac?: { id, pts: [{u, v, idx}] },
//     steps: [{h, len, t}], walls: [{side: left|right|both, from, to, width?}], marks: [{kind, at, name?, side?, ref?}] }] }
let S = null;
let raw = []; // sensor samples [t, ax, ay, az, alpha, beta, gamma, ra, rb, rg]
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage full */ }
};
function saveRaw() {
  try { localStorage.setItem(RAW_KEY, JSON.stringify(raw)); } catch { $('sv-status-text').dataset.rawFull = '1'; }
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s?.v === 1 && s.floors?.length) return s;
  } catch { /* ignore */ }
  return null;
}
const floor = () => S.floors[S.cur];
const activeWall = () => floor().walls.find((w) => w.to == null);
const steps = () => floor().steps.length;

// ---------- setup ----------
$('sv-height').addEventListener('input', () => {
  const h = +$('sv-height').value;
  if (h >= 120 && h <= 210) $('sv-step').value = stepLengthFor(h);
});
let target = null;
try { target = JSON.parse(localStorage.getItem(SURVEY_TARGET)); } catch { /* none */ }
if (target) {
  $('sv-target-name').textContent = target.name;
  $('sv-target-floor').textContent = target.floor;
  $('sv-target').classList.remove('hidden');
  $('sv-name').value = target.name;
  $('sv-floor').value = target.floor;
}
$('sv-target-cancel').onclick = () => {
  localStorage.removeItem(SURVEY_TARGET);
  location.href = 'editor.html';
};
const old = loadSession();
if (old) {
  const n = old.floors.reduce((k, f) => k + f.steps.length, 0);
  $('sv-resume-info').textContent = `${old.name}，${old.floors.length} 層、${n} 步`;
  $('sv-resume').classList.remove('hidden');
}
$('sv-resume-go').onclick = () => {
  S = old;
  try { raw = JSON.parse(localStorage.getItem(RAW_KEY)) || []; } catch { raw = []; }
  startSensors();
  show('rec');
};
$('sv-resume-review').onclick = () => {
  S = old;
  try { raw = JSON.parse(localStorage.getItem(RAW_KEY)) || []; } catch { raw = []; }
  showReview();
};
$('sv-resume-drop').onclick = () => {
  if (!confirm('刪掉這份錄製？刪掉之後無法復原。')) return;
  localStorage.removeItem(KEY);
  localStorage.removeItem(RAW_KEY);
  $('sv-resume').classList.add('hidden');
};
$('sv-start').onclick = () => {
  const len = +$('sv-step').value;
  S = {
    v: 1,
    name: $('sv-name').value.trim() || '我的建築',
    stepLen: len >= 0.3 && len <= 1.1 ? len : 0.68,
    depth: +$('sv-depth').value >= 2 && +$('sv-depth').value <= 30 ? +$('sv-depth').value : 6,
    width: null,
    cur: 0,
    floors: [{ label: $('sv-floor').value.trim() || '1F', steps: [], walls: [], marks: [] }],
  };
  if (target) S.target = target;
  raw = [];
  save();
  saveRaw();
  startSensors(); // inside the tap: iPhone asks for permission here
  show('rec');
};

function show(which) {
  for (const s of ['setup', 'rec', 'review']) $(`sv-${s}`).classList.toggle('hidden', s !== which);
  if (which === 'rec') updateRec();
  window.scrollTo(0, 0);
}

// ---------- sensors ----------
let heading = null; // degrees, clockwise (gyro-relative)
let tilt = { beta: 0, gamma: 0 };
let sensorState = 'off'; // off | waiting | on | denied | none
let paused = false;
const det = new StepDetector();
let lastOri = [null, null, null];

async function startSensors() {
  navigator.wakeLock?.request('screen').then((l) => (wake = l)).catch(() => {});
  if (sensorState === 'on' || sensorState === 'waiting') return;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') throw new Error('denied');
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') throw new Error('denied');
    }
  } catch {
    sensorState = 'denied';
    return updateRec();
  }
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
  sensorState = 'waiting';
  updateRec();
  setTimeout(() => {
    if (sensorState === 'waiting') { sensorState = 'none'; updateRec(); }
  }, 3000);
}
let wake = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S && !$('sv-rec').classList.contains('hidden')) navigator.wakeLock?.request('screen').then((l) => (wake = l)).catch(() => {});
});

function onOrientation(e) {
  if (e.alpha == null) return;
  // alpha from the gyroscope (relative), not webkitCompassHeading: compasses go wrong indoors
  heading = headingFromAlpha(e.alpha);
  tilt = { beta: e.beta || 0, gamma: e.gamma || 0 };
  lastOri = [e.alpha, e.beta, e.gamma];
  if (sensorState !== 'on') { sensorState = 'on'; updateRec(); }
}

let lastRawSave = 0;
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const t = Math.round(performance.now());
  const r = e.rotationRate || {};
  const f = (v) => (v == null ? null : Math.round(v * 100) / 100);
  raw.push([t, f(a.x), f(a.y), f(a.z), f(lastOri[0]), f(lastOri[1]), f(lastOri[2]), f(r.alpha), f(r.beta), f(r.gamma)]);
  if (t - lastRawSave > 15000) { lastRawSave = t; saveRaw(); }
  if (det.feed(t, a.x, a.y, a.z) && !paused && heading != null && S && !$('sv-rec').classList.contains('hidden')) addStep(heading, t);
}

function addStep(h, t = Math.round(performance.now())) {
  floor().steps.push({ h: Math.round(h * 10) / 10, len: S.onStairs ? TREAD : S.stepLen, t });
  save();
  checkStairs();
  updateRec();
}

// ---------- stairs: a flight, a landing, back the other way → ask ----------
let stairHit = null, stairTimer = null;
function checkStairs() {
  if (S.onStairs || measuring || stairHit) return;
  const f = floor();
  const hit = detectStairTurn(f.steps, f.stairAsk || 0);
  if (!hit) return;
  f.stairAsk = f.steps.length; // ask about this turn only once
  stairHit = hit;
  $('sv-stairs-ask').classList.remove('hidden');
  clearTimeout(stairTimer);
  stairTimer = setTimeout(hideStairAsk, 20000);
  navigator.vibrate?.(80);
}
function hideStairAsk() {
  stairHit = null;
  $('sv-stairs-ask').classList.add('hidden');
}
$('sv-stairs-no').onclick = hideStairAsk;
$('sv-stairs-yes').onclick = () => {
  const hit = stairHit;
  hideStairAsk();
  if (!hit) return;
  const label = prompt('要去哪一層？（例如 2F、B1）', nextLabel(floor().label));
  if (!label || !label.trim()) return;
  // the steps since the stairs began went up treads, not along the floor
  const f = floor();
  // (not before the end of a wall walked on this floor: nobody follows a wall up the stairs)
  const start = Math.max(hit.start, ...f.walls.filter((w) => w.to != null && w.to <= hit.turn).map((w) => w.to));
  for (let i = start; i < f.steps.length; i++) f.steps[i].len = TREAD;
  switchFloor('stairs', label.trim(), start);
};
$('sv-stairs-done').onclick = () => {
  if (!S.onStairs) return;
  addMark('stairs', { name: `樓梯（往 ${S.onStairs.from}）` });
  S.onStairs = null;
  save();
  updateRec();
  toast(`已到 ${floor().label}，樓梯位置已標記`);
};

// ---------- measuring: corridor width, room depth (walk wall to wall) ----------
let measuring = null; // { kind: 'width' | 'depth', from }
function startMeasure(kind) {
  if (S.onStairs) return toast('在樓梯上不能量，先按「到了」');
  measuring = { kind, from: steps() };
  $('sv-measure-title').textContent = kind === 'width' ? '📏 量走道寬' : '📐 量房間深';
  $('sv-measure-text').textContent = kind === 'width'
    ? '背貼著一邊的牆站好，直直走到對面的牆邊，再按「量好了」。'
    : '站在房間門口，直直走到房間最裡面的牆邊，再按「量好了」（走回來不用記）。';
  $('sv-measure').classList.remove('hidden');
  hideStairAsk();
}
$('sv-measure-width').onclick = () => startMeasure('width');
$('sv-measure-depth').onclick = () => startMeasure('depth');
$('sv-measure-cancel').onclick = () => { measuring = null; $('sv-measure').classList.add('hidden'); };
$('sv-measure-done').onclick = () => {
  const m = measuring;
  if (!m) return;
  measuring = null;
  $('sv-measure').classList.add('hidden');
  const n = steps() - m.from;
  const got = n >= 1 ? measureAcross(floor().steps, m.from, steps(), m.kind === 'width' ? 0.5 : 0.25) : null;
  const what = m.kind === 'width' ? '走道寬' : '房間深';
  const ans = prompt(got ? `量到${what}約 ${got} 公尺（走了 ${n} 步）。\n正確嗎？可以直接修改：` : `沒有偵測到腳步。直接輸入${what}（公尺）：`, got ?? '');
  const v = parseFloat(ans);
  if (!(v > 0.5 && v < 40)) return toast('沒有儲存');
  if (m.kind === 'width') {
    S.width = Math.round(v * 10) / 10;
    toast(`走道寬 ${S.width} m。走到走道中間按「走在走道中間」就會同時畫兩面牆`);
  } else {
    S.depth = Math.round(v * 10) / 10;
    toast(`房間深 ${S.depth} m，之後標門牌的房間都用這個深度`);
  }
  // the walk back out of a room is not part of the floor's shape either way; the steps stay
  // (a swerve that comes back to the same direction is straightened out later)
  floor().stairAsk = steps(); // walking into a room and back is not a stair landing
  save();
  updateRec();
};

// desktop simulation: ↑ step, ← → turn 90° (Shift: 15°)
let simHeading = 0;
document.addEventListener('keydown', (e) => {
  if (!S || $('sv-rec').classList.contains('hidden')) return;
  const turn = e.shiftKey ? 15 : 90;
  if (e.key === 'ArrowLeft') simHeading = (simHeading - turn + 360) % 360;
  else if (e.key === 'ArrowRight') simHeading = (simHeading + turn) % 360;
  else if (e.key === 'ArrowUp') addStep(simHeading + (Math.random() - 0.5) * 8);
  else return;
  e.preventDefault();
  updateRec();
});

// ---------- recording controls ----------
const undoStack = []; // functions that undo the last action
function startWall(side) {
  if (side === 'both' && !S.width) {
    const v = parseFloat(prompt('走道寬幾公尺？\n（可以先取消，按「📏 量走道寬」從一邊的牆走到另一邊量）', ''));
    if (!(v > 0.5 && v < 40)) return;
    S.width = Math.round(v * 10) / 10;
  }
  floor().walls.push(side === 'both' ? { side, width: S.width, from: steps(), to: null } : { side, from: steps(), to: null });
  undoStack.push(() => floor().walls.pop());
  save();
  updateRec();
  toast(side === 'both' ? `沿著走道中間走（寬 ${S.width} m），兩邊的牆會一起畫` : `開始記錄牆（在你${side === 'left' ? '左' : '右'}邊），沿著牆走`);
}
$('sv-wall-left').onclick = () => startWall('left');
$('sv-wall-right').onclick = () => startWall('right');
$('sv-wall-mid').onclick = () => startWall('both');
$('sv-wall-stop').onclick = () => {
  const w = activeWall();
  if (!w) return;
  w.to = steps();
  undoStack.push(() => { w.to = null; });
  if (w.to - w.from < 2) toast('這面牆只有不到 2 步，太短的牆輸出時可能會被略過');
  save();
  updateRec();
};
function addMark(kind, extra = {}) {
  const m = { kind, at: steps(), ...extra };
  floor().marks.push(m);
  undoStack.push(() => floor().marks.splice(floor().marks.indexOf(m), 1));
  save();
  updateRec();
  return m;
}
document.querySelectorAll('[data-mark]').forEach((b) => (b.onclick = () => {
  const kind = b.dataset.mark;
  if (kind === 'door') return openDoor();
  if (kind === 'landmark') {
    const name = prompt('這裡叫什麼？（例如：101 教室門口、飲水機）');
    if (name == null) return;
    addMark(kind, { name: name.trim() });
  } else addMark(kind);
  toast(`已標記${MARK_LABEL[kind]}`);
}));
// door sheet: the room's name (typed, or read off a photo of the door plate) and its side
let door = null; // { at, side }
function openDoor() {
  const w = activeWall();
  door = { at: steps(), side: w && w.side !== 'both' ? w.side : null };
  $('sv-door-name').value = '';
  $('sv-door-ocr').textContent = '';
  setDoorSide(door.side);
  $('sv-door').classList.remove('hidden');
}
function setDoorSide(side) {
  door.side = side;
  document.querySelectorAll('#sv-door [data-side]').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
}
document.querySelectorAll('#sv-door [data-side]').forEach((b) => (b.onclick = () => setDoorSide(b.dataset.side)));
$('sv-door-cancel').onclick = () => { door = null; $('sv-door').classList.add('hidden'); };
$('sv-door-ok').onclick = () => {
  if (!door) return;
  const name = $('sv-door-name').value.trim();
  if (name && !door.side) return toast('房間在你的左邊還是右邊？選一邊才能畫出房間');
  const m = { kind: 'door', at: door.at };
  if (name) m.name = name;
  if (door.side) m.side = door.side;
  floor().marks.push(m);
  undoStack.push(() => floor().marks.splice(floor().marks.indexOf(m), 1));
  door = null;
  $('sv-door').classList.add('hidden');
  save();
  updateRec();
  toast(name ? `已標記「${name}」的門` : '已標記門');
};
$('sv-door-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const out = $('sv-door-ocr');
  out.textContent = '辨識中…（第一次要下載文字資料，約 10–20 秒）';
  try {
    const name = await readPlate(file, (s, p) => { out.textContent = `辨識中…${p ? ` ${Math.round(p * 100)}%` : ''}`; });
    if (name) {
      $('sv-door-name').value = name;
      out.textContent = '✓ 已帶入，可以修改';
    } else out.textContent = '讀不到字，請直接輸入';
  } catch (err) {
    out.textContent = err.message || '辨識失敗，請直接輸入';
  }
});

$('sv-loop').onclick = () => {
  const marks = floor().marks.map((m, i) => ({ m, i })).filter(({ m }) => m.kind !== 'loop' && m.at < steps());
  if (!marks.length) return toast('這一層還沒有標記點。先在明顯的地方按 📍 或 🚪 標記，走回來時再按這個');
  const pts = trackPoints(floor().steps);
  const here = pts[pts.length - 1];
  marks.sort((a, b) => Math.hypot(pts[a.m.at].x - here.x, pts[a.m.at].y - here.y) - Math.hypot(pts[b.m.at].x - here.x, pts[b.m.at].y - here.y));
  const list = marks.slice(0, 9).map(({ m }, k) => `${k + 1}. ${MARK_ICON[m.kind]} ${m.name || MARK_LABEL[m.kind]}（第 ${m.at} 步）`).join('\n');
  const ans = prompt(`你現在回到哪一個標記點？輸入編號（離目前推算位置最近的排前面）：\n${list}`, '1');
  const k = +ans - 1;
  if (!marks[k]) return;
  addMark('loop', { ref: marks[k].i });
  toast(`已對齊到「${marks[k].m.name || MARK_LABEL[marks[k].m.kind]}」，誤差會在輸出時修掉`);
};
$('sv-undo').onclick = () => {
  const u = undoStack.pop();
  if (!u) return toast('沒有可以復原的動作');
  u();
  save();
  updateRec();
  toast('已復原');
};
$('sv-pause').onclick = () => {
  paused = !paused;
  updateRec();
  toast(paused ? '已暫停：走路不會計步（例如要讓路、繞過人群）。注意暫停時的移動不會被記錄' : '繼續計步');
};
$('sv-floor-switch').onclick = () => {
  const how = prompt('怎麼換樓層？輸入 1＝走樓梯，2＝搭電梯', '1');
  if (how !== '1' && how !== '2') return;
  const label = prompt('要去哪一層？（例如 2F、B1）', nextLabel(floor().label));
  if (!label || !label.trim()) return;
  switchFloor(how === '1' ? 'stairs' : 'elevator', label.trim());
};
/**
 * Leave this floor by stairs or elevator from step `at` (default: here). By stairs, steps count as
 * treads until "到了"; the stairs are marked where they began and where they arrive.
 */
function switchFloor(kind, label, at = steps()) {
  const w = activeWall();
  if (w) w.to = Math.min(steps(), at);
  floor().marks.push({ kind, at, name: `${MARK_LABEL[kind]}（往 ${label}）` });
  const from = S.cur, fromLabel = floor().label;
  let idx = S.floors.findIndex((f) => f.label === label);
  const fresh = idx < 0;
  if (fresh) {
    S.floors.push({ label, link: { floor: from, at: steps() }, steps: [], walls: [], marks: [] });
    idx = S.floors.length - 1;
  }
  S.cur = idx;
  if (kind === 'stairs') S.onStairs = { from: fromLabel };
  else if (fresh) floor().marks.push({ kind, at: 0, name: `${MARK_LABEL[kind]}（往 ${fromLabel}）` });
  undoStack.length = 0;
  hideStairAsk();
  save();
  updateRec();
  // back to a floor already walked: carry on from its end (best to mark 🔁 at a known spot there)
  toast(kind === 'stairs' ? `往 ${label}：在樓梯上每步算 ${TREAD} m，到了按「✔ 到了」` : fresh ? `現在在 ${label}` : `回到 ${label}：建議走到這層標過的地方按 🔁 對齊`);
}
const nextLabel = (l) => {
  const m = /^(\d+)F$/i.exec(l);
  return m ? `${+m[1] + 1}F` : '';
};
$('sv-finish').onclick = () => {
  const w = activeWall();
  if (w) w.to = steps();
  save();
  showReview();
};

// ---------- live view ----------
function updateRec() {
  if (!S) return;
  const st = $('sv-status');
  const steep = Math.abs(tilt.beta) > 55 || Math.abs(tilt.gamma) > 45;
  const text = {
    off: '💻 沒有感測器：用方向鍵模擬（↑ 走一步、← → 轉彎）',
    waiting: '⏳ 正在等感測器資料…',
    on: paused ? '⏸ 已暫停計步' : steep ? '⚠️ 手機請放平（螢幕朝上），方向才會準' : '✅ 錄製中：走路就會記錄',
    denied: '❌ 沒有允許「動作與方向」。請到 設定 › Safari › 動作與方向取用 打開，再重新整理這頁',
    none: '❌ 讀不到感測器：請確認用手機的 Safari 開啟，或用方向鍵模擬',
  }[sensorState];
  $('sv-status-text').textContent = text + ($('sv-status-text').dataset.rawFull ? '（原始資料太大存不下，完成後請匯出）' : '');
  st.className = `notice sv-status ${sensorState === 'on' && !paused && !steep ? 'ok' : sensorState === 'denied' || sensorState === 'none' ? 'bad' : 'warn'}`;
  const f = floor();
  $('sv-hud-floor').textContent = f.label;
  $('sv-hud-steps').textContent = f.steps.length;
  $('sv-hud-dist').textContent = Math.round(f.steps.reduce((n, s) => n + s.len, 0));
  const h = sensorState === 'on' ? heading : simHeading;
  $('sv-hud-dir').textContent = h == null ? '–' : `${Math.round(h)}°`;
  $('sv-hud-width').textContent = S.width ? `${S.width} m` : '–';
  $('sv-onstairs').classList.toggle('hidden', !S.onStairs);
  $('sv-tread').textContent = TREAD;
  if (S.onStairs) $('sv-stairs-done').textContent = `✔ 到 ${f.label} 了`;
  const on = !!activeWall();
  $('sv-wall-off').classList.toggle('hidden', on);
  $('sv-wall-on').classList.toggle('hidden', !on);
  const aw = activeWall();
  $('sv-wall-stop').textContent = aw?.side === 'both' ? '■ 這段走道結束' : '■ 這面牆結束';
  $('sv-pause').textContent = paused ? '▶ 繼續計步' : '⏸ 暫停計步';
  drawLive();
}

function fitCanvas(c, pts, heightFrac = 0.5) {
  const W = c.parentElement.clientWidth || 320;
  const H = Math.round(Math.min(window.innerHeight * heightFrac, W * 1.1));
  const dpr = window.devicePixelRatio || 1;
  c.style.width = `${W}px`;
  c.style.height = `${H}px`;
  c.width = W * dpr;
  c.height = H * dpr;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs, -3), x1 = Math.max(...xs, 3), y0 = Math.min(...ys, -3), y1 = Math.max(...ys, 3);
  const k = Math.min((W - 30) / (x1 - x0), (H - 30) / (y1 - y0), 40);
  const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, k, tx: (p) => ({ x: ox + p.x * k, y: oy + p.y * k }) };
}

function drawLive() {
  const f = floor();
  const pts = trackPoints(f.steps, { x: 0, y: 0 });
  const { g, k, tx } = fitCanvas($('sv-live'), pts, 0.42);
  // scale bar
  const m = [1, 2, 5, 10, 20, 50].find((v) => v * k >= 50) || 50;
  g.strokeStyle = '#64748b';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(12, 14); g.lineTo(12 + m * k, 14);
  g.stroke();
  g.fillStyle = '#64748b';
  g.font = '12px system-ui, sans-serif';
  g.fillText(`${m} m`, 16 + m * k, 18);
  // walls
  const walls = f.walls.map((w) => ({ ...w, to: w.to ?? f.steps.length }));
  g.lineCap = 'round';
  g.lineJoin = 'round';
  wallLines(pts, walls, 0.5).forEach((L) => {
    g.strokeStyle = '#334155';
    g.lineWidth = Math.max(3, k * 0.25);
    g.beginPath();
    L.map(tx).forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.stroke();
  });
  // track
  g.strokeStyle = 'rgba(79,70,229,.55)';
  g.lineWidth = 2;
  g.beginPath();
  pts.map(tx).forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
  g.stroke();
  // marks
  g.font = '18px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const mk of f.marks) {
    const q = tx(pts[Math.min(mk.at, pts.length - 1)]);
    g.fillText(MARK_ICON[mk.kind] || '•', q.x, q.y - 12);
  }
  // you
  const here = tx(pts[pts.length - 1]);
  const h = ((sensorState === 'on' ? heading : simHeading) ?? 0) * (Math.PI / 180);
  g.fillStyle = '#2563eb';
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(here.x, here.y, 8, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(here.x + Math.sin(h) * 20, here.y - Math.cos(h) * 20);
  g.lineTo(here.x + Math.sin(h + 2.6) * 9, here.y - Math.cos(h + 2.6) * 9);
  g.lineTo(here.x + Math.sin(h - 2.6) * 9, here.y - Math.cos(h - 2.6) * 9);
  g.fill();
}
window.addEventListener('resize', () => { if (S && !$('sv-rec').classList.contains('hidden')) drawLive(); });

// ---------- review ----------
let tab = 0;
let shown = null; // { venue, ppm, built } of the floor on screen
function built() {
  return buildFloors(S.floors, { straighten: $('sv-straight').checked, roomDepth: $('sv-rooms').checked ? S.depth ?? 6 : 0, corridorWidth: S.width || 0 });
}
$('sv-rooms').addEventListener('change', () => drawReview());
function showReview() {
  show('review');
  tab = Math.min(tab, S.floors.length - 1);
  $('sv-review-title').textContent = `檢查地圖：${S.name}`;
  $('sv-to-editor').textContent = S.target ? `🏢 放回編輯器的「${S.target.name}」` : '✏️ 這層在編輯器開啟，輸出 .phop';
  $('sv-tabs').replaceChildren(...S.floors.map((f, i) => {
    const b = Object.assign(document.createElement('button'), { textContent: f.label, className: i === tab ? 'on' : '' });
    b.onclick = () => { tab = i; showReview(); };
    return b;
  }));
  $('sv-tabs').classList.toggle('hidden', S.floors.length < 2);
  drawReview();
}
$('sv-straight').addEventListener('change', drawReview);

function drawReview() {
  const f = S.floors[tab];
  if (!f.steps.length) {
    $('sv-review-info').textContent = '這一層還沒有走任何一步。';
    shown = null;
    const c = $('sv-out');
    c.width = c.height = 1;
    return;
  }
  const b = built()[tab];
  const venue = floorToVenue(b, `${S.name} ${f.label}`);
  const c = $('sv-out');
  const W = c.parentElement.clientWidth || 320;
  const ppm = Math.min(60, (W * (window.devicePixelRatio || 1)) / venue.width);
  const img = renderVenue(venue, ppm, 'plain');
  c.width = img.width;
  c.height = img.height;
  c.style.width = '100%';
  c.style.height = 'auto';
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  // the evacuation map photo, turned and scaled onto the map by its two matching points
  const T = evacTransform(f, b, venue);
  const photo = evacImgs[f.evac?.id];
  $('sv-evac-opacity').classList.toggle('hidden', !f.evac);
  $('sv-evac-realign').classList.toggle('hidden', !f.evac);
  $('sv-evac-remove').classList.toggle('hidden', !f.evac);
  $('sv-evac-opacity').textContent = `疊圖 ${Math.round(evacOpacity * 100)}%`;
  if (f.evac && !photo) loadEvac(f.evac.id).then((ok) => ok && drawReview());
  if (T && photo && evacOpacity > 0) {
    g.save();
    g.globalAlpha = evacOpacity;
    g.setTransform(T.ar * ppm, T.ai * ppm, -T.ai * ppm, T.ar * ppm, T.bx * ppm, T.by * ppm);
    g.drawImage(photo, 0, 0);
    g.restore();
  }
  // the anchors (doors, stairs, landmarks) with their names
  g.font = '600 ' + Math.max(12, ppm * 0.45) + 'px system-ui, sans-serif';
  g.textBaseline = 'middle';
  for (const a of venue.anchors) {
    g.fillStyle = '#ea580c';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(a.x * ppm, a.y * ppm, Math.max(5, ppm * 0.25), 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#9a3412';
    g.fillText(a.name, a.x * ppm + Math.max(8, ppm * 0.4), a.y * ppm);
  }
  shown = { venue, ppm, b, T };
  const dist = Math.round(f.steps.reduce((n, s) => n + s.len, 0));
  $('sv-review-info').textContent = `${venue.width} × ${venue.height} m · 走了 ${f.steps.length} 步（約 ${dist} m）· 牆 ${venue.obstacles.length} 段 · 房間 ${venue.blocks.length} 間 · 定位點 ${venue.anchors.length} 個`;
  $('sv-depth-show').textContent = S.depth ?? 6;
  const warn = [...b.warnings];
  if (f.evac && !T) warn.push('逃生圖對位用的定位點不見了（可能被復原或刪掉），請按「重新對位」');
  $('sv-warn').innerHTML = '';
  warn.forEach((w) => $('sv-warn').append(Object.assign(document.createElement('div'), { textContent: `⚠️ ${w}` })));
  $('sv-warn').classList.toggle('hidden', !warn.length);
}

// ---------- evacuation map: a photo matched to the map by two anchors ----------
const evacImgs = {}; // id → ImageBitmap
let evacOpacity = 0.5;
async function loadEvac(id) {
  if (evacImgs[id]) return true;
  try {
    const blob = await getBlob(id);
    if (!blob) return false;
    evacImgs[id] = await createImageBitmap(blob);
    return true;
  } catch { return false; }
}
/** Photo pixels → venue metres for floor f (built b, venue v), or null if not aligned. */
function evacTransform(f, b, v) {
  const pts = f.evac?.pts;
  if (!pts || pts.length < 2) return null;
  const dst = pts.map((p) => {
    const i = b.marks.findIndex((m) => m.idx === p.idx);
    return i >= 0 ? v.anchors[i] : null;
  });
  if (dst.some((d) => !d)) return null;
  return similarity(pts, dst);
}
let align = null; // { id, pts: [] } while matching points
$('sv-evac-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !shown) return;
  if (shown.b.marks.length < 2) return toast('這層至少要有 2 個標記（門、樓梯、地標）才能對位');
  try {
    const id = `evac-${Date.now()}`;
    evacImgs[id] = await createImageBitmap(file);
    await putBlob(id, file);
    startAlign(id);
  } catch { toast('無法讀取這張圖片'); }
});
$('sv-evac-realign').onclick = async () => {
  const f = S.floors[tab];
  if (f.evac && (await loadEvac(f.evac.id))) startAlign(f.evac.id);
};
$('sv-evac-remove').onclick = () => {
  const f = S.floors[tab];
  if (!f.evac) return;
  delBlob(f.evac.id).catch(() => {});
  delete f.evac;
  save();
  drawReview();
};
$('sv-evac-opacity').onclick = () => {
  evacOpacity = evacOpacity === 0.5 ? 0.25 : evacOpacity === 0.25 ? 0 : 0.5;
  drawReview();
};
$('sv-align-cancel').onclick = () => { align = null; $('sv-align').classList.add('hidden'); };
function startAlign(id) {
  align = { id, pts: [] };
  const sel = $('sv-align-anchor');
  sel.replaceChildren(...shown.b.marks.map((m, i) => new Option(shown.venue.anchors[i].name, m.idx)));
  sel.selectedIndex = 0;
  $('sv-align').classList.remove('hidden');
  alignStep();
}
function alignStep() {
  const sel = $('sv-align-anchor');
  if (align.pts.length === 1) {
    // suggest the anchor farthest from the first one: the match is more exact
    const a0 = shown.b.marks.find((m) => m.idx === align.pts[0].idx);
    let best = 0, bd = -1;
    shown.b.marks.forEach((m, i) => { const d = Math.hypot(m.x - a0.x, m.y - a0.y); if (d > bd) { bd = d; best = i; } });
    sel.selectedIndex = best;
  }
  $('sv-align-text').textContent = `第 ${align.pts.length + 1}／2 點：選一個定位點，然後在照片上點它所在的位置。${align.pts.length ? '選離第一點遠一點的，對得比較準。' : '樓梯、出入口在逃生圖上最好找。'}`;
  const c = $('sv-photo'), img = evacImgs[align.id];
  const W = c.parentElement.clientWidth || 320;
  c.width = img.width;
  c.height = img.height;
  c.style.width = `${W}px`;
  c.style.height = `${(W * img.height) / img.width}px`;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const r = Math.max(6, img.width / 80);
  for (const p of align.pts) {
    g.fillStyle = '#ea580c';
    g.strokeStyle = '#fff';
    g.lineWidth = r / 3;
    g.beginPath();
    g.arc(p.u, p.v, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}
$('sv-photo').addEventListener('click', (e) => {
  if (!align) return;
  const c = $('sv-photo'), rect = c.getBoundingClientRect();
  const p = { u: ((e.clientX - rect.left) * c.width) / rect.width, v: ((e.clientY - rect.top) * c.height) / rect.height, idx: +$('sv-align-anchor').value };
  if (align.pts.some((q) => q.idx === p.idx)) return toast('這個定位點已經點過了，請選另一個');
  align.pts.push(p);
  if (align.pts.length < 2) return alignStep();
  const f = S.floors[tab];
  if (f.evac && f.evac.id !== align.id) delBlob(f.evac.id).catch(() => {});
  f.evac = { id: align.id, pts: align.pts };
  align = null;
  $('sv-align').classList.add('hidden');
  save();
  drawReview();
  const T = shown.T;
  toast(T ? `已疊上逃生圖（照片 1 像素 ≈ ${(T.scale * 100).toFixed(1)} 公分）` : '對位失敗，請重新對位');
  $('sv-out').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

/** The evacuation photo redrawn square to the map (the editor's background has no rotation). */
async function editorBackground(T, photo, venue) {
  const corners = [{ u: 0, v: 0 }, { u: photo.width, v: 0 }, { u: photo.width, v: photo.height }, { u: 0, v: photo.height }].map(T.apply);
  const x0 = Math.max(0, Math.min(...corners.map((p) => p.x))), y0 = Math.max(0, Math.min(...corners.map((p) => p.y)));
  const x1 = Math.min(venue.width, Math.max(...corners.map((p) => p.x))), y1 = Math.min(venue.height, Math.max(...corners.map((p) => p.y)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const res = Math.min(1 / T.scale, 2048 / Math.max(x1 - x0, y1 - y0)); // px per metre, no upscaling
  const c = Object.assign(document.createElement('canvas'), { width: Math.round((x1 - x0) * res), height: Math.round((y1 - y0) * res) });
  const g = c.getContext('2d');
  g.setTransform(T.ar * res, T.ai * res, -T.ai * res, T.ar * res, (T.bx - x0) * res, (T.by - y0) * res);
  g.drawImage(photo, 0, 0);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  return { blob, x: x0, y: y0, mpp: 1 / res };
}

$('sv-out').addEventListener('click', (e) => {
  if (!shown) return;
  const r = $('sv-out').getBoundingClientRect();
  const k = $('sv-out').width / r.width / shown.ppm; // css px → metres
  const p = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  let best = null;
  shown.venue.obstacles.forEach((o, i) => {
    const n = o.points.length / 2 + 1; // there-and-back outline: the first half is the line
    const L = o.points.slice(0, Math.ceil(n));
    for (let j = 0; j < L.length - 1; j++) {
      const a = L[j], q = L[j + 1], dx = q.x - a.x, dy = q.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const d = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
      if (!best || d < best.d) best = { d, i, len: L.slice(1).reduce((s, w, m) => s + Math.hypot(w.x - L[m].x, w.y - L[m].y), 0) };
    }
  });
  if (!best || best.d > 1.5) return;
  const ans = prompt(`這段牆量起來約 ${best.len.toFixed(1)} 公尺。\n輸入它的實際長度（公尺）來修正整張圖的比例；\n輸入 0 刪掉這面牆。`, best.len.toFixed(1));
  if (ans == null) return;
  const v = +ans;
  if (v === 0) {
    const wi = shown.b.wallOf[best.i];
    S.floors[tab].walls.splice(wi, 1);
    toast('已刪掉這面牆');
  } else if (v > 0 && best.len > 0) {
    const f = v / best.len;
    for (const fl of S.floors) for (const s of fl.steps) s.len = Math.round(s.len * f * 1000) / 1000;
    S.stepLen = Math.round(S.stepLen * f * 1000) / 1000;
    toast(`比例已修正（每步 ${S.stepLen} 公尺）`);
  } else return;
  save();
  drawReview();
});

$('sv-to-editor').onclick = async () => {
  if (!shown) return toast('這一層還沒有內容');
  if (S.target) {
    // all floors go back into the building, placed from the door the walk started at
    const floors = interiorFromSurvey(built(), S.target);
    try {
      localStorage.setItem(SURVEY_RESULT, JSON.stringify({ id: S.target.id, floors }));
      localStorage.removeItem(SURVEY_TARGET);
    } catch { return toast('瀏覽器儲存空間已滿，請先按「匯出錄製資料」備份'); }
    location.href = 'editor.html';
    return;
  }
  let hasDraft = false;
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY)); hasDraft = !!(d && (d.anchors?.length || d.obstacles?.length || d.corridors?.length)); } catch { /* none */ }
  if (hasDraft && !confirm('編輯器裡有一份還沒輸出的地圖，開啟這層會把它取代。要繼續嗎？')) return;
  const venue = { ...shown.venue };
  const photo = evacImgs[S.floors[tab].evac?.id];
  if (shown.T && photo) {
    try {
      const bg = await editorBackground(shown.T, photo, venue);
      if (bg) {
        venue.surveyBg = `bg-${Date.now()}`;
        await putBlob(EDITOR_BG, { ...bg, token: venue.surveyBg });
      }
    } catch { toast('逃生圖沒辦法帶到編輯器，地圖本身不受影響'); }
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(venue));
  localStorage.setItem(WIZ_KEY, JSON.stringify({ step: 6, mode: 'size', reviewed: { 3: true, 4: true, 5: true } }));
  location.href = 'editor.html';
};
$('sv-export').onclick = () => {
  const data = { app: 'PhotoPath survey', exported: new Date().toISOString(), userAgent: navigator.userAgent, session: S, raw };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${S.name}-錄製資料.json` });
  document.body.append(a);
  a.click();
  a.remove();
};
$('sv-back').onclick = () => {
  startSensors();
  show('rec');
};
$('sv-reset').onclick = () => {
  if (!confirm('刪掉整份錄製（所有樓層），重新開始？刪掉之後無法復原。建議先按「匯出錄製資料」備份。')) return;
  localStorage.removeItem(KEY);
  localStorage.removeItem(RAW_KEY);
  S = null;
  raw = [];
  $('sv-resume').classList.add('hidden');
  show('setup');
};
