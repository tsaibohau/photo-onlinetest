import { useEffect, useState } from 'preact/hooks';
import { newQuiz, parseOlt, type Question, type Quiz } from './core/olt';
import { parseAiJson } from './core/ai-import';
import { storageGet, storageSet } from './core/util';
import { Home } from './pages/Home';
import { Create } from './pages/Create';
import { Editor } from './pages/Editor';
import { Player } from './player/Player';

type View = 'home' | 'create' | 'edit' | 'play';
const DRAFT_KEY = 'olt-draft';
const PLAY_KEY = 'olt-playing';

function viewFromHash(): View {
  const h = location.hash.replace(/^#\/?/, '');
  return (['create', 'edit', 'play'] as View[]).includes(h as View) ? (h as View) : 'home';
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

export function App({ launchFile }: { launchFile?: Promise<File | null> }) {
  const [view, setViewState] = useState<View>(viewFromHash);
  const [draft, setDraft] = useState<Quiz | undefined>(() => storageGet<Quiz>(DRAFT_KEY));
  const [playing, setPlaying] = useState<Quiz | undefined>(() => {
    try {
      const s = sessionStorage.getItem(PLAY_KEY);
      return s ? parseOlt(s) : undefined;
    } catch {
      return undefined;
    }
  });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [fromEditor, setFromEditor] = useState(false);
  const [install, setInstall] = useState<BeforeInstallPromptEvent | null>(null);
  const [fromCreateAppend, setAppend] = useState(false);

  const setView = (v: View) => {
    if (v !== view) {
      location.hash = v === 'home' ? '' : `/${v}`;
      setViewState(v);
      window.scrollTo({ top: 0 });
    }
  };

  useEffect(() => {
    const onHash = () => setViewState(viewFromHash());
    window.addEventListener('hashchange', onHash);
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstall(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onInstall);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('beforeinstallprompt', onInstall);
    };
  }, []);

  useEffect(() => storageSet(DRAFT_KEY, draft), [draft]);

  const play = (q: Quiz, editing = false) => {
    setPlaying(q);
    setFromEditor(editing);
    try {
      sessionStorage.setItem(PLAY_KEY, JSON.stringify(q));
    } catch {
      /* ignore */
    }
    setView('play');
  };

  const openFile = async (f: File) => {
    setError('');
    try {
      const text = await f.text();
      play(f.name.toLowerCase().endsWith('.json') ? parseAiJson(text) : parseOlt(text));
    } catch (e) {
      setError(`無法開啟「${f.name}」：${(e as Error).message}`);
      setView('home');
    }
  };

  // PWA：從作業系統雙擊 .olt 開啟
  useEffect(() => {
    launchFile?.then((f) => f && openFile(f));
  }, []);

  // 沒有資料的頁面導回首頁（例如重新整理後）
  useEffect(() => {
    if ((view === 'edit' && !draft) || (view === 'play' && !playing)) setView('home');
  }, [view, draft, playing]);

  const onImported = (qs: Question[], title: string | undefined, w: string[], meta?: Quiz['meta']) => {
    const appending = !!draft && fromCreateAppend;
    if (appending && draft) {
      setDraft({ ...draft, questions: [...draft.questions, ...qs] });
    } else {
      const q = newQuiz(title ?? '未命名測驗', qs);
      if (meta) q.meta = { ...q.meta, ...meta };
      setDraft(q);
    }
    setWarnings(w);
    setView('edit');
  };

  if (view === 'create')
    return (
      <div class="app">
        <Create onBack={() => setView(fromCreateAppend ? 'edit' : 'home')} onImported={onImported} appending={fromCreateAppend && !!draft} />
      </div>
    );

  if (view === 'edit' && draft)
    return (
      <div class="app">
        <Editor
          quiz={draft}
          onChange={setDraft}
          warnings={warnings}
          onPlay={(q) => play(q, true)}
          onBack={() => setView('home')}
          onAddMore={() => {
            setAppend(true);
            setView('create');
          }}
        />
      </div>
    );

  if (view === 'play' && playing)
    return (
      <Player
        key={JSON.stringify(playing.meta) + playing.questions.length}
        quiz={playing}
        onExit={() => setView(fromEditor ? 'edit' : 'home')}
        onEdit={() => {
          setDraft(playing);
          setWarnings([]);
          setView('edit');
        }}
      />
    );

  return (
    <div class="app">
      <Home
        onCreate={() => {
          setAppend(false);
          setView('create');
        }}
        onOpenFile={openFile}
        onSample={async () => {
          try {
            const res = await fetch(new URL('samples/demo.olt', document.baseURI).href);
            play(parseOlt(await res.text()));
          } catch (e) {
            setError(`範例載入失敗：${(e as Error).message}`);
          }
        }}
        draft={draft && draft.questions.length ? draft : undefined}
        onResumeDraft={() => {
          setWarnings([]);
          setView('edit');
        }}
        error={error}
        installPrompt={
          install
            ? () => {
                install.prompt();
                setInstall(null);
              }
            : null
        }
      />
    </div>
  );
}
