import { hasAnswer, type Question, type Quiz } from './olt';

/** 作答：選擇類為選項索引陣列，簡答為字串 */
export type Response = number[] | string;
export type Responses = Record<string, Response | undefined>;

export type Verdict = 'correct' | 'partial' | 'wrong' | 'unanswered' | 'ungraded';

export interface QuestionResult {
  question: Question;
  index: number;
  response: Response | undefined;
  verdict: Verdict;
  earned: number;
}

export interface GradeResult {
  results: QuestionResult[];
  /** 可自動計分的題目總分與得分 */
  autoTotal: number;
  autoEarned: number;
  /** 交由 AI 評分的題目（簡答、或無標準答案）總分 */
  pendingTotal: number;
  answeredCount: number;
  correctCount: number;
  wrongCount: number;
}

export function isAnswered(r: Response | undefined): boolean {
  if (r === undefined) return false;
  return typeof r === 'string' ? r.trim().length > 0 : r.length > 0;
}

export function gradeQuestion(q: Question, r: Response | undefined, scoring: 'all' | 'partial' = 'all'): {
  verdict: Verdict;
  earned: number;
} {
  const answered = isAnswered(r);
  if (!hasAnswer(q)) return { verdict: answered ? 'ungraded' : 'unanswered', earned: 0 };
  if (!answered || typeof r === 'string') return { verdict: 'unanswered', earned: 0 };
  const key = new Set(q.answer);
  const picked = new Set(r);
  if (q.type !== 'multiple') {
    const ok = picked.size === 1 && key.has([...picked][0]);
    return { verdict: ok ? 'correct' : 'wrong', earned: ok ? q.points : 0 };
  }
  const exact = key.size === picked.size && [...key].every((k) => picked.has(k));
  if (exact) return { verdict: 'correct', earned: q.points };
  if (scoring === 'partial') {
    // 每個選項視為一個判斷：答對的判斷數 / 選項數
    const n = q.options.length;
    let right = 0;
    for (let i = 0; i < n; i++) if (key.has(i) === picked.has(i)) right++;
    const earned = Math.round(((q.points * right) / n) * 100) / 100;
    return { verdict: earned > 0 ? 'partial' : 'wrong', earned };
  }
  return { verdict: 'wrong', earned: 0 };
}

export function gradeQuiz(quiz: Quiz, responses: Responses, order?: string[]): GradeResult {
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const qs = order ? order.map((id) => byId.get(id)!).filter(Boolean) : quiz.questions;
  const scoring = quiz.meta.multipleScoring ?? 'all';
  const g: GradeResult = {
    results: [],
    autoTotal: 0,
    autoEarned: 0,
    pendingTotal: 0,
    answeredCount: 0,
    correctCount: 0,
    wrongCount: 0,
  };
  qs.forEach((q, index) => {
    const response = responses[q.id];
    const { verdict, earned } = gradeQuestion(q, response, scoring);
    if (hasAnswer(q)) {
      g.autoTotal += q.points;
      g.autoEarned += earned;
    } else g.pendingTotal += q.points;
    if (isAnswered(response)) g.answeredCount++;
    if (verdict === 'correct') g.correctCount++;
    if (verdict === 'wrong' || verdict === 'partial') g.wrongCount++;
    g.results.push({ question: q, index, response, verdict, earned });
  });
  g.autoEarned = Math.round(g.autoEarned * 100) / 100;
  return g;
}
