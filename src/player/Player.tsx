import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { optionLabel, TYPE_LABEL, type Question, type Quiz } from '../core/olt';
import { isAnswered, type Responses } from '../core/grader';
import { hashString, shuffled, storageGet, storageSet } from '../core/util';
import { Results } from './Results';
import { Stem } from './Stem';

interface Progress {
  order: string[];
  responses: Responses;
  flagged: string[];
  startedAt: number;
  current: number;
  submitted?: { elapsedSec: number; at: number };
}

export interface PlayerProps {
  quiz: Quiz;
  /** 回首頁（獨立離線版沒有） */
  onExit?: () => void;
  onEdit?: () => void;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function Player({ quiz, onExit, onEdit }: PlayerProps) {
  const key = useMemo(() => `olt-progress:${hashString(JSON.stringify(quiz))}`, [quiz]);
  const [prog, setProg] = useState<Progress | undefined>(() => storageGet<Progress>(key));
  const [phase, setPhase] = useState<'intro' | 'taking' | 'done'>(() => (prog?.submitted ? 'done' : 'intro'));
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => storageSet(key, prog), [key, prog]);

  const byId = useMemo(() => new Map(quiz.questions.map((q) => [q.id, q])), [quiz]);
  const limitSec = quiz.meta.timeLimitMin ? quiz.meta.timeLimitMin * 60 : undefined;
  const elapsed = prog ? (now - prog.startedAt) / 1000 : 0;
  const remaining = limitSec !== undefined ? limitSec - elapsed : undefined;

  useEffect(() => {
    if (phase !== 'taking') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const start = (fresh: boolean) => {
    submittedRef.current = false;
    if (fresh || !prog) {
      const ids = quiz.questions.map((q) => q.id);
      setProg({
        order: quiz.meta.shuffle ? shuffled(ids) : ids,
        responses: {},
        flagged: [],
        startedAt: Date.now(),
        current: 0,
      });
    }
    setNow(Date.now());
    setPhase('taking');
  };

  const submit = () => {
    if (!prog || submittedRef.current) return;
    submittedRef.current = true;
    const elapsedSec = Math.round(Math.min((Date.now() - prog.startedAt) / 1000, limitSec ?? Infinity));
    setProg({ ...prog, submitted: { elapsedSec, at: Date.now() } });
    setConfirming(false);
    setPhase('done');
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (phase === 'taking' && remaining !== undefined && remaining <= 0) submit();
  });

  // 鍵盤：← → 換題
  useEffect(() => {
    if (phase !== 'taking') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const go = (delta: number) =>
    setProg((p) => (p ? { ...p, current: Math.max(0, Math.min(p.order.length - 1, p.current + delta)) } : p));
  const jump = (i: number) => {
    setProg((p) => (p ? { ...p, current: i } : p));
    setNavOpen(false);
  };

  const header = (
    <header class="topbar">
      {onExit ? (
        <button class="btn ghost" onClick={onExit}>
          ← 首頁
        </button>
      ) : (
        <span class="brand">📝 OLT</span>
      )}
      <div class="topbar-title" title={quiz.meta.title}>
        {quiz.meta.title}
      </div>
      {phase === 'taking' && (
        <div class={`timer ${remaining !== undefined && remaining < 60 ? 'danger' : ''}`}>
          ⏱ {remaining !== undefined ? fmtClock(remaining) : fmtClock(elapsed)}
        </div>
      )}
    </header>
  );

  if (phase === 'done' && prog?.submitted) {
    return (
      <div class="app">
        {header}
        <Results
          quiz={quiz}
          responses={prog.responses}
          order={prog.order}
          elapsedSec={prog.submitted.elapsedSec}
          onRetry={() => start(true)}
          onEdit={onEdit}
        />
      </div>
    );
  }

  if (phase === 'intro' || !prog) {
    const total = quiz.questions.reduce((s, q) => s + q.points, 0);
    const counts = quiz.questions.reduce<Record<string, number>>((m, q) => ((m[q.type] = (m[q.type] ?? 0) + 1), m), {});
    const resumable = prog && !prog.submitted && Object.keys(prog.responses).length > 0;
    return (
      <div class="app">
        {header}
        <main class="container narrow">
          <section class="card intro">
            <div class="intro-emoji">📝</div>
            <h1>{quiz.meta.title}</h1>
            {quiz.meta.subject && <p class="muted">科目：{quiz.meta.subject}</p>}
            <div class="stat-row">
              <div class="stat">
                <b>{quiz.questions.length}</b>
                <span>題</span>
              </div>
              <div class="stat">
                <b>{total}</b>
                <span>總分</span>
              </div>
              <div class="stat">
                <b>{quiz.meta.timeLimitMin ?? '∞'}</b>
                <span>分鐘</span>
              </div>
            </div>
            <p class="muted small">
              {Object.entries(counts)
                .map(([t, n]) => `${TYPE_LABEL[t as Question['type']]} ${n} 題`)
                .join('・')}
              {quiz.meta.shuffle ? '・題序隨機' : ''}
            </p>
            <div class="intro-actions">
              {resumable ? (
                <>
                  <button class="btn primary big" onClick={() => start(false)}>
                    繼續作答（已答 {Object.values(prog!.responses).filter(isAnswered).length} 題）
                  </button>
                  <button class="btn" onClick={() => start(true)}>
                    重新開始
                  </button>
                </>
              ) : (
                <button class="btn primary big" onClick={() => start(true)}>
                  開始作答 →
                </button>
              )}
            </div>
            <p class="muted small">作答進度會自動儲存在這台裝置，不小心關掉也不會不見。</p>
          </section>
        </main>
      </div>
    );
  }

  const order = prog.order.filter((id) => byId.has(id));
  const idx = Math.min(prog.current, order.length - 1);
  const q = byId.get(order[idx])!;
  const resp = prog.responses[q.id];
  const answeredCount = order.filter((id) => isAnswered(prog.responses[id])).length;
  const unanswered = order.length - answeredCount;
  const flagged = prog.flagged.includes(q.id);

  const setResp = (v: Responses[string]) =>
    setProg((p) => (p ? { ...p, responses: { ...p.responses, [q.id]: v } } : p));
  const toggleFlag = () =>
    setProg((p) =>
      p ? { ...p, flagged: flagged ? p.flagged.filter((x) => x !== q.id) : [...p.flagged, q.id] } : p,
    );

  const choose = (i: number) => {
    if (q.type === 'multiple') {
      const cur = Array.isArray(resp) ? resp : [];
      setResp(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b));
    } else {
      setResp(Array.isArray(resp) && resp[0] === i ? [] : [i]);
    }
  };

  return (
    <div class="app">
      {header}
      <div class="progressbar">
        <div style={{ width: `${(answeredCount / order.length) * 100}%` }} />
      </div>
      <main class="container play-layout">
        <aside class={`qnav card ${navOpen ? 'open' : ''}`}>
          <button class="qnav-toggle" onClick={() => setNavOpen(!navOpen)}>
            題目總覽 {answeredCount}/{order.length} {navOpen ? '▲' : '▼'}
          </button>
          <div class="qnav-grid">
            {order.map((id, i) => (
              <button
                key={id}
                class={`qnav-item ${i === idx ? 'current' : ''} ${isAnswered(prog.responses[id]) ? 'done' : ''} ${
                  prog.flagged.includes(id) ? 'flag' : ''
                }`}
                onClick={() => jump(i)}
                aria-label={`第 ${i + 1} 題`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <div class="qnav-legend small muted">
            <span class="dot done" /> 已答 <span class="dot flag" /> 待檢查
          </div>
          <button class="btn primary full" onClick={() => setConfirming(true)}>
            交卷
          </button>
        </aside>

        <section class="card question" key={q.id}>
          <div class="q-head">
            <span class="badge">
              第 {idx + 1} 題 · {TYPE_LABEL[q.type]}
              {q.type === 'multiple' ? '（可複選）' : ''} · {q.points} 分
            </span>
            <button class={`btn ghost small ${flagged ? 'flagged' : ''}`} onClick={toggleFlag}>
              {flagged ? '🚩 已標記' : '🏳 標記待檢查'}
            </button>
          </div>
          <Stem text={q.stem} />
          {q.image && <img class="q-image" src={q.image} alt={`第 ${idx + 1} 題附圖`} />}

          {q.type === 'short' ? (
            <textarea
              class="answer-text"
              rows={6}
              placeholder="在這裡輸入你的答案…"
              value={typeof resp === 'string' ? resp : ''}
              onInput={(e) => setResp((e.target as HTMLTextAreaElement).value)}
            />
          ) : (
            <div class={`options ${q.type === 'truefalse' ? 'tf' : ''}`} role={q.type === 'multiple' ? 'group' : 'radiogroup'}>
              {q.options.map((opt, i) => {
                const on = Array.isArray(resp) && resp.includes(i);
                return (
                  <button
                    key={i}
                    class={`option ${on ? 'selected' : ''} ${q.type === 'multiple' ? 'multi' : ''}`}
                    role={q.type === 'multiple' ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    onClick={() => choose(i)}
                  >
                    <span class="opt-label">{optionLabel(q, i)}</span>
                    <span class="opt-text">{q.type === 'truefalse' ? (i === 0 ? '對' : '錯') : opt}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div class="q-foot">
            <button class="btn" disabled={idx === 0} onClick={() => go(-1)}>
              ← 上一題
            </button>
            {idx < order.length - 1 ? (
              <button class="btn primary" onClick={() => go(1)}>
                下一題 →
              </button>
            ) : (
              <button class="btn primary" onClick={() => setConfirming(true)}>
                交卷 ✓
              </button>
            )}
          </div>
        </section>
      </main>

      {confirming && (
        <div class="modal-backdrop" onClick={() => setConfirming(false)}>
          <div class="modal card" onClick={(e) => e.stopPropagation()}>
            <h2>確定要交卷嗎？</h2>
            {unanswered > 0 ? (
              <p>
                還有 <b class="warn">{unanswered}</b> 題沒有作答。
              </p>
            ) : (
              <p>全部題目都作答完畢 👍</p>
            )}
            {prog.flagged.length > 0 && <p>有 {prog.flagged.length} 題標記為待檢查。</p>}
            <div class="modal-actions">
              <button class="btn" onClick={() => setConfirming(false)}>
                再檢查一下
              </button>
              <button class="btn primary" onClick={submit}>
                確定交卷
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
