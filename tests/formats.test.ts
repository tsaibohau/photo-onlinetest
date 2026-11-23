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
