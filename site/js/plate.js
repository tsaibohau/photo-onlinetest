// Door plates: turn the text OCR read off a photo of a door sign into a room name, and run the
// OCR itself (Tesseract.js, loaded on first use). plateName is pure and tested.

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';

/** "  3 0 1 \n教 室" → "301 教室": drop OCR junk, close up digits and Chinese, one line. */
export function plateName(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l
    .replace(/[|~_`^"'“”‘’<>{}[\]\\/=+*#@$%&;:,.。，、·•]+/g, ' ')
    .replace(new RegExp(`([0-9${CJK}])\\s+(?=[0-9${CJK}])`, 'g'), (m, c) => c)
    .replace(/\s+/g, ' ')
    .trim()).filter((l) => l && /[0-9A-Za-z㐀-鿿]/.test(l));
  // close up digits and Chinese that sat on the same line as each other, after joining
  return lines.join(' ').slice(0, 40).trim();
}

let workerPromise = null;
function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = Object.assign(document.createElement('script'), { src, onload: ok, onerror: () => fail(new Error('辨識引擎載入失敗（需要網路）')) });
    document.head.append(s);
  });
}

/** Read the text on a door sign photo (File/Blob). Needs a network connection the first time. */
export async function readPlate(file, onStatus = () => {}) {
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  workerPromise ||= window.Tesseract.createWorker(['chi_tra', 'eng'], 1, { logger: (m) => m.status && onStatus(m.status, m.progress) });
  const worker = await workerPromise;
  // a phone photo is large: the sign fills a good part of it, 1600 px is plenty
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  await worker.setParameters({ tessedit_pageseg_mode: window.Tesseract.PSM.SPARSE_TEXT });
  const { data } = await worker.recognize(c);
  // keep the confident, larger words: door numbers and names are the big print on a sign
  const words = (data.words || []).filter((w) => w.confidence >= 50);
  if (!words.length) return plateName(data.text);
  const hMax = Math.max(...words.map((w) => w.bbox.y1 - w.bbox.y0));
  const big = words.filter((w) => w.bbox.y1 - w.bbox.y0 >= hMax * 0.45);
  big.sort((a, b) => (Math.abs(a.bbox.y0 - b.bbox.y0) < hMax * 0.5 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0));
  let text = '', lastY = null;
  for (const w of big) {
    text += (lastY != null && Math.abs(w.bbox.y0 - lastY) >= hMax * 0.5 ? '\n' : ' ') + w.text;
    lastY = w.bbox.y0;
  }
  return plateName(text);
}
