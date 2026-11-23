import { useEffect, useState } from 'preact/hooks';
import { parseQuestionsFromText } from '../core/text-parser';
import { docxToText, ocrImage, OCR_LANGS, pdfToText, type OcrLang } from '../core/importers';
import { docText, documentImages, odtText, pagesPreview, pptxText, sniffBytes, UNSUPPORTED_HELP } from '../core/formats';
import { CONVERSION_PROMPT, parseAiJson, proofreadPrompt } from '../core/ai-import';
import { maskedCanvas, type Rect, type SourcePhoto } from '../core/photo';
import { PhotoTool } from '../components/PhotoTool';
import { parseOlt, type Question, type Quiz } from '../core/olt';
import { copyText, storageGet, storageSet } from '../core/util';

interface Props {
  onBack: () => void;
  /** 匯入完成：題目 + 可能的標題 + 警告 */
  onImported: (questions: Question[], title: string | undefined, warnings: string[], meta?: Quiz['meta']) => void;
  appending: boolean;
  /** 上傳過的照片（之後在編輯器可以截圖當附圖） */
  sources: SourcePhoto[];
  onSourcesChange: (s: SourcePhoto[]) => void;
  /** 從首頁轉過來、要直接處理的檔案 */
  pendingFiles?: File[];
  onPendingDone?: () => void;
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

export function Create({ onBack, onImported, appending, sources, onSourcesChange, pendingFiles, onPendingDone }: Props) {
  const [tab, setTab] = useState<Tab>('scan');
  const [text, setText] = useState('');
  const [lang, setLang] = useState<OcrLang>(() => storageGet<OcrLang>('olt-ocr-lang') ?? 'chi_tra+eng');
  const [busy, setBusy] = useState<{ msg: string; ratio?: number } | null>(null);
  const [error, setError] = useState('');
  const [aiText, setAiText] = useState('');
  const [copied, setCopied] = useState(false);
  const [drag, setDrag] = useState(false);
  const [masking, setMasking] = useState<number | null>(null);
  const [notice, setNotice] = useState('');

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setError('');
    const list = [...files];
    let acc = text;
    const added: SourcePhoto[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ${f.name}：` : '';
        const progress = (msg: string, ratio?: number) => setBusy({ msg: prefix + msg, ratio });
        const bytes = new Uint8Array(await f.arrayBuffer());
        const fmt = await sniffBytes(bytes, f.name);
        progress(`讀取${fmt.label}`);
        let out = '';
        const addPhoto = (blob: Blob, text: string) =>
          added.push({
            id: `${Date.now()}-${i}-${added.length}`,
            name: f.name || `照片 ${sources.length + added.length + 1}`,
            url: URL.createObjectURL(blob),
            text,
            masks: [],
          });
        switch (fmt.kind) {
          case 'olt':
          case 'json': {
            const raw = new TextDecoder().decode(bytes);
            const quiz = fmt.kind === 'olt' ? parseOlt(raw) : parseAiJson(raw);
            setBusy(null);
            onImported(quiz.questions, quiz.meta.title, [], quiz.meta);
            return;
          }
          case 'image':
          case 'heic':
            try {
              out = await ocrImage(f, lang, progress);
            } catch (err) {
              if (fmt.kind === 'heic')
                throw new Error('這個瀏覽器無法讀取 HEIC 照片。請用 iPhone 的 Safari 開啟本網站，或把照片截圖／轉成 JPG 後再上傳。');
              throw err;
            }
            addPhoto(f, out);
            break;
          case 'pdf':
            out = await pdfToText(f, lang, progress);
            break;
          case 'docx':
            out = await docxToText(f, progress);
            break;
          case 'doc':
            out = await docText(bytes);
            break;
          case 'pptx':
            out = await pptxText(bytes);
            break;
          case 'odt':
            out = await odtText(bytes);
            break;
          case 'pages': {
            const pv = await pagesPreview(bytes);
            if (pv.pdf) out = await pdfToText(new Blob([pv.pdf as BlobPart], { type: 'application/pdf' }), lang, progress);
            else if (pv.image) {
              const blob = new Blob([pv.image as BlobPart]);
              out = await ocrImage(blob, lang, progress);
              addPhoto(blob, out);
              setNotice('ℹ️ Pages 檔只內含低解析度預覽圖，辨識效果有限；建議在 Pages 裡「輸出 → PDF」後再上傳。');
            } else throw new Error(`這個 Pages 檔沒有內含預覽，無法讀取。${UNSUPPORTED_HELP}`);
            break;
          }
          case 'text': {
            // 台灣常見的 Big5 編碼文字檔：UTF-8 解碼失敗時改用 Big5
            try {
              out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
              out = new TextDecoder('big5').decode(bytes);
            }
            break;
          }
          default:
            throw new Error(`「${f.name}」是${fmt.label}，目前無法直接讀取。${UNSUPPORTED_HELP}`);
        }
        if (['doc', 'docx', 'pptx', 'odt'].includes(fmt.kind)) {
          const imgs = await documentImages(fmt.kind, bytes);
          imgs.forEach((im, k) =>
            added.push({
              id: `${Date.now()}-${i}-img${k}`,
              name: `${f.name.replace(/\.[^.]+$/, '')} 圖 ${k + 1}`,
              url: URL.createObjectURL(new Blob([im.bytes as BlobPart], { type: im.mime })),
              text: '',
              masks: [],
              kind: 'docimage',
            }),
          );
          if (imgs.length) setNotice(`🖼 已從文件取出 ${imgs.length} 張圖片，解析後可在編輯器用「✂️ 選取附圖」放進對應的題目。`);
        }
        if (!out.trim()) throw new Error(`「${f.name}」裡沒有讀到文字。如果是掃描檔或圖片型文件，請改用拍照或截圖上傳。`);
        acc = acc ? `${acc}\n${out}` : out;
        setText(acc);
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      setError(/fetch|network|load/i.test(msg) ? `${msg}（OCR 第一次使用需要網路下載辨識模型）` : msg);
    } finally {
      setBusy(null);
      if (added.length) onSourcesChange([...sources, ...added]);
    }
  };

  useEffect(() => {
    if (pendingFiles?.length) {
      handleFiles(pendingFiles);
      onPendingDone?.();
    }
  }, [pendingFiles]);

  const remask = async (i: number, rects: Rect[]) => {
    setMasking(null);
    const src = sources[i];
    setError('');
    try {
      const canvas = await maskedCanvas(src.url, rects);
      const out = await ocrImage(canvas, lang, (msg, ratio) => setBusy({ msg: `重新辨識「${src.name}」：${msg}`, ratio }));
      onSourcesChange(sources.map((s, j) => (j === i ? { ...s, text: out, masks: rects } : s)));
      if (src.text && text.includes(src.text)) {
        setText(text.replace(src.text, out));
        setNotice('✅ 已用遮蓋後的照片重新辨識，並替換原本的辨識結果。');
      } else {
        setText(text ? `${text}\n${out}` : out);
        setNotice('ℹ️ 你修改過辨識文字，新的結果已附加在最後面，請刪除重複的部分。');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const askAiProofread = async () => {
    const ok = await copyText(proofreadPrompt(text));
    setTab('ai');
    setNotice(
      ok
        ? '📋 已複製「校正錯字」提示詞！貼給你的 AI（建議同時上傳考卷照片），再把 AI 回覆的 JSON 貼到下面。'
        : '⚠️ 複製失敗，請改用下方「複製轉檔提示詞」。',
    );
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
              <p class="small muted">支援：照片、PDF（含掃描檔）、Word（.docx／.doc）、PowerPoint（.pptx）、Pages、ODT、文字檔、.olt</p>
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
            {sources.some((s) => s.kind !== 'docimage') && (
              <div class="sources">
                <p class="small">
                  <b>已上傳的照片</b>：附圖會干擾辨識，可以把圖框起來重新辨識；之後在編輯器也能從這些照片截取附圖。
                </p>
                <div class="source-list">
                  {sources.map((s, i) => s.kind === 'docimage' ? null : (
                    <div class="source-item" key={s.id}>
                      <img src={s.url} alt={s.name} />
                      <div class="small source-name">{s.name}</div>
                      <button class="btn small" disabled={!!busy} onClick={() => setMasking(i)}>
                        🩹 遮住附圖再辨識{s.masks.length ? `（${s.masks.length}）` : ''}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
        {notice && <div class="alert info">{notice}</div>}

        {tab !== 'ai' && (text || tab === 'paste') && (
          <div class="raw-text">
            {tab === 'scan' && <p class="small"><b>辨識結果</b>：請檢查並修正明顯錯字（特別是題號、(A)(B) 選項標號、答案），再按「解析成題目」。</p>}
            <textarea rows={14} value={text} placeholder="在這裡貼上題目文字…" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
            <div class="row">
              <button class="btn ghost" disabled={!text} onClick={() => setText('')}>
                清除
              </button>
              <div class="spacer" />
              {sources.some((s) => s.kind !== 'docimage') && (
                <button class="btn" disabled={!text.trim() || !!busy} onClick={askAiProofread} title="錯字很多時，讓你的 AI 對照照片校正">
                  🤖 請 AI 校正錯字
                </button>
              )}
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
      {masking !== null && sources[masking] && (
        <PhotoTool
          sources={sources}
          initialIndex={masking}
          mode="mask"
          initialRects={sources[masking].masks}
          onCancel={() => setMasking(null)}
          onDone={(i, rects) => remask(i, rects)}
        />
      )}
    </main>
  );
}

