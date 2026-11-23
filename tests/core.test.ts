import { describe, expect, it } from 'vitest';
import { parseQuestionsFromText, normalizeText } from '../src/core/text-parser';
import { gradeQuiz } from '../src/core/grader';
import { buildPrompt, aiUrl } from '../src/core/prompt-builder';
import { newQuiz, parseOlt, serializeOlt, validateQuiz, OltError, type Question } from '../src/core/olt';

describe('text-parser', () => {
  it('parses single choice with inline options and answer', () => {
    const r = parseQuestionsFromText(`國二數學小考
1. 下列何者為質數？ (A) 4 (B) 9 (C) 11 (D) 15
答案：C
2、下列哪些是偶數？（複選）
(A) 2 (B) 3
(C) 4 (D) 5
答案：A,C`);
    expect(r.title).toBe('國二數學小考');
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0]).toMatchObject({ type: 'single', stem: '下列何者為質數？', options: ['4', '9', '11', '15'], answer: [2] });
    expect(r.questions[1]).toMatchObject({ type: 'multiple', options: ['2', '3', '4', '5'], answer: [0, 2] });
  });

  it('handles full-width text, answer prefix and sections', () => {
    const r = parseQuestionsFromText(`一、單選題（每題２分）
（Ｂ）１．台灣最高的山是？（Ａ）雪山（Ｂ）玉山（Ｃ）合歡山
二、是非題
（Ｘ）２．太陽從西邊升起。
三、簡答題
3. 請說明光合作用。
參考答案：植物利用光能將二氧化碳和水轉為葡萄糖。`);
    expect(r.questions.map((q) => q.type)).toEqual(['single', 'truefalse', 'short']);
    expect(r.questions[0].answer).toEqual([1]);
    expect(r.questions[0].points).toBe(2);
    expect(r.questions[1].answer).toEqual([1]);
    expect(r.questions[2].reference).toContain('光能');
  });

  it('reads an answer key table and circled options', () => {
    const r = parseQuestionsFromText(`1. 一加一？
① 1 ② 2 ③ 3
2. 二加二？
①3 ②4 ③5
答案
1.B 2.B`);
    expect(r.questions[0].options).toEqual(['1', '2', '3']);
    expect(r.questions[0].answer).toEqual([1]);
    expect(r.questions[1].answer).toEqual([1]);
  });

  it('keeps numbered (1)(2) lines as options, not new questions', () => {
    const r = parseQuestionsFromText(`1. 下列敘述何者正確？
(1) 地球是平的
(2) 地球繞太陽轉
(3) 月亮會發光
2. 請寫出你的名字。`);
    expect(r.questions).toHaveLength(2);
    expect(r.questions[0].options).toHaveLength(3);
    expect(r.questions[1].type).toBe('short');
  });

  it('removes OCR spaces between CJK characters', () => {
    expect(normalizeText('下 列 何 者 正 確')).toBe('下列何者正確');
  });

  it('warns when nothing parsed', () => {
    expect(parseQuestionsFromText('hello world').warnings.length).toBeGreaterThan(0);
  });
});

const qs: Question[] = [
  { id: 'a', type: 'single', stem: 'S', options: ['x', 'y'], answer: [1], points: 2 },
  { id: 'b', type: 'multiple', stem: 'M', options: ['p', 'q', 'r', 's'], answer: [0, 2], points: 4 },
  { id: 'c', type: 'truefalse', stem: 'T', options: ['O', 'X'], answer: [0], points: 1 },
  { id: 'd', type: 'short', stem: 'Short', options: [], reference: 'ref', points: 5 },
  { id: 'e', type: 'single', stem: 'NoKey', options: ['1', '2'], points: 1 },
];

describe('grader & prompt', () => {
  const quiz = { ...newQuiz('測驗', qs), meta: { ...newQuiz('測驗').meta, subject: '數學' } };
  it('grades', () => {
    const g = gradeQuiz(quiz, { a: [1], b: [0], c: [1], d: '答案', e: [0] });
    expect(g.results.map((r) => r.verdict)).toEqual(['correct', 'wrong', 'wrong', 'ungraded', 'ungraded']);
    expect(g.autoEarned).toBe(2);
    expect(g.autoTotal).toBe(7);
    expect(g.pendingTotal).toBe(6);
  });
  it('partial scoring', () => {
    const g = gradeQuiz({ ...quiz, meta: { ...quiz.meta, multipleScoring: 'partial' } }, { b: [0] });
    expect(g.results[1].verdict).toBe('partial');
    expect(g.results[1].earned).toBe(3);
  });
  it('builds prompt omitting correct ones in wrong mode', () => {
    const g = gradeQuiz(quiz, { a: [1], b: [0], c: [1], d: '答案' });
    const p = buildPrompt(quiz, g, { mode: 'wrong', elapsedSec: 75 });
    expect(p).toContain('【數學】');
    expect(p).not.toContain('第 1 題（');
    expect(p).toContain('題號：1');
    expect(p).toContain('第 2 題（多選');
    expect(p).toContain('參考答案：ref');
    expect(p).toContain('（未提供，請你先自行解題）');
    expect(p).toContain('1 分 15 秒');
    expect(buildPrompt(quiz, g, { mode: 'all' })).toContain('第 1 題（');
  });
  it('ai url falls back when too long', () => {
    expect(aiUrl('chatgpt', 'hi').prefilled).toBe(true);
    expect(aiUrl('chatgpt', 'x'.repeat(10000)).prefilled).toBe(false);
    expect(aiUrl('gemini', 'hi').prefilled).toBe(false);
  });
});

describe('olt format', () => {
  const quiz = newQuiz('T', qs);
  it('round trips', () => {
    expect(parseOlt(serializeOlt(quiz)).questions).toEqual(validateQuiz(quiz).questions);
  });
  it('hides answers but restores them', () => {
    const s = serializeOlt(quiz, { hideAnswers: true });
    expect(s).not.toContain('"answer"');
    expect(s).not.toContain('ref');
    expect(parseOlt(s).questions[1].answer).toEqual([0, 2]);
    expect(parseOlt(s).questions[3].reference).toBe('ref');
  });
  it('rejects bad files with friendly errors', () => {
    expect(() => parseOlt('not json')).toThrow(OltError);
    expect(() => parseOlt('{"questions":[]}')).toThrow('沒有任何題目');
    expect(() => parseOlt('{"questions":[{"type":"single","stem":"x","options":["a"]}]}')).toThrow('至少需要 2 個選項');
  });
});

import { parseAiJson } from '../src/core/ai-import';
describe('ai import', () => {
  it('accepts fenced json and bare arrays', () => {
    const q = parseAiJson('好的！\n```json\n{"meta":{"title":"X"},"questions":[{"type":"short","stem":"hi"}]}\n```');
    expect(q.meta.title).toBe('X');
    expect(parseAiJson('[{"type":"truefalse","stem":"t","answer":[1]}]').questions[0].answer).toEqual([1]);
  });
});

describe('normalize spacing', () => {
  it('keeps intentional spaces between CJK words', () => {
    expect(normalizeText('國二自然 期中練習')).toBe('國二自然 期中練習');
  });
});

import { readFileSync } from 'node:fs';
import { repairOcrQuestionStarts } from '../src/core/text-parser';
describe('real OCR output (phone photo of an earth-science quiz)', () => {
  const ocr = readFileSync(new URL('./fixtures/ocr-earth-science.txt', import.meta.url), 'utf8');
  const r = parseQuestionsFromText(ocr);
  it('recovers all 10 question numbers from mangled answer brackets', () => {
    expect(r.questions).toHaveLength(10);
    expect(r.questions[0].stem).toContain('構造學說');
    expect(r.questions[6].stem).toContain('密度');
    expect(r.questions[7].stem).toContain('褶');
  });
  it('recovers options despite OCR confusions', () => {
    const q3 = r.questions[2];
    expect(q3.options.length).toBe(5);
    expect(q3.options[1]).toContain('喜馬拉雅');
    expect(q3.options[3]).toContain('智利');
    const q7 = r.questions[6];
    expect(q7.options[0]).toContain('地函');
    expect(q7.options.length).toBeGreaterThanOrEqual(4);
  });
  it('repairs bracket junk', () => {
    expect(repairOcrQuestionStarts('1. a\nC02 地震\nCD) 3 右圖\nC0 4 地球\n(  )& 通常')).toBe(
      '1. a\n( ) 2. 地震\n( ) 3. 右圖\n( ) 4. 地球\n(  )& 通常',
    );
    expect(repairOcrQuestionStarts('7. a\n(  )& 通常')).toBe('7. a\n( ) 8. 通常');
  });
});

describe('lost option A guard', () => {
  it('does not steal the stem as option A', () => {
    const r = parseQuestionsFromText('1. 何者對？ (B) 甲 (C) 乙');
    expect(r.questions[0].stem).toBe('何者對？ (B) 甲 (C) 乙');
  });
});
