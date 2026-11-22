// 離線播放器（.olt.html）入口：題目內嵌在 <script id="olt-data">
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { parseOlt, type Quiz } from './core/olt';
import { Player } from './player/Player';
import './styles/app.css';

function Standalone() {
  const [quiz, setQuiz] = useState<Quiz | null>(() => {
    const raw = document.getElementById('olt-data')?.textContent?.trim();
    if (!raw || raw === 'null') return null;
    try {
      return parseOlt(raw);
    } catch {
      return null;
    }
  });
  const [error, setError] = useState('');
  if (quiz) return <Player quiz={quiz} />;
  return (
    <div class="app">
      <main class="container narrow">
        <section class="card intro">
          <div class="intro-emoji">📂</div>
          <h1>OLT 離線播放器</h1>
          <p class="muted">這個檔案沒有內嵌題目，請選擇一個 .olt 檔案開啟。</p>
          {error && <div class="alert bad">{error}</div>}
          <label class="btn primary big">
            選擇 .olt 檔案
            <input
              type="file"
              accept=".olt,.json"
              hidden
              onChange={async (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (!f) return;
                try {
                  setQuiz(parseOlt(await f.text()));
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </label>
        </section>
      </main>
    </div>
  );
}

render(<Standalone />, document.getElementById('app')!);
