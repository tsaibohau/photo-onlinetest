import { useState } from 'preact/hooks';
import type { Quiz } from '../core/olt';

interface Props {
  onCreate: () => void;
  onOpenFile: (f: File) => void;
  onSample: () => void;
  draft?: Quiz;
  onResumeDraft: () => void;
  error: string;
  installPrompt: (() => void) | null;
}

export function Home({ onCreate, onOpenFile, onSample, draft, onResumeDraft, error, installPrompt }: Props) {
  const [drag, setDrag] = useState(false);
  return (
    <main
      class={`container home ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onOpenFile(f);
      }}
    >
      <section class="hero">
        <div class="hero-badge">📝 OLT 線上測驗</div>
        <h1>
          拍一張考卷，
          <br />
          <span class="grad">變成你的專屬線上測驗</span>
        </h1>
        <p class="hero-sub">拍照或上傳檔案自動辨識題目 → 線上作答 → 交卷後一鍵產生 AI 解析提示詞，讓你的 AI 變成私人家教。</p>
      </section>

      {error && <div class="alert bad">⚠️ {error}</div>}

      <section class="home-cards">
        <button class="card action-card" onClick={onCreate}>
          <div class="ac-icon">📷</div>
          <h2>建立測驗</h2>
          <p class="muted">拍照、上傳 PDF / Word / 圖片，或貼上文字，自動變成題目</p>
        </button>
        <label class="card action-card">
          <div class="ac-icon">📂</div>
          <h2>開啟 .olt 測驗</h2>
          <p class="muted">選擇或拖曳 .olt 檔案到這裡，立刻開始作答（選到考卷檔也會自動幫你辨識）</p>
          <input
            type="file"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) onOpenFile(f);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
      </section>

      <div class="home-links">
        <button class="btn ghost" onClick={onSample}>
          ✨ 試玩範例測驗
        </button>
        {draft && (
          <button class="btn ghost" onClick={onResumeDraft}>
            ✏️ 繼續編輯「{draft.meta.title}」（{draft.questions.length} 題）
          </button>
        )}
        {installPrompt && (
          <button class="btn ghost" onClick={installPrompt}>
            💻 安裝成 App（之後可直接雙擊 .olt）
          </button>
        )}
      </div>

      <section class="steps">
        {[
          ['1', '📸', '拍照 / 上傳', 'OCR 在你的裝置上辨識，照片不外流'],
          ['2', '✏️', '校對題目', '單選、多選、是非、簡答都支援'],
          ['3', '⬇', '下載 .olt', '分享給學生或自己練習，離線也能用'],
          ['4', '🤖', '交卷問 AI', '自動整理作答結果成提示詞'],
        ].map(([n, icon, t, d]) => (
          <div class="step" key={n}>
            <div class="step-icon">{icon}</div>
            <b>{t}</b>
            <span class="small muted">{d}</span>
          </div>
        ))}
      </section>
      <footer class="small muted center">所有資料都只存在你的瀏覽器中・OLT v0.1</footer>
    </main>
  );
}
