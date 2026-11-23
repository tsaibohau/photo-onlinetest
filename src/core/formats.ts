// 依「檔案內容」判斷格式（不靠副檔名；iPhone 傳來的檔名常常不可靠），並從各種文件取出文字。
// 純邏輯、無 DOM：可在 Node 測試。

export type DocKind =
  | 'olt'
  | 'json'
  | 'image'
  | 'heic'
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'pptx'
  | 'odt'
  | 'pages'
  | 'text'
  | 'unsupported';

export interface Sniffed {
  kind: DocKind;
  /** 給使用者看的格式名稱 */
  label: string;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export async function sniffBytes(bytes: Uint8Array, name = ''): Promise<Sniffed> {
  const lower = name.toLowerCase();
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: 'pdf', label: 'PDF' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || ascii(bytes, 0, 3) === 'GIF')
    return { kind: 'image', label: '圖片' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { kind: 'image', label: '圖片' };
  if (ascii(bytes, 0, 2) === 'BM') return { kind: 'image', label: '圖片' };
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (/heic|heix|hevc|mif1|msf1|heim|heis/.test(brand)) return { kind: 'heic', label: 'HEIC 照片' };
    if (/avif/.test(brand)) return { kind: 'image', label: '圖片' };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const CFB = await import('cfb');
    const c = CFB.read(bytes, { type: 'array' });
    if (rootFind(CFB, c, 'WordDocument')) return { kind: 'doc', label: '舊版 Word（.doc）' };
    if (CFB.find(c, 'PowerPoint Document')) return { kind: 'unsupported', label: '舊版 PowerPoint（.ppt）' };
    if (CFB.find(c, 'Workbook') || CFB.find(c, 'Book')) return { kind: 'unsupported', label: '舊版 Excel（.xls）' };
    return { kind: 'unsupported', label: 'Office 舊格式' };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = listZip(bytes);
    if (entries.includes('word/document.xml')) return { kind: 'docx', label: 'Word（.docx）' };
    if (entries.some((e) => e.startsWith('ppt/slides/'))) return { kind: 'pptx', label: 'PowerPoint（.pptx）' };
    if (entries.includes('content.xml') && entries.includes('mimetype')) return { kind: 'odt', label: 'OpenDocument' };
    if (entries.some((e) => /^(Index\/|QuickLook\/|preview)/i.test(e))) return { kind: 'pages', label: 'Pages' };
    if (entries.includes('xl/workbook.xml')) return { kind: 'unsupported', label: 'Excel（.xlsx）' };
    return { kind: 'unsupported', label: '壓縮檔' };
  }
  // 文字類：嘗試 UTF-8 解碼
  const head = bytes.subarray(0, 4096);
  if (!head.some((b) => b === 0)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^﻿/, '').trimStart();
    if (text.startsWith('{') || text.startsWith('[')) {
      if (/"format"\s*:\s*"olt"/.test(text) || lower.endsWith('.olt')) return { kind: 'olt', label: 'OLT 測驗檔' };
      return { kind: 'json', label: 'JSON' };
    }
    return { kind: 'text', label: '文字檔' };
  }
  return { kind: 'unsupported', label: name.split('.').pop()?.toUpperCase() || '未知格式' };
}

/** 讀 zip 的中央目錄取得檔名清單（不解壓） */
export function listZip(b: Uint8Array): string[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const n = dv.getUint16(p + 28, true);
    const m = dv.getUint16(p + 30, true);
    const k = dv.getUint16(p + 32, true);
    out.push(dec.decode(b.subarray(p + 46, p + 46 + n)));
    p += 46 + n + m + k;
  }
  return out;
}

async function unzipSome(bytes: Uint8Array, want: (name: string) => boolean): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  return unzipSync(bytes, { filter: (f) => want(f.name) });
}

const decodeXmlEntities = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** PowerPoint .pptx：依投影片順序取出每段文字 */
export async function pptxText(bytes: Uint8Array): Promise<string> {
  const files = await unzipSome(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const dec = new TextDecoder();
  return Object.keys(files)
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((n) =>
      dec
        .decode(files[n])
        .split(/<\/a:p>/)
        .map((p) => decodeXmlEntities([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('')))
        .filter((l) => l.trim())
        .join('\n'),
    )
    .join('\n');
}

/** OpenDocument（.odt）：content.xml 的段落 */
export async function odtText(bytes: Uint8Array): Promise<string> {
  const files = await unzipSome(bytes, (n) => n === 'content.xml');
  const xml = new TextDecoder().decode(files['content.xml'] ?? new Uint8Array());
  return decodeXmlEntities(
    xml
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)))
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<\/text:(p|h)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Pages：取出內附的預覽 PDF 或預覽圖 */
export async function pagesPreview(bytes: Uint8Array): Promise<{ pdf?: Uint8Array; image?: Uint8Array }> {
  const files = await unzipSome(bytes, (n) => /(^|\/)(preview|Preview|Thumbnail)[^/]*\.(pdf|jpe?g|png)$/i.test(n));
  const names = Object.keys(files);
  const pdf = names.find((n) => /\.pdf$/i.test(n));
  if (pdf) return { pdf: files[pdf] };
  const img = names.sort((a, b) => files[b].length - files[a].length)[0];
  return img ? { image: files[img] } : {};
}

/**
 * 舊版 Word（Word 97-2003 .doc）文字擷取：讀 FIB → Clx 片段表 → 逐段解碼（UTF-16LE 或 cp1252）。
 * 移除欄位代碼、物件佔位字元；表格儲存格以 tab 分隔。
 */
export async function docText(bytes: Uint8Array): Promise<string> {
  const CFB = await import('cfb');
  const c = CFB.read(bytes, { type: 'array' });
  const wd = rootFind(CFB, c, 'WordDocument');
  if (!wd) throw new Error('不是 Word 文件');
  const w = toU8(wd.content);
  const flags = new DataView(w.buffer, w.byteOffset, w.byteLength).getUint16(0x0a, true);
  if (flags & 0x0100) throw new Error('這份 Word 檔有密碼保護，請先解除密碼。');
  const table = rootFind(CFB, c, flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('Word 檔結構不完整');
  const { text, embeds } = stripFields(rawDocText(w, toU8(table.content)));

  // 內嵌的 Word 物件（多半是表格）：依 ObjectPool 編號排序，對應到文中的 EMBED 欄位順序
  const objects = c.FullPaths.map((p, i) => ({ p, i }))
    .filter(({ p }) => /\/ObjectPool\/_(\d+)\/WordDocument$/.test(p))
    .sort((a, b) => Number(a.p.match(/_(\d+)\//)![1]) - Number(b.p.match(/_(\d+)\//)![1]))
    .map(({ p, i }) => {
      try {
        const ew = toU8(c.FileIndex[i].content);
        const ef = new DataView(ew.buffer, ew.byteOffset, ew.byteLength).getUint16(0x0a, true);
        const ti = c.FullPaths.indexOf(p.replace(/WordDocument$/, ef & 0x0200 ? '1Table' : '0Table'));
        return ti >= 0 ? tableBlock(stripFields(rawDocText(ew, toU8(c.FileIndex[ti].content))).text) : '';
      } catch {
        return '';
      }
    });
  let out = text;
  let k = 0;
  out = out.replace(/\uE000/g, () => {
    const block = embeds[k] && objects[k] ? objects[k] : ''; // 物件本身就在獨立段落
    k++;
    return block;
  });
  return cleanWordText(out);
}

/** 讀 FIB → Clx 片段表 → 逐段解碼（UTF-16LE 或 cp1252），回傳含 Word 控制字元的原始文字 */
function rawDocText(w: Uint8Array, t: Uint8Array): string {
  const dw = new DataView(w.buffer, w.byteOffset, w.byteLength);
  const dt = new DataView(t.buffer, t.byteOffset, t.byteLength);
  let p = 32;
  const csw = dw.getUint16(p, true);
  p += 2 + csw * 2;
  const cslw = dw.getUint16(p, true);
  p += 2 + cslw * 4;
  p += 2; // cbRgFcLcb
  const fcClx = dw.getUint32(p + 33 * 8, true);
  const lcbClx = dw.getUint32(p + 33 * 8 + 4, true);
  let q = fcClx;
  const end = fcClx + lcbClx;
  while (q < end && t[q] === 0x01) q += 3 + dt.getUint16(q + 1, true); // 跳過 Prc
  if (t[q] !== 0x02) throw new Error('無法讀取 Word 文字（片段表遺失）');
  const lcb = dt.getUint32(q + 1, true);
  const plc = q + 5;
  const n = (lcb - 4) / 12;
  const cp = (i: number) => dt.getUint32(plc + i * 4, true);
  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let text = '';
  for (let i = 0; i < n; i++) {
    const len = cp(i + 1) - cp(i);
    const fcRaw = dt.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const fc = fcRaw & 0x3fffffff;
    text += fcRaw & 0x40000000 ? cp1252.decode(w.subarray(fc / 2, fc / 2 + len)) : utf16.decode(w.subarray(fc, fc + len * 2));
  }
  return text;
}

/** 欄位代碼：\x13 指令 \x14 結果 \x15 → 只保留結果；EMBED Word 物件換成佔位字元 \uE000 */
function stripFields(text: string): { text: string; embeds: boolean[] } {
  let out = '';
  const stack: { code: string; inCode: boolean }[] = [];
  const embeds: boolean[] = [];
  for (const ch of text) {
    const top = stack[stack.length - 1];
    if (ch === '\x13') stack.push({ code: '', inCode: true });
    else if (ch === '\x14' && top) top.inCode = false;
    else if (ch === '\x15' && top) {
      stack.pop();
      if (/^\s*EMBED\s+Word\.Document/i.test(top.code)) {
        embeds.push(true);
        out += '\uE000';
      }
    } else if (top?.inCode) top.code += ch;
    else out += ch;
  }
  return { text: out, embeds };
}

function cleanWordText(s: string): string {
  return s
    .replace(/\x07\x07/g, '\n') // 表格：儲存格結尾 + 列結尾
    .replace(/\x07/g, '\t')
    .replace(/[\r\x0b\x0c]/g, '\n')
    .replace(/[\x00-\x08\x0e-\x1f]/g, '')
    .replace(/\t\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Word 表格文字 → 一行「【附表】」區塊（列之間用 U+E001（私用字元，不會被當成換行） 分隔，解析題目時才還原成換行，
 * 避免被當成新的段落）。資料列的儲存格數是表頭的整數倍時（一格被拆成多格），自動合併。
 */
export function tableBlock(raw: string): string {
  const rows = raw
    .split(/\x07\x07/)
    .map((r) => r.replace(/[\r\n]+/g, ' ').split('\x07').map((c) => c.replace(/[\x00-\x1f]/g, '').replace(/\s+/g, '').trim()))
    .filter((r) => r.some((c) => c));
  if (!rows.length) return '';
  const cols = rows[0].filter((c) => c).length || rows[0].length;
  const lines = rows.map((r, idx) => {
    let cells = r.filter((c, i) => c || i < r.length - 1);
    if (idx > 0 && cols > 0 && cells.length > cols && cells.length % cols === 0) {
      const k = cells.length / cols;
      cells = Array.from({ length: cols }, (_, j) => cells.slice(j * k, j * k + k).join(''));
    }
    return cells.join('｜');
  });
  return `【附表】\uE001${lines.join('\uE001')}`;
}

/** 只找最上層的串流（Word 檔的 ObjectPool 裡常內嵌其他文件，也有同名的 WordDocument / 1Table） */
type Cfb = typeof import('cfb');
function rootFind(CFB: Cfb, c: ReturnType<Cfb['read']>, name: string) {
  const i = c.FullPaths.findIndex((p) => p.split('/').filter(Boolean).length === 2 && p.endsWith(`/${name}`));
  return i >= 0 ? c.FileIndex[i] : CFB.find(c, name);
}

function toU8(b: unknown): Uint8Array {
  if (b instanceof Uint8Array) return b;
  if (Array.isArray(b)) return Uint8Array.from(b as number[]);
  return new Uint8Array(b as ArrayBuffer);
}

export interface EmbeddedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
}

const MIN_IMAGE_BYTES = 2048; // 太小的多半是項目符號、線條

/** 從位元組中切出所有 PNG / JPEG（舊版 .doc 的圖片存在 Data 串流裡） */
export function carveImages(d: Uint8Array): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  const find = (sig: number[], from: number) => {
    outer: for (let i = from; i <= d.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) if (d[i + j] !== sig[j]) continue outer;
      return i;
    }
    return -1;
  };
  for (let k = 0; k < d.length - 8; k++) {
    if (d[k] === 0x89 && d[k + 1] === 0x50 && d[k + 2] === 0x4e && d[k + 3] === 0x47) {
      const e = find([0x49, 0x45, 0x4e, 0x44], k);
      if (e < 0) break;
      const end = e + 8;
      if (end - k >= MIN_IMAGE_BYTES) out.push({ bytes: d.slice(k, end), mime: 'image/png' });
      k = end - 1;
    } else if (d[k] === 0xff && d[k + 1] === 0xd8 && d[k + 2] === 0xff) {
      const e = find([0xff, 0xd9], k + 3);
      if (e < 0) break;
      const end = e + 2;
      if (end - k >= MIN_IMAGE_BYTES) out.push({ bytes: d.slice(k, end), mime: 'image/jpeg' });
      k = end - 1;
    }
  }
  return out;
}

/** 文件內嵌的圖片（依文件順序），可在編輯器中當作附圖 */
export async function documentImages(kind: DocKind, bytes: Uint8Array): Promise<EmbeddedImage[]> {
  if (kind === 'doc') {
    const CFB = await import('cfb');
    const c = CFB.read(bytes, { type: 'array' });
    const data = rootFind(CFB, c, 'Data');
    return data ? carveImages(toU8(data.content)) : [];
  }
  if (kind === 'docx' || kind === 'pptx' || kind === 'odt') {
    const files = await unzipSome(bytes, (n) => /^(word\/media|ppt\/media|Pictures)\/.+\.(png|jpe?g|gif)$/i.test(n));
    return Object.keys(files)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .filter((n) => files[n].length >= MIN_IMAGE_BYTES)
      .map((n) => ({
        bytes: files[n],
        mime: /\.png$/i.test(n) ? 'image/png' : /\.gif$/i.test(n) ? 'image/gif' : 'image/jpeg',
      }));
  }
  return [];
}

export const UNSUPPORTED_HELP =
  '請把檔案轉成 PDF 再上傳：iPhone 可以打開檔案 → 分享 → 列印 → 用兩指放大預覽 → 再按分享 → 「儲存到檔案」；電腦上用「另存新檔 → PDF」。也可以直接拍照或截圖上傳。';
