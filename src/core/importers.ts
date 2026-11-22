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
export async function prepareImage(src: Blob | HTMLCanvasElement): Promise<HTMLCanvasElement> {
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
  const scale = longSide > 3000 ? 3000 / longSide : longSide < 1400 ? 1400 / longSide : 1;
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
  ctx.putImageData(img, 0, 0);
  return canvas;
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

export function fileKind(file: File): 'olt' | 'image' | 'pdf' | 'docx' | 'text' | 'json' | 'unknown' {
  const name = file.name.toLowerCase();
  if (name.endsWith('.olt') || name.endsWith('.olt.json')) return 'olt';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|bmp|gif)$/.test(name)) return 'image';
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.json')) return 'json';
  if (file.type.startsWith('text/') || /\.(txt|md|csv)$/.test(name)) return 'text';
  return 'unknown';
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
