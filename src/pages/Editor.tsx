import { useState } from 'preact/hooks';
import {
  blankQuestion,
  LETTERS,
  TRUEFALSE_OPTIONS,
  TYPE_LABEL,
  validateQuiz,
  type Question,
  type QuestionType,
  type Quiz,
} from '../core/olt';
import { imageToDataUrl } from '../core/importers';
import { downloadOlt, downloadStandalone } from '../core/export';

interface Props {
  quiz: Quiz;
  onChange: (q: Quiz) => void;
  warnings: string[];
  onPlay: (q: Quiz) => void;
  onBack: () => void;
  onAddMore: () => void;
}

function changeType(q: Question, type: QuestionType): Question {
  if (type === q.type) return q;
  const next: Question = { ...q, type };
  if (type === 'truefalse') {
    next.options = [...TRUEFALSE_OPTIONS];
    next.answer = [];
  } else if (type === 'short') {
    next.options = [];
    next.answer = [];
  } else {
    if (q.type === 'truefalse' || q.type === 'short' || q.options.length < 2) next.options = ['', '', '', ''];
    if (type === 'single' && (next.answer?.length ?? 0) > 1) next.answer = next.answer!.slice(0, 1);
  }
  return next;
}

function QuestionEditor({
  q,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  q: Question;
  index: number;
  total: number;
  onChange: (q: Question) => void;
  onRemove: () => void;
  onMove: (d: number) => void;
}) {
  const set = (patch: Partial<Question>) => onChange({ ...q, ...patch });
  const toggleAns = (i: number) => {
    const cur = q.answer ?? [];
    if (q.type === 'multiple') set({ answer: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b) });
    else set({ answer: cur[0] === i ? [] : [i] });
  };
  const missing =
    !q.stem.trim() || ((q.type === 'single' || q.type === 'multiple') && q.options.filter((o) => o.trim()).length < 2);

  return (
    <div class={`card qedit ${missing ? 'invalid' : ''}`}>
      <div class="qedit-head">
        <b class="qnum">{index + 1}</b>
        <select value={q.type} onChange={(e) => onChange(changeType(q, (e.target as HTMLSelectElement).value as QuestionType))}>
          {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}題
            </option>
          ))}
        </select>
        <label class="inline">
          配分
          <input
            type="number"
            min={0}
            step={0.5}
            value={q.points}
            onInput={(e) => set({ points: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
          />
        </label>
        <div class="spacer" />
        <button class="btn ghost small" disabled={index === 0} onClick={() => onMove(-1)} title="上移">
          ↑
        </button>
        <button class="btn ghost small" disabled={index === total - 1} onClick={() => onMove(1)} title="下移">
          ↓
        </button>
        <button class="btn ghost small danger" onClick={onRemove} title="刪除">
          🗑
        </button>
      </div>
      <textarea
        class="stem-input"
        rows={2}
        placeholder="題目內容"
        value={q.stem}
        onInput={(e) => set({ stem: (e.target as HTMLTextAreaElement).value })}
      />
      <div class="img-row">
        {q.image ? (
          <>
            <img class="q-image thumb" src={q.image} alt="" />
            <button class="btn small" onClick={() => set({ image: undefined })}>
              移除附圖
            </button>
          </>
        ) : (
          <label class="btn small ghost">
            🖼 加入附圖
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) set({ image: await imageToDataUrl(f) });
              }}
            />
          </label>
        )}
      </div>

      {(q.type === 'single' || q.type === 'multiple') && (
        <div class="opt-edit">
          <p class="small muted">點左邊的字母設定正確答案{q.type === 'multiple' ? '（可多個）' : ''}；沒有答案可以不選，AI 會幫忙解題。</p>
          {q.options.map((o, i) => (
            <div class="opt-edit-row" key={i}>
              <button
                class={`opt-label clickable ${q.answer?.includes(i) ? 'correct' : ''}`}
                onClick={() => toggleAns(i)}
                title="設為正確答案"
              >
                {LETTERS[i]}
              </button>
              <input
                value={o}
                placeholder={`選項 ${LETTERS[i]}`}
                onInput={(e) => {
                  const options = [...q.options];
                  options[i] = (e.target as HTMLInputElement).value;
                  set({ options });
                }}
              />
              <button
                class="btn ghost small"
                disabled={q.options.length <= 2}
                onClick={() =>
                  set({
                    options: q.options.filter((_, j) => j !== i),
                    answer: (q.answer ?? []).filter((a) => a !== i).map((a) => (a > i ? a - 1 : a)),
                  })
                }
              >
                ✕
              </button>
            </div>
          ))}
          {q.options.length < 8 && (
            <button class="btn small ghost" onClick={() => set({ options: [...q.options, ''] })}>
              ＋ 新增選項
            </button>
          )}
        </div>
      )}
      {q.type === 'truefalse' && (
        <div class="opt-edit tf-edit">
          <span class="small muted">正確答案：</span>
          {['O 對', 'X 錯'].map((l, i) => (
            <button key={i} class={`btn small ${q.answer?.includes(i) ? 'primary' : ''}`} onClick={() => toggleAns(i)}>
              {l}
            </button>
          ))}
        </div>
      )}
      {q.type === 'short' && (
        <textarea
          rows={2}
          placeholder="參考答案（可留空，AI 會自行判斷）"
          value={q.reference ?? ''}
          onInput={(e) => set({ reference: (e.target as HTMLTextAreaElement).value || undefined })}
        />
      )}
      <details>
        <summary class="small muted">解析（選填）</summary>
        <textarea
          rows={2}
          placeholder="交卷後顯示的解析"
          value={q.explanation ?? ''}
          onInput={(e) => set({ explanation: (e.target as HTMLTextAreaElement).value || undefined })}
        />
      </details>
    </div>
  );
}

export function Editor({ quiz, onChange, warnings, onPlay, onBack, onAddMore }: Props) {
  const [hideAnswers, setHideAnswers] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = quiz.meta;
  const setMeta = (patch: Partial<Quiz['meta']>) => onChange({ ...quiz, meta: { ...meta, ...patch } });
  const setQ = (qs: Question[]) => onChange({ ...quiz, questions: qs });

  const check = (): Quiz | null => {
    try {
      const qs = quiz.questions.map((q) =>
        q.type === 'single' || q.type === 'multiple'
          ? (() => {
              // 移除空白選項並重新對應答案索引
              const keep = q.options.map((o, i) => [o.trim(), i] as const).filter(([o]) => o);
              const map = new Map(keep.map(([, i], j) => [i, j]));
              return { ...q, options: keep.map(([o]) => o), answer: (q.answer ?? []).filter((a) => map.has(a)).map((a) => map.get(a)!) };
            })()
          : q,
      );
      const v = validateQuiz({ ...quiz, questions: qs });
      const emptyStem = v.questions.findIndex((q) => !q.stem.trim());
      if (emptyStem >= 0) throw new Error(`第 ${emptyStem + 1} 題沒有題目內容。`);
      setError('');
      return v;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const total = quiz.questions.reduce((s, q) => s + q.points, 0);
  const noKey = quiz.questions.filter((q) => q.type !== 'short' && !(q.answer && q.answer.length)).length;

  return (
    <main class="container editor">
      <section class="card meta-card">
        <div class="row">
          <button class="btn ghost" onClick={onBack}>
            ← 返回
          </button>
          <h1 class="grow">✏️ 校對與編輯</h1>
        </div>
        {warnings.length > 0 && (
          <div class="alert">
            <b>辨識提醒：</b>
            <ul>
              {warnings.slice(0, 8).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div class="meta-grid">
          <label>
            測驗名稱
            <input value={meta.title} onInput={(e) => setMeta({ title: (e.target as HTMLInputElement).value })} />
          </label>
          <label>
            科目
            <input
              value={meta.subject ?? ''}
              placeholder="例如：國中數學"
              onInput={(e) => setMeta({ subject: (e.target as HTMLInputElement).value || undefined })}
            />
          </label>
          <label>
            時間限制（分鐘，0 = 不限）
            <input
              type="number"
              min={0}
              value={meta.timeLimitMin ?? 0}
              onInput={(e) => setMeta({ timeLimitMin: Number((e.target as HTMLInputElement).value) || undefined })}
            />
          </label>
          <label>
            多選題計分
            <select
              value={meta.multipleScoring ?? 'all'}
              onChange={(e) => setMeta({ multipleScoring: (e.target as HTMLSelectElement).value as 'all' | 'partial' })}
            >
              <option value="all">全對才給分</option>
              <option value="partial">依答對比例給分</option>
            </select>
          </label>
        </div>
        <div class="checks">
          <label class="inline">
            <input type="checkbox" checked={!!meta.shuffle} onChange={(e) => setMeta({ shuffle: (e.target as HTMLInputElement).checked })} />
            題序隨機
          </label>
          <label class="inline">
            <input
              type="checkbox"
              checked={meta.showAnswerAfterSubmit !== false}
              onChange={(e) => setMeta({ showAnswerAfterSubmit: (e.target as HTMLInputElement).checked })}
            />
            交卷後顯示正確答案
          </label>
        </div>
        <p class="small muted">
          共 {quiz.questions.length} 題・總分 {total}
          {noKey > 0 && `・${noKey} 題尚未設定答案（交卷後由 AI 解題）`}
        </p>
      </section>

      {quiz.questions.map((q, i) => (
        <QuestionEditor
          key={q.id}
          q={q}
          index={i}
          total={quiz.questions.length}
          onChange={(nq) => setQ(quiz.questions.map((x) => (x.id === q.id ? nq : x)))}
          onRemove={() => setQ(quiz.questions.filter((x) => x.id !== q.id))}
          onMove={(d) => {
            const qs = [...quiz.questions];
            [qs[i], qs[i + d]] = [qs[i + d], qs[i]];
            setQ(qs);
          }}
        />
      ))}

      <div class="add-row">
        {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
          <button key={t} class="btn" onClick={() => setQ([...quiz.questions, blankQuestion(t)])}>
            ＋ {TYPE_LABEL[t]}題
          </button>
        ))}
        <button class="btn ghost" onClick={onAddMore}>
          📷 從檔案/照片再匯入
        </button>
      </div>

      <section class="card export-bar">
        {error && <div class="alert bad">⚠️ {error}</div>}
        <label class="inline small">
          <input type="checkbox" checked={hideAnswers} onChange={(e) => setHideAnswers((e.target as HTMLInputElement).checked)} />
          隱藏答案（避免用記事本直接看到答案；僅防君子）
        </label>
        <div class="export-actions">
          <button
            class="btn"
            onClick={() => {
              const v = check();
              if (v) onPlay(v);
            }}
          >
            ▶ 試作
          </button>
          <button
            class="btn primary"
            onClick={() => {
              const v = check();
              if (v) downloadOlt(v, hideAnswers);
            }}
          >
            ⬇ 下載 .olt
          </button>
          <button
            class="btn primary"
            disabled={busy}
            onClick={async () => {
              const v = check();
              if (!v) return;
              setBusy(true);
              try {
                await downloadStandalone(v, hideAnswers);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            ⬇ 下載離線版 .olt.html
          </button>
        </div>
        <p class="small muted">
          <b>.olt</b>：用本網站或安裝的 App 開啟（桌面版可雙擊）。<b>.olt.html</b>：自帶介面，任何手機、電腦點開就能作答，適合用 LINE / Email 分享。
        </p>
      </section>
    </main>
  );
}
