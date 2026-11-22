// .olt 檔案格式：型別定義、驗證、序列化
export const OLT_FORMAT = 'olt';
export const OLT_VERSION = 1;

export type QuestionType = 'single' | 'multiple' | 'truefalse' | 'short';

export const TYPE_LABEL: Record<QuestionType, string> = {
  single: '單選',
  multiple: '多選',
  truefalse: '是非',
  short: '簡答',
};

export interface Question {
  id: string;
  type: QuestionType;
  stem: string;
  /** 選項（single / multiple；truefalse 固定為 ["O","X"]） */
  options: string[];
  /** 正解的選項索引；undefined / 空陣列 = 沒有標準答案 */
  answer?: number[];
  /** 簡答題參考答案 */
  reference?: string;
  points: number;
  explanation?: string;
  /** data URL */
  image?: string;
}

export interface QuizMeta {
  title: string;
  subject?: string;
  createdAt: string;
  timeLimitMin?: number;
  shuffle?: boolean;
  showAnswerAfterSubmit?: boolean;
  /** 多選題計分方式：all = 全對才給分；partial = 依比例給分 */
  multipleScoring?: 'all' | 'partial';
}

export interface Quiz {
  format: typeof OLT_FORMAT;
  version: number;
  meta: QuizMeta;
  questions: Question[];
}

/** 隱藏答案的磁碟格式：answer / reference 移到 sealed 欄位 */
interface SealedQuiz extends Omit<Quiz, 'questions'> {
  sealed: string;
  questions: Omit<Question, 'answer' | 'reference' | 'explanation'>[];
}

export const TRUEFALSE_OPTIONS = ['O（對）', 'X（錯）'];

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `q${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function blankQuestion(type: QuestionType = 'single'): Question {
  return {
    id: newId(),
    type,
    stem: '',
    options: type === 'truefalse' ? [...TRUEFALSE_OPTIONS] : type === 'short' ? [] : ['', '', '', ''],
    answer: [],
    points: 1,
  };
}

export function newQuiz(title = '未命名測驗', questions: Question[] = []): Quiz {
  return {
    format: OLT_FORMAT,
    version: OLT_VERSION,
    meta: { title, createdAt: new Date().toISOString(), showAnswerAfterSubmit: true, multipleScoring: 'all' },
    questions,
  };
}

export class OltError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TYPES: QuestionType[] = ['single', 'multiple', 'truefalse', 'short'];

/** 驗證並正規化一個（可能來自外部的）物件成 Quiz。錯誤時丟出 OltError（中文訊息）。 */
export function validateQuiz(raw: unknown): Quiz {
  if (!isObj(raw)) throw new OltError('檔案內容不是有效的測驗資料。');
  if (typeof raw.sealed === 'string') raw = unseal(raw as unknown as SealedQuiz);
  const r = raw as Record<string, unknown>;
  if (r.format !== undefined && r.format !== OLT_FORMAT) throw new OltError('這不是 .olt 測驗檔。');
  const version = typeof r.version === 'number' ? r.version : OLT_VERSION;
  if (version > OLT_VERSION) throw new OltError(`此檔案版本 (v${version}) 比本程式新，請更新網頁後再開啟。`);
  const metaRaw = isObj(r.meta) ? r.meta : {};
  const meta: QuizMeta = {
    title: typeof metaRaw.title === 'string' && metaRaw.title.trim() ? metaRaw.title : '未命名測驗',
    subject: typeof metaRaw.subject === 'string' ? metaRaw.subject : undefined,
    createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : new Date().toISOString(),
    timeLimitMin: typeof metaRaw.timeLimitMin === 'number' && metaRaw.timeLimitMin > 0 ? metaRaw.timeLimitMin : undefined,
    shuffle: metaRaw.shuffle === true,
    showAnswerAfterSubmit: metaRaw.showAnswerAfterSubmit !== false,
    multipleScoring: metaRaw.multipleScoring === 'partial' ? 'partial' : 'all',
  };
  if (!Array.isArray(r.questions)) throw new OltError('檔案中找不到題目。');
  const seen = new Set<string>();
  const questions = r.questions.map((q, i): Question => {
    const n = i + 1;
    if (!isObj(q)) throw new OltError(`第 ${n} 題格式錯誤。`);
    const type = TYPES.includes(q.type as QuestionType) ? (q.type as QuestionType) : undefined;
    if (!type) throw new OltError(`第 ${n} 題的題型「${String(q.type)}」無法辨識。`);
    if (typeof q.stem !== 'string') throw new OltError(`第 ${n} 題缺少題目內容。`);
    let options = Array.isArray(q.options) ? q.options.map((o) => String(o)) : [];
    if (type === 'truefalse') options = [...TRUEFALSE_OPTIONS];
    if (type === 'short') options = [];
    if ((type === 'single' || type === 'multiple') && options.length < 2)
      throw new OltError(`第 ${n} 題（${TYPE_LABEL[type]}）至少需要 2 個選項。`);
    let answer: number[] | undefined;
    if (Array.isArray(q.answer)) {
      answer = [...new Set(q.answer.filter((a): a is number => Number.isInteger(a) && a >= 0 && a < options.length))].sort(
        (a, b) => a - b,
      );
      if (type !== 'multiple' && answer.length > 1) answer = answer.slice(0, 1);
    }
    let id = typeof q.id === 'string' && q.id ? q.id : `q${n}`;
    if (seen.has(id)) id = `${id}_${n}`;
    seen.add(id);
    return {
      id,
      type,
      stem: q.stem,
      options,
      answer,
      reference: typeof q.reference === 'string' && q.reference ? q.reference : undefined,
      points: typeof q.points === 'number' && q.points >= 0 ? q.points : 1,
      explanation: typeof q.explanation === 'string' && q.explanation ? q.explanation : undefined,
      image: typeof q.image === 'string' && q.image.startsWith('data:image/') ? q.image : undefined,
    };
  });
  if (questions.length === 0) throw new OltError('這份測驗沒有任何題目。');
  return { format: OLT_FORMAT, version: OLT_VERSION, meta, questions };
}

export function parseOlt(text: string): Quiz {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new OltError('檔案損毀或不是 .olt 格式（JSON 解析失敗）。');
  }
  return validateQuiz(raw);
}

// ---- 「隱藏答案」：防君子等級的混淆，避免用記事本直接看到答案 ----
const KEY = 'olt-v1-practice-only';

function xorString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const k = new TextEncoder().encode(KEY);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= k[i % k.length];
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function unxorString(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const k = new TextEncoder().encode(KEY);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= k[i % k.length];
  return new TextDecoder().decode(bytes);
}

function unseal(s: SealedQuiz): Quiz {
  let secrets: Record<string, Pick<Question, 'answer' | 'reference' | 'explanation'>>;
  try {
    secrets = JSON.parse(unxorString(s.sealed));
  } catch {
    throw new OltError('答案區塊損毀，無法讀取。');
  }
  return {
    ...s,
    questions: s.questions.map((q) => ({ ...q, ...(secrets[q.id] ?? {}) })) as Question[],
  } as Quiz;
}

export function serializeOlt(quiz: Quiz, opts: { hideAnswers?: boolean; pretty?: boolean } = {}): string {
  const clean = validateQuiz(JSON.parse(JSON.stringify(quiz)));
  if (!opts.hideAnswers) return JSON.stringify(clean, null, opts.pretty ? 2 : 0);
  const secrets: Record<string, unknown> = {};
  const questions = clean.questions.map(({ answer, reference, explanation, ...rest }) => {
    secrets[rest.id] = { answer, reference, explanation };
    return rest;
  });
  const sealed: SealedQuiz = { ...clean, questions, sealed: xorString(JSON.stringify(secrets)) };
  return JSON.stringify(sealed, null, opts.pretty ? 2 : 0);
}

export function hasAnswer(q: Question): boolean {
  return q.type !== 'short' && !!q.answer && q.answer.length > 0;
}

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function optionLabel(q: Question, i: number): string {
  if (q.type === 'truefalse') return i === 0 ? 'O' : 'X';
  return LETTERS[i] ?? String(i + 1);
}
