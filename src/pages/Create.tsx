import { useState } from 'preact/hooks';
import { parseQuestionsFromText } from '../core/text-parser';
import { docxToText, fileKind, ocrImage, OCR_LANGS, pdfToText, type OcrLang } from '../core/importers';
import { CONVERSION_PROMPT, parseAiJson } from '../core/ai-import';
import { parseOlt, type Question, type Quiz } from '../core/olt';
import { copyText, storageGet, storageSet } from '../core/util';

interface Props {
  onBack: () => void;
  /** 匯入完成：題目 + 可能的標題 + 警告 */
  onImported: (questions: Question[], title: string | undefined, warnings: string[], meta?: Quiz['meta']) => void;
  appending: boolean;
}

type Tab = 'scan' | 'paste' | 'ai';

const SAMPLE_TEXT = `國二自然 期中練習
一、單選題（每題 2 分）
1. 下列何者是植物進行光合作用的主要場所？ (A) 粒線體 (B) 葉綠體 (C) 細胞核 (D) 液胞
答案：B
2. 水的化學式為何？ (A) H2O (B) CO2 (C) O2 (D) NaCl
答案：A
二、多選題（每題 4 分）
3. 下列哪些屬於哺乳類？ (A) 鯨魚 (B) 企鵝 (C) 蝙蝠 (D) 鯊魚
答案：A,C
三、是非題
(O) 4. 聲音在真空中無法傳播。
四、簡答題（每題 5 分）
5. 請說明為什麼夏天比冬天熱。`;

export function Create({ onBack, onImported, appending }: Props) {
  const [tab, setTab] = useState<Tab>('scan');
  const [text, setText] = useState('');
  const [lang, setLang] = useState<OcrLang>(() => storageGet<OcrLang>('olt-ocr-lang') ?? 'chi_tra+eng');
  const [busy, setBusy] = useState<{ msg: string; ratio?: number } | null>(null);
  const [error, setError] = useState('');
  const [aiText, setAiText] = useState('');
  const [copied, setCopied] = useState(false);
  const [drag, setDrag] = useState(false);

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setError('');
    const list = [...files];
    let acc = text;
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ${f.name}：` : '';
        const progress = (msg: string, ratio?: number) => setBusy({ msg: prefix + msg, ratio });
        const kind = fileKind(f);
        let out = '';
        if (kind === 'olt' || kind === 'json') {
          const raw = await f.text();
          const quiz = kind === 'olt' ? parseOlt(raw) : parseAiJson(raw);
          setBusy(null);
          onImported(quiz.questions, quiz.meta.title, [], quiz.meta);
          return;
        } else if (kind === 'image') out = await ocrImage(f, lang, progress);
        else if (kind === 'pdf') out = await pdfToText(f, lang, progress);
        else if (kind === 'docx') out = await docxToText(f, progress);
        else if (kind === 'text') out = await f.text();
        else throw new Error(`不支援的檔案類型：${f.name}（支援圖片、PDF、Word .docx、文字檔、.olt）`);
        acc = acc ? `${acc}\n${out}` : out;
        setText(acc);
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      setError(/fetch|network|load/i.test(msg) ? `${msg}（OCR 第一次使用需要網路下載辨識模型）` : msg);
    } finally {
      setBusy(null);
    }
  };

  const parse = () => {
    const r = parseQuestionsFromText(text);
    if (!r.questions.length) {
      setError(r.warnings.join(' '));
      return;
    }
    onImported(r.questions, r.title, r.warnings);
  };

  const importAi = () => {
    try {
      const quiz = parseAiJson(aiText);
      onImported(quiz.questions, quiz.meta.title, [], quiz.meta);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main class="container narrow">
      <section class="card">
        <div class="row">
          <button class="btn ghost" onClick={onBack}>
            ← 返回
          </button>
          <h1 class="grow">{appending ? '➕ 再匯入題目' : '📷 建立測驗'}</h1>
        </div>
        <div class="tabs">
          <button class={tab === 'scan' ? 'on' : ''} onClick={() => setTab('scan')}>
            📷 拍照 / 上傳檔案
          </button>
          <button class={tab === 'paste' ? 'on' : ''} onClick={() => setTab('paste')}>
            ⌨️ 貼上文字
          </button>
          <button class={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>
            🤖 用 AI 轉檔
          </button>
        </div>

        {tab === 'scan' && (
          <>
            <div
              class={`dropzone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                handleFiles(e.dataTransfer?.files ?? null);
              }}
            >
              <div class="dz-icon">📄</div>
              <p>
                <b>拖曳檔案到這裡</b>，或選擇下方按鈕
              </p>
              <p class="small muted">支援：照片（JPG/PNG）、PDF（含掃描檔）、Word（.docx）、文字檔、.olt</p>
              <div class="dz-actions">
                <label class="btn primary big">
                  📸 拍照
                  <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleFiles((e.target as HTMLInputElement).files)} />
                </label>
                <label class="btn big">
                  📁 選擇檔案
                  <input
                    type="file"
                    multiple
                    accept="image/*,.pdf,.docx,.txt,.md,.olt,.json"
                    hidden
                    onChange={(e) => handleFiles((e.target as HTMLInputElement).files)}
                  />
                </label>
              </div>
              <label class="inline small">
                OCR 辨識語言：
                <select
                  value={lang}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value as OcrLang;
                    setLang(v);
                    storageSet('olt-ocr-lang', v);
                  }}
                >
                  {OCR_LANGS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <details class="tips">
              <summary class="small">📌 拍照小技巧（辨識率大提升）</summary>
              <ul class="small">
                <li>光線充足、避免陰影與反光，手機與紙張保持平行。</li>
                <li>一次拍一頁，讓文字盡量填滿畫面。</li>
                <li>印刷字效果最好；手寫字與複雜數學式建議改用「🤖 用 AI 轉檔」。</li>
                <li>所有辨識都在你的裝置上進行，照片不會被上傳。</li>
              </ul>
            </details>
          </>
        )}

        {tab === 'paste' && !text && (
          <p class="small muted">
            直接貼上題目文字（例如從 Word、網頁複製）。常見格式都能辨識：「1. 題目 (A)… (B)…」「答案：B」「(B)1. 題目」、題末答案表「1.B 2.C」。
            <button class="link" onClick={() => setText(SAMPLE_TEXT)}>
              填入範例看看
            </button>
          </p>
        )}

        {tab === 'ai' && (
          <div class="ai-import">
            <ol class="small">
              <li>
                複製下面的提示詞
                <button
                  class="btn small"
                  onClick={async () => {
                    setCopied(await copyText(CONVERSION_PROMPT));
                    setTimeout(() => setCopied(false), 2500);
                  }}
                >
                  {copied ? '✅ 已複製' : '📋 複製轉檔提示詞'}
                </button>
              </li>
              <li>打開你的 AI（ChatGPT / Claude / Gemini），上傳考卷照片或檔案，貼上提示詞送出。</li>
              <li>把 AI 回覆的 JSON 整段貼到下面，按「匯入」。</li>
            </ol>
            <details>
              <summary class="small muted">查看提示詞內容</summary>
              <pre class="pre">{CONVERSION_PROMPT}</pre>
            </details>
            <textarea rows={8} placeholder="貼上 AI 回覆的 JSON…" value={aiText} onInput={(e) => setAiText((e.target as HTMLTextAreaElement).value)} />
            <button class="btn primary" disabled={!aiText.trim()} onClick={importAi}>
              匯入題目 →
            </button>
            <p class="small muted">適合手寫、數學公式、排版複雜的考卷，辨識品質最好。</p>
          </div>
        )}

        {busy && (
          <div class="busy">
            <div class="spinner" />
            <div class="grow">
              <div class="small">{busy.msg}</div>
              {busy.ratio !== undefined && (
                <div class="progressbar inline">
                  <div style={{ width: `${Math.round(busy.ratio * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}
        {error && <div class="alert bad">⚠️ {error}</div>}

        {tab !== 'ai' && (text || tab === 'paste') && (
          <div class="raw-text">
            {tab === 'scan' && <p class="small"><b>辨識結果</b>：請檢查並修正明顯錯字（特別是題號、(A)(B) 選項標號、答案），再按「解析成題目」。</p>}
            <textarea rows={14} value={text} placeholder="在這裡貼上題目文字…" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
            <div class="row">
              <button class="btn ghost" disabled={!text} onClick={() => setText('')}>
                清除
              </button>
              <div class="spacer" />
              <button class="btn primary big" disabled={!text.trim() || !!busy} onClick={parse}>
                解析成題目 →
              </button>
            </div>
          </div>
        )}

        {!appending && (
          <p class="small muted center">
            或者
            <button class="link" onClick={() => onImported([], undefined, [])}>
              從空白開始手動出題
            </button>
          </p>
        )}
      </section>
    </main>
  );
}

