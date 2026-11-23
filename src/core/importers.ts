// 檔案 → 純文字。所有處理都在瀏覽器端完成，檔案不會上傳到任何伺服器。
// 重量級函式庫（tesseract / pdf.js / mammoth）都是動態載入，只有用到時才下載。

export type Progress = (msg: string, ratio?: number) => void;

export type OcrLang = 'chi_tra+eng' | 'chi_sim+eng' | 'eng' | 'jpn+eng';
export const OCR_LANGS: { id: OcrLang; label: string }[] = [
  { id: 'chi_tra+eng', label: '繁體中文 + 英文' },
  { id: 'chi_sim+eng', label: '簡體中文 + 英文' },
  { id: 'eng', label: '英文' },
  { id: 'jpn+eng', label: '日文 + 英文' },
];

/** 將圖片縮放到適合 OCR 的尺寸並做灰階＋對比強化 */
export interface PrepOptions {
  /** stretch = 只做對比拉伸；adaptive = 局部二值化（去除灰底、陰影、光線不均） */
  mode?: 'stretch' | 'adaptive';
  maxSide?: number;
}

export async function prepareImage(src: Blob | HTMLCanvasElement, opts: PrepOptions = {}): Promise<HTMLCanvasElement> {
  const { mode = 'adaptive', maxSide = 3000 } = opts;
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  if (src instanceof HTMLCanvasElement) {
    source = src;
    w = src.width;
    h = src.height;
  } else {
    const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    source = bmp;
    w = bmp.width;
    h = bmp.height;
  }
  const longSide = Math.max(w, h);
  const scale = longSide > maxSide ? maxSide / longSide : longSide < 1400 ? 1400 / longSide : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  // 灰階 + 以 2%/98% 百分位做對比拉伸
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[d[i]]++;
  }
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  if (mode === 'adaptive') adaptiveThreshold(d, canvas.width, canvas.height);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Sauvola 局部二值化：以每個像素周圍視窗的平均與標準差決定門檻，
 * 能把灰色底紋、陰影、手機拍照的光線不均都變成乾淨的白底黑字。
 */
function adaptiveThreshold(d: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 0; x < w; x++) {
      const v = d[(y * w + x) * 4];
      rs += v;
      rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 60));
  const k = 0.2;
  const R = 128;
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const cnt = (y1 - y0) * (x1 - x0);
      const s = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      const q = sq[y1 * W + x1] - sq[y0 * W + x1] - sq[y1 * W + x0] + sq[y0 * W + x0];
      const mean = s / cnt;
      const std = Math.sqrt(Math.max(0, q / cnt - mean * mean));
      const t = mean * (1 + k * (std / R - 1));
      out[y * w + x] = d[(y * w + x) * 4] > t ? 255 : 0;
    }
  }
  for (let i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i];
}

type TWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;
let workerPromise: Promise<TWorker> | null = null;
let workerLang: OcrLang | null = null;
let progressSink: Progress = () => {};

async function getWorker(lang: OcrLang): Promise<TWorker> {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) (await workerPromise).terminate();
  workerLang = lang;
  workerPromise = import('tesseract.js').then(({ createWorker }) =>
    createWorker(lang.split('+'), 1, {
      logger: (m: { status: string; progress: number }) => {
        const label: Record<string, string> = {
          'loading tesseract core': '載入 OCR 引擎',
          'initializing tesseract': '初始化 OCR 引擎',
          'loading language traineddata': '下載語言資料（第一次較久）',
          'initializing api': '準備辨識',
          'recognizing text': '辨識文字中',
        };
        progressSink(label[m.status] ?? m.status, m.progress);
      },
    }),
  );
  workerPromise.catch(() => {
    workerPromise = null;
  });
  return workerPromise;
}

export async function ocrImage(src: Blob | HTMLCanvasElement, lang: OcrLang, onProgress: Progress): Promise<string> {
  progressSink = onProgress;
  onProgress('前處理圖片', 0);
  const canvas = await prepareImage(src);
  const worker = await getWorker(lang);
  const { data } = await worker.recognize(canvas);
  return data.text;
}

export async function pdfToText(file: Blob, lang: OcrLang, onProgress: Progress): Promise<string> {
  onProgress('載入 PDF 引擎', 0);
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress(`讀取第 ${p}/${doc.numPages} 頁`, (p - 1) / doc.numPages);
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
    }
    if (text.replace(/\s/g, '').length < 15) {
      // 掃描檔：沒有文字層，改用 OCR
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      text = await ocrImage(canvas, lang, (msg, r) =>
        onProgress(`第 ${p}/${doc.numPages} 頁：${msg}`, (p - 1 + (r ?? 0)) / doc.numPages),
      );
    }
    pages.push(text);
  }
  return pages.join('\n');
}

export async function docxToText(file: Blob, onProgress: Progress): Promise<string> {
  onProgress('讀取 Word 檔', 0);
  const mod = await import('mammoth/mammoth.browser');
  const mammoth = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return res.value;
}

/** 把圖片壓縮成 data URL（用於題目附圖） */
export async function imageToDataUrl(file: Blob, maxSide = 1200): Promise<string> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
