// 原始照片的遮罩（OCR 前把附圖塗白）與裁切（把附圖截下來放進題目）

/** 以 0~1 正規化的矩形（相對於照片寬高） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SourcePhoto {
  id: string;
  name: string;
  /** object URL（只存在記憶體，不會上傳） */
  url: string;
  /** 這張照片最近一次 OCR 的文字 */
  text: string;
  masks: Rect[];
  /** photo = 拍照／圖片（可遮罩重辨識）；docimage = 從 Word 等文件取出的內嵌圖片 */
  kind?: 'photo' | 'docimage';
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('照片載入失敗'));
    img.src = url;
  });
}

export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const x0 = clamp(Math.min(a.x, b.x));
  const y0 = clamp(Math.min(a.y, b.y));
  return { x: x0, y: y0, w: clamp(Math.max(a.x, b.x)) - x0, h: clamp(Math.max(a.y, b.y)) - y0 };
}

/** 回傳一張把遮罩區域塗白的畫布（給 OCR 用） */
export async function maskedCanvas(url: string, masks: Rect[]): Promise<HTMLCanvasElement> {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#fff';
  for (const r of masks) ctx.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
  return c;
}

/** 從照片裁切一塊，輸出壓縮過的 JPEG data URL（給題目附圖用） */
export async function cropToDataUrl(url: string, r: Rect, maxSide = 1200): Promise<string> {
  const img = await loadImage(url);
  const sx = r.x * img.naturalWidth;
  const sy = r.y * img.naturalHeight;
  const sw = Math.max(1, r.w * img.naturalWidth);
  const sh = Math.max(1, r.h * img.naturalHeight);
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
