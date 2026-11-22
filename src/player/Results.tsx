import { useMemo, useState } from 'preact/hooks';
import { hasAnswer, optionLabel, TYPE_LABEL, type Question, type Quiz } from '../core/olt';
import { gradeQuiz, type Response, type Responses, type Verdict } from '../core/grader';
import { AI_TARGETS, aiUrl, buildPrompt, PROMPT_MODE_LABEL, type AiTarget, type PromptMode } from '../core/prompt-builder';
import { copyText, downloadDataUrl, downloadText, safeFileName } from '../core/util';

const VERDICT: Record<Verdict, { icon: string; label: string; cls: string }> = {
  correct: { icon: '✓', label: '正確', cls: 'ok' },
  partial: { icon: '◐', label: '部分正確', cls: 'part' },
  wrong: { icon: '✗', label: '錯誤', cls: 'bad' },
  unanswered: { icon: '–', label: '未作答', cls: 'none' },
  ungraded: { icon: '?', label: '交給 AI 批改', cls: 'ai' },
};

function showResp(q: Question, r: Response | undefined): string {
  if (r === undefined || (Array.isArray(r) ? r.length === 0 : !r.trim())) return '（未作答）';
  if (typeof r === 'string') return r;
  return r.map((i) => `(${optionLabel(q, i)}) ${q.type === 'truefalse' ? '' : q.options[i] ?? ''}`.trim()).join('、');
}

interface Props {
  quiz: Quiz;
  responses: Responses;
  order: string[];
  elapsedSec: number;
  onRetry: () => void;
  onEdit?: () => void;
}

export function Results({ quiz, responses, order, elapsedSec, onRetry, onEdit }: Props) {
  const grade = useMemo(() => gradeQuiz(quiz, responses, order), [quiz, responses, order]);
  const [mode, setMode] = useState<PromptMode>('wrong');
  const prompt = useMemo(() => buildPrompt(quiz, grade, { mode, elapsedSec }), [quiz, grade, mode, elapsedSec]);
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState<'all' | 'wrong'>('all');
  const showKey = quiz.meta.showAnswerAfterSubmit !== false;
  const images = grade.results.filter((r) => r.question.image);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const copy = async () => flash((await copyText(prompt)) ? '✅ 提示詞已複製！貼給你的 AI 就可以了' : '⚠️ 複製失敗，請手動全選複製');

  const openAi = async (t: AiTarget) => {
    const { url, prefilled } = aiUrl(t, prompt);
    const copied = await copyText(prompt);
    window.open(url, '_blank', 'noopener');
    if (!prefilled) flash(copied ? '✅ 已複製提示詞，在新分頁貼上（Ctrl/⌘+V）即可' : '⚠️ 請先手動複製提示詞');
  };

  const pct = grade.autoTotal > 0 ? Math.round((grade.autoEarned / grade.autoTotal) * 100) : null;
  const shown = grade.results.filter((r) => filter === 'all' || (r.verdict !== 'correct' && r.verdict !== 'ungraded'));

  return (
    <main class="container narrow results">
      <section class="card score-card">
        <div class="score-ring" style={{ '--pct': `${pct ?? 0}` } as Record<string, string>}>
          <div>
            {pct !== null ? (
              <>
                <b>{grade.autoEarned}</b>
                <span>/ {grade.autoTotal}</span>
              </>
            ) : (
              <b class="small-b">交給 AI</b>
            )}
          </div>
        </div>
        <div class="score-detail">
          <h1>交卷完成 🎉</h1>
          <p class="muted">
            {pct !== null && <>正確率 {pct}%・</>}答對 {grade.correctCount} 題・答錯 {grade.wrongCount} 題・作答{' '}
            {grade.answeredCount}/{grade.results.length} 題・用時 {Math.floor(elapsedSec / 60)} 分 {elapsedSec % 60} 秒
          </p>
          {grade.pendingTotal > 0 && (
            <p class="muted small">另有 {grade.pendingTotal} 分的題目（簡答或沒有標準答案）會由 AI 幫你批改。</p>
          )}
        </div>
      </section>

      <section class="card prompt-panel">
        <h2>🤖 讓 AI 幫你解析</h2>
        <p class="muted small">選擇解析方式，複製下面的提示詞貼給 ChatGPT、Claude、Gemini 或任何你常用的 AI。</p>
        <div class="seg">
          {(Object.keys(PROMPT_MODE_LABEL) as PromptMode[]).map((m) => (
            <button key={m} class={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {PROMPT_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <textarea class="prompt-box" readOnly value={prompt} rows={10} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
        <div class="prompt-actions">
          <button class="btn primary big" onClick={copy}>
            📋 複製提示詞
          </button>
          {AI_TARGETS.map((t) => (
            <button key={t.id} class="btn" onClick={() => openAi(t.id)}>
              用 {t.name} 開啟 ↗
            </button>
          ))}
        </div>
        {images.length > 0 && (
          <div class="img-downloads">
            <p class="small">有 {images.length} 題附圖，記得一併上傳給 AI：</p>
            {images.map((r) => (
              <button key={r.question.id} class="btn small" onClick={() => downloadDataUrl(`第${r.index + 1}題.jpg`, r.question.image!)}>
                ⬇ 第 {r.index + 1} 題圖片
              </button>
            ))}
          </div>
        )}
        <p class="muted small">提示詞 {prompt.length.toLocaleString()} 字。若 AI 開啟後沒有自動帶入，直接貼上即可（已自動複製）。</p>
      </section>

      <section class="card review">
        <div class="review-head">
          <h2>📋 作答回顧</h2>
          <div class="seg small">
            <button class={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
              全部
            </button>
            <button class={filter === 'wrong' ? 'on' : ''} onClick={() => setFilter('wrong')}>
              只看錯題
            </button>
          </div>
        </div>
        {shown.length === 0 && <p class="muted">沒有錯題，太強了！💯</p>}
        {shown.map((r) => {
          const q = r.question;
          const v = VERDICT[r.verdict];
          return (
            <div key={q.id} class={`review-item ${v.cls}`}>
              <div class="review-title">
                <span class={`verdict ${v.cls}`}>{v.icon}</span>
                <b>第 {r.index + 1} 題</b>
                <span class="muted small">
                  {TYPE_LABEL[q.type]}・{v.label}
                  {hasAnswer(q) && `・${r.earned}/${q.points} 分`}
                </span>
              </div>
              <div class="q-stem small-stem">{q.stem}</div>
              {q.image && <img class="q-image thumb" src={q.image} alt="" />}
              <div class="review-line">
                <span class="muted">你的答案：</span>
                {showResp(q, r.response)}
              </div>
              {showKey && hasAnswer(q) && (
                <div class="review-line">
                  <span class="muted">正確答案：</span>
                  {showResp(q, q.answer)}
                </div>
              )}
              {showKey && q.type === 'short' && q.reference && (
                <div class="review-line">
                  <span class="muted">參考答案：</span>
                  {q.reference}
                </div>
              )}
              {showKey && q.explanation && (
                <div class="review-line">
                  <span class="muted">解析：</span>
                  {q.explanation}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <div class="end-actions">
        <button class="btn" onClick={onRetry}>
          🔁 重新作答
        </button>
        <button class="btn" onClick={() => downloadText(`${safeFileName(quiz.meta.title)}-作答紀錄.txt`, prompt)}>
          ⬇ 下載作答紀錄
        </button>
        {onEdit && (
          <button class="btn" onClick={onEdit}>
            ✏️ 編輯這份測驗
          </button>
        )}
      </div>
      {toast && <div class="toast">{toast}</div>}
    </main>
  );
}
