// One progress bar for the whole recognition run: it only moves forward, from 0 to 1, once.
// recognize() reports per step ("放大辨識 2/5") and Tesseract reports 0→1 for every single
// recognize() call; shown directly, the bar would jump back to 0 dozens of times.

const LOAD = { // first run only: the OCR engine and language data are downloaded
  'loading tesseract core': '載入辨識引擎',
  'initializing tesseract': '初始化',
  'loading language traineddata': '下載中英文字資料',
  'initializing api': '初始化',
};
const LOAD_ORDER = Object.keys(LOAD);

// [label prefix, start, end] in the order recognize() runs them
const STEPS = [
  ['辨識整張圖的文字', 0.15, 0.3],
  ['放大辨識', 0.3, 0.55],
  ['加強辨識文字', 0.55, 0.7],
  ['辨識物件', 0.7, 0.8],
  ['分析走道', 0.8, 0.82],
  ['辨識地面文字', 0.82, 0.9],
  ['辨識建築物', 0.9, 0.98],
];

/** Returns { update(msg) → { label, value }, done() → { label, value: 1 } }. */
export function createProgress() {
  let value = 0;
  let label = '準備中';
  let step = null; // { lo, hi, i, n } of the step that is running
  let started = false; // past the whole-page read
  const set = (v, l) => {
    value = Math.min(1, Math.max(value, v));
    if (l) label = l;
    return { label, value };
  };
  return {
    update(m) {
      const s = String(m?.status ?? '');
      const p = Math.min(1, Math.max(0, Number(m?.progress) || 0));
      if (s in LOAD) return set(0.15 * ((LOAD_ORDER.indexOf(s) + p) / LOAD_ORDER.length), LOAD[s]);
      if (s === 'recognizing text') {
        if (started && !step) return { label, value };
        if (!step) return set(0.15 + 0.15 * p, '辨識整張圖的文字');
        // one item of the current step is being read
        return set(step.lo + ((step.i - 1 + p) / step.n) * (step.hi - step.lo));
      }
      const def = STEPS.find(([name]) => s.startsWith(name));
      if (!def) return { label, value };
      const [, lo, hi] = def;
      started = true;
      const k = s.match(/(\d+)\s*\/\s*(\d+)/);
      if (!k) {
        step = null;
        return set(lo + (hi - lo) * p, s);
      }
      step = { lo, hi, i: +k[1], n: Math.max(1, +k[2]) };
      return set(lo + ((step.i - 1) / step.n) * (hi - lo), s);
    },
    done() {
      return set(1, '完成');
    },
  };
}
