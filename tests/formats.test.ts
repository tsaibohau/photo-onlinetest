import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { docText, odtText, pagesPreview, pptxText, sniffBytes } from '../src/core/formats';
import { parseQuestionsFromText } from '../src/core/text-parser';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/docs/${n}`, import.meta.url)));

describe('format sniffing (by content, not extension)', () => {
  it('detects common types', async () => {
    expect((await sniffBytes(fx('quiz.doc'), 'x.bin')).kind).toBe('doc');
    expect((await sniffBytes(fx('quiz.odt'))).kind).toBe('odt');
    expect((await sniffBytes(strToU8('%PDF-1.7 ...'))).kind).toBe('pdf');
    expect((await sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({ kind: 'image' });
    expect((await sniffBytes(strToU8('{"format":"olt","questions":[]}'), 'quiz.txt')).kind).toBe('olt');
    expect((await sniffBytes(strToU8('1. 題目 (A) 甲 (B) 乙'))).kind).toBe('text');
    const heic = new Uint8Array(16);
    heic.set(strToU8('ftypheic'), 4);
    expect((await sniffBytes(heic)).kind).toBe('heic');
  });
});

describe('legacy Word .doc', () => {
  it('extracts Chinese text including table cells', async () => {
    const t = await docText(fx('quiz.doc'));
    expect(t).toContain('高一第一段 地球科學');
    expect(t).toContain('地震波波速快慢順序');
    expect(t).toContain('地殼最外層稱為');
    const r = parseQuestionsFromText(t);
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0].answer).toEqual([3]);
    expect(r.questions[1].options).toEqual(['臺灣', '喜馬拉雅山', '美國舊金山', '日本']);
    expect(r.questions[2].options).toHaveLength(4);
  });
});

describe('zip-based documents', () => {
  it('odt', async () => {
    const r = parseQuestionsFromText(await odtText(fx('quiz.odt')));
    expect(r.questions.length).toBeGreaterThanOrEqual(2);
  });
  it('pptx', async () => {
    const slide = (txt: string[]) =>
      strToU8(`<p:sld><a:p><a:r><a:t>${txt[0]}</a:t></a:r><a:r><a:t>${txt[1]}</a:t></a:r></a:p><a:p><a:r><a:t>${txt[2]}</a:t></a:r></a:p></p:sld>`);
    const z = zipSync({
      '[Content_Types].xml': strToU8('<x/>'),
      'ppt/slides/slide2.xml': slide(['2. 第二題', '？', '(A) 丙 (B) 丁']),
      'ppt/slides/slide1.xml': slide(['1. 第一題 ', 'A&amp;B？', '(A) 甲 (B) 乙']),
    });
    expect((await sniffBytes(z)).kind).toBe('pptx');
    const t = await pptxText(z);
    expect(t.indexOf('第一題')).toBeLessThan(t.indexOf('第二題'));
    expect(t).toContain('A&B？');
    expect(parseQuestionsFromText(t).questions).toHaveLength(2);
  });
  it('pages preview pdf', async () => {
    const z = zipSync({ 'Index/Document.iwa': new Uint8Array([1]), 'QuickLook/Preview.pdf': strToU8('%PDF-1.4') });
    expect((await sniffBytes(z)).kind).toBe('pages');
    expect((await pagesPreview(z)).pdf).toBeDefined();
  });
});

import { carveImages, documentImages } from '../src/core/formats';
describe('embedded images', () => {
  it('carves png/jpeg and skips tiny ones', () => {
    const png = new Uint8Array(3000);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0], 2990);
    const jpg = new Uint8Array(2500);
    jpg.set([0xff, 0xd8, 0xff], 0);
    jpg.set([0xff, 0xd9], 2498);
    const tiny = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 0xff, 0xd9]);
    const blob = new Uint8Array([1, 2, ...png, 9, ...tiny, ...jpg, 7]);
    expect(carveImages(blob).map((i) => [i.mime, i.bytes.length])).toEqual([['image/png', 2998], ['image/jpeg', 2500]]);
  });
  it('docx media in document order', async () => {
    const big = (b: number) => new Uint8Array(3000).fill(b);
    const z = zipSync({ 'word/document.xml': strToU8('<w/>'), 'word/media/image10.png': big(2), 'word/media/image2.jpeg': big(1) });
    const imgs = await documentImages('docx', z);
    expect(imgs.map((i) => i.bytes[0])).toEqual([1, 2]);
  });
});

import { tableBlock } from '../src/core/formats';
import { autoNumberParagraphs } from '../src/core/text-parser';
describe('embedded Word tables', () => {
  it('renders rows and merges split cells', () => {
    const raw = '母核種\x07子核種\x07半衰期\x07\x07鈾\x07235\x07（235U）\x07鉛\x07207\x07（207Pb）\x07約\x077億\x07年\x07\x07\r';
    expect(tableBlock(raw).split('\uE001')).toEqual(['【附表】', '母核種｜子核種｜半衰期', '鈾235（235U）｜鉛207（207Pb）｜約7億年']);
  });
  it('attaches a table to the previous question, or to the following group', () => {
    const T = tableBlock('甲\x07乙\x07\x071\x072\x07\x07');
    const text = `單選題：(每題2分)
第一題？(A)a (B)b
${T}
第二題？(A)c (B)d

${T}
附表為資料，回答下列問題
哪個最大？(A)甲 (B)乙
哪個最小？(A)甲 (B)乙`;
    const r = parseQuestionsFromText(text);
    expect(r.questions).toHaveLength(4);
    expect(r.questions[0].stem).toBe('第一題？\n【附表】\n甲｜乙\n1｜2');
    expect(r.questions[0].options).toEqual(['a', 'b']);
    expect(r.questions[1].stem).toBe('第二題？');
    expect(r.questions[2].stem).toContain('【題組】附表為資料');
    expect(r.questions[3].stem).toContain('【附表】\n甲｜乙');
    expect(autoNumberParagraphs(text)).toContain('4. 【題組】');
  });
});
