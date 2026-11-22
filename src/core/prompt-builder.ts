import { hasAnswer, optionLabel, TYPE_LABEL, type Question, type Quiz } from './olt';
import type { GradeResult, QuestionResult, Response } from './grader';

export type PromptMode = 'wrong' | 'all' | 'weakness';

export const PROMPT_MODE_LABEL: Record<PromptMode, string> = {
  wrong: '重點解析錯題',
  all: '全部題目詳解',
  weakness: '只要弱點分析',
};

export interface PromptOptions {
  mode: PromptMode;
  elapsedSec?: number;
}

function fmtChoice(q: Question, idx: number[]): string {
  return idx.map((i) => `(${optionLabel(q, i)})`).join('');
}

function fmtResponse(q: Question, r: Response | undefined): string {
  if (r === undefined || (typeof r === 'string' ? !r.trim() : r.length === 0)) return '（未作答）';
  if (typeof r === 'string') return r.trim();
  return fmtChoice(q, r);
}

const VERDICT_TEXT = {
  correct: '✅ 正確',
  partial: '🟡 部分正確',
  wrong: '❌ 錯誤',
  unanswered: '⚪ 未作答',
  ungraded: '❓ 待你批改',
} as const;

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function block(r: QuestionResult, withImageNote: boolean): string {
  const q = r.question;
  const lines: string[] = [];
  lines.push(`第 ${r.index + 1} 題（${TYPE_LABEL[q.type]}，${q.points} 分）${q.stem.trim()}`);
  if (withImageNote && q.image) lines.push('  ［本題附圖，我會另外上傳圖片］');
  if (q.type === 'single' || q.type === 'multiple') {
    lines.push(`  選項：${q.options.map((o, i) => `(${optionLabel(q, i)}) ${o.trim()}`).join('　')}`);
  }
  lines.push(`  我的答案：${fmtResponse(q, r.response)}`);
  if (hasAnswer(q)) lines.push(`  正確答案：${fmtChoice(q, q.answer!)}`);
  else if (q.type === 'short' && q.reference) lines.push(`  參考答案：${q.reference.trim()}`);
  else lines.push('  正確答案：（未提供，請你先自行解題）');
  if (q.explanation) lines.push(`  原有解析：${q.explanation.trim()}`);
  lines.push(`  結果：${VERDICT_TEXT[r.verdict]}`);
  return lines.join('\n');
}

export function buildPrompt(quiz: Quiz, grade: GradeResult, opts: PromptOptions): string {
  const subject = quiz.meta.subject?.trim();
  const tutor = subject ? `【${subject}】` : '這個科目的';
  const anyKey = grade.results.some((r) => hasAnswer(r.question));
  const anyUngraded = grade.results.some((r) => r.verdict === 'ungraded' || !hasAnswer(r.question));
  const hasImage = grade.results.some((r) => r.question.image);

  const tasks: string[] = [];
  if (opts.mode === 'weakness') {
    tasks.push('根據下面的作答紀錄，判斷我掌握得好與不好的觀念（不需要逐題詳解）');
    if (anyUngraded) tasks.push('沒有標準答案的題目請先自行判斷我答得對不對');
    tasks.push('列出我最需要加強的 3 個觀念，並說明為什麼');
    tasks.push('為每個弱點推薦具體的練習方法，並各出 1 道類似的練習題（先不要給答案）');
  } else {
    tasks.push(opts.mode === 'all' ? '逐題詳解每一題，包括我答對的題目' : '逐題批改，重點詳解我答錯、部分正確與未作答的題目');
    if (anyUngraded) tasks.push('「正確答案未提供」或「待你批改」的題目，請先自行解題，再判斷我的答案是否正確、給出分數');
    if (grade.results.some((r) => r.question.type === 'short'))
      tasks.push('簡答題請依參考答案（若有）或專業標準評分，並具體指出可以怎麼寫得更好');
    tasks.push('針對錯題說明正確觀念，並推測我可能的迷思或錯誤原因');
    tasks.push('最後總結我的弱點，推薦 3 個加強方向與練習方法');
  }
  if (anyKey) tasks.push('如果你認為題目提供的「正確答案」本身有誤，請直接指出');

  let included = grade.results;
  if (opts.mode === 'wrong' && anyKey) {
    included = grade.results.filter((r) => r.verdict !== 'correct');
  }
  const correctOmitted = grade.results.filter((r) => !included.includes(r));

  const out: string[] = [];
  out.push(`你是一位耐心又專業的${tutor}家教。以下是我剛完成的測驗「${quiz.meta.title}」的作答紀錄，請用繁體中文幫我：`);
  tasks.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  out.push('');
  out.push('【作答紀錄】');
  if (included.length === 0) out.push('（全部答對！請改為幫我出 3 題同範圍、難度更高的挑戰題。）');
  else included.forEach((r) => out.push(block(r, hasImage), ''));
  if (correctOmitted.length > 0) {
    out.push(`（以下題目我答對了，題號：${correctOmitted.map((r) => r.index + 1).join('、')}，不需詳解）`);
    out.push('');
  }
  out.push('【統計】');
  const stats: string[] = [`共 ${grade.results.length} 題，作答 ${grade.answeredCount} 題`];
  if (grade.autoTotal > 0) stats.push(`可自動計分部分得分 ${grade.autoEarned} / ${grade.autoTotal}`);
  if (grade.pendingTotal > 0) stats.push(`待你評分的題目共 ${grade.pendingTotal} 分`);
  if (opts.elapsedSec !== undefined) stats.push(`花費時間 ${fmtDuration(opts.elapsedSec)}`);
  out.push(stats.join('，') + '。');
  if (hasImage) {
    out.push('');
    out.push('※ 部分題目有附圖，我會把圖片一起上傳給你，請對照題號閱讀。');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 依 AI 平台產生「直接開啟」網址；過長時回傳 null（改用複製貼上） */
export type AiTarget = 'chatgpt' | 'claude' | 'gemini';
export const AI_TARGETS: { id: AiTarget; name: string; base: string; prefill: boolean }[] = [
  { id: 'chatgpt', name: 'ChatGPT', base: 'https://chatgpt.com/', prefill: true },
  { id: 'claude', name: 'Claude', base: 'https://claude.ai/new', prefill: true },
  { id: 'gemini', name: 'Gemini', base: 'https://gemini.google.com/app', prefill: false },
];
export const MAX_URL_LEN = 7000;

export function aiUrl(target: AiTarget, prompt: string): { url: string; prefilled: boolean } {
  const t = AI_TARGETS.find((x) => x.id === target)!;
  if (t.prefill) {
    const url = `${t.base}?q=${encodeURIComponent(prompt)}`;
    if (url.length <= MAX_URL_LEN) return { url, prefilled: true };
  }
  return { url: t.base, prefilled: false };
}
