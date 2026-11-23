// 純文字（含 OCR 結果）→ 題目。容錯優先：解析不了的內容保留在題幹裡，交給使用者在編輯器修正。
import { newId, TRUEFALSE_OPTIONS, type Question, type QuestionType } from './olt';

export interface ParseResult {
  title?: string;
  questions: Question[];
  warnings: string[];
}

const FULL_TO_HALF: Record<string, string> = {
  '（': '(', '）': ')', '．': '.', '：': ':', '，': ',', '；': ';', '　': ' ',
  '〔': '(', '〕': ')', '［': '[', '］': ']', '﹙': '(', '﹚': ')', '﹝': '(', '﹞': ')',
};
const CIRCLED = '①②③④⑤⑥';

/** 全形英數 → 半形、常見標點統一、移除 OCR 在中文字之間插入的空白 */
export function normalizeText(s: string): string {
  let t = s.replace(/\r\n?/g, '\n');
  t = t.replace(/[！-～]/g, (c) => {
    const half = String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    return /[0-9A-Za-z]/.test(half) ? half : FULL_TO_HALF[c] ?? c;
  });
  t = t.replace(/[（）．：，；　〔〕［］﹙﹚﹝﹞]/g, (c) => FULL_TO_HALF[c] ?? c);
  t = t.replace(/[○〇◯]/g, 'O').replace(/[×✕✗╳]/g, 'X');
  // OCR 常在中文字之間插入空白（「下 列 何 者」）。只在「大多數中文字都被空白隔開」的行才移除，
  // 避免把正常輸入的「國二自然 期中練習」也黏在一起。
  const cjk = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef';
  const gap = new RegExp(`([${cjk}])[ \\t]+(?=[${cjk}])`, 'g');
  const cjkChar = new RegExp(`[${cjk}]`, 'g');
  t = t
    .split('\n')
    .map((line) => {
      const gaps = line.match(gap)?.length ?? 0;
      const chars = line.match(cjkChar)?.length ?? 0;
      return gaps >= 2 && gaps >= chars * 0.25 ? line.replace(gap, '$1') : line;
    })
    .join('\n');
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

interface Draft {
  stem: string;
  options: string[];
  numericOptions: boolean;
  answerRaw?: string;
  reference?: string;
  sectionType?: QuestionType;
  points?: number;
  no: number;
}

const SECTION_RE = /^([一二三四五六七八九十]+|[IVX]+)\s*[、.]\s*(.*)$/;
// 行首：可選的作答括號 (B) 或 ( )，接著題號
const Q_START_RE = /^(?:\(\s*([A-Ea-eOX]{0,5}|[1-5]{0,5})\s*\)\s*)?(?:第\s*)?(\d{1,3})\s*(?:題)?\s*([.、:)]|\s(?=\S))\s*(.*)$/;
const INLINE_ANS_RE = /(?:^|[\s(\[])(?:答案|解答|正解|答|ans(?:wer)?)\s*[:：]\s*([A-Ea-e](?:\s*[,、]?\s*[A-Ea-e])*|[OX]|對|錯|[1-5](?:\s*[,、]?\s*[1-5])*)\s*[)\]]?\s*$/i;
const REF_RE = /^(?:參考答案|參考解答|答案|解答|ans(?:wer)?)\s*[:：]\s*(.+)$/i;
const KEY_HEADER_RE = /^(?:答案|解答|參考答案|answer\s*key|answers?)\s*[:：]?\s*$/i;
const KEY_PAIR_RE = /(\d{1,3})\s*[.、:\-)]?\s*([A-Ea-e]{1,5}|[OX])(?![A-Za-z])/g;

function sectionType(text: string): QuestionType | undefined {
  if (/多選|複選/.test(text)) return 'multiple';
  if (/是非|判斷|對錯|true\s*\/?\s*false/i.test(text)) return 'truefalse';
  if (/單選|選擇/.test(text)) return 'single';
  if (/簡答|問答|申論|非選|填充|填空|計算|說明/.test(text)) return 'short';
  return undefined;
}

function sectionPoints(text: string): number | undefined {
  const m = text.match(/每題\s*(\d+(?:\.\d+)?)\s*分/);
  return m ? Number(m[1]) : undefined;
}

interface Marker {
  pos: number;
  end: number;
  idx: number;
  numeric: boolean;
}

/** 找出一行中的選項標記，必須依序（從 expectStart 開始連號）才算數 */
interface Candidate extends Marker {
  /** 由 OCR 常見誤認推測而來（例如 (8)→(B)、COD)→(D)），只在剛好是下一個預期選項時才採用 */
  fuzzy: boolean;
}

// OCR 常見誤認：(8)=B、(4=A、COD)/(0)=D、右括號遺失「(CP 波」=(C)P
const FUZZY_RE = /\(\s*8\s*\)|\(4(?=\s)|(?:\bCO|\bC|\()[D0O]\)|\(([A-E])(?=[A-Za-z一-鿿]|\s*$)/g;

/** 找出一行中的選項標記，必須依序（從 expectStart 開始連號）才算數 */
function findOptionMarkers(
  line: string,
  expectStart: number,
  numericMode: boolean | undefined,
  allowLostA = false,
): Marker[] {
  const cands: Candidate[] = [];
  const re = /\(\s*([A-Ea-e]|[1-6])\s*\)|(?<![A-Za-z0-9])([A-E])\s*[.、)](?!\d)|([①②③④⑤⑥])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    let idx: number;
    let numeric = false;
    if (m[1]) {
      if (/[1-6]/.test(m[1])) {
        idx = Number(m[1]) - 1;
        numeric = true;
      } else idx = m[1].toUpperCase().charCodeAt(0) - 65;
    } else if (m[2]) idx = m[2].charCodeAt(0) - 65;
    else {
      idx = CIRCLED.indexOf(m[3]);
      numeric = true;
    }
    cands.push({ pos: m.index, end: m.index + m[0].length, idx, numeric, fuzzy: false });
  }
  if (numericMode !== true) {
    while ((m = FUZZY_RE.exec(line))) {
      const pos = m.index;
      if (cands.some((c) => pos < c.end && pos + m![0].length > c.pos)) continue;
      const t = m[0];
      const idx = m[1] ? m[1].charCodeAt(0) - 65 : t.includes('8') ? 1 : t.startsWith('(4') ? 0 : 3;
      cands.push({ pos, end: pos + t.length, idx, numeric: false, fuzzy: true });
    }
    cands.sort((a, b) => a.pos - b.pos);
  }
  const out: Marker[] = [];
  let want = expectStart;
  let mode = numericMode;
  for (const c of cands) {
    if (mode !== undefined && c.numeric !== mode) continue;
    if (c.idx === want) {
      mode = c.numeric;
      out.push(c);
      want++;
    } else if (
      allowLostA &&
      want === 0 &&
      out.length === 0 &&
      (c.idx === 1 || (c.idx === 2 && !c.fuzzy)) &&
      !c.numeric &&
      numericMode !== true &&
      line.slice(0, c.pos).trim().length > 0 &&
      line.slice(0, c.pos).trim().length <= (c.idx === 1 ? 12 : 40)
    ) {
      // 行首的 (A)/(B) 被 OCR 吃掉（如「AER (8) 喜馬拉雅山」）：前面的文字當作緊鄰的上一個選項，
      // 更前面遺失的選項留空白讓使用者補
      mode = false;
      for (let k = 0; k < c.idx - 1; k++) out.push({ pos: 0, end: 0, idx: k, numeric: false });
      out.push({ pos: 0, end: 0, idx: c.idx - 1, numeric: false });
      out.push(c);
      want = c.idx + 1;
    } else if (!c.numeric && mode === false && c.idx === want + 1 && (out.length > 0 || expectStart > 0)) {
      // 中間漏認一個選項（例如 (C) 被 OCR 吃掉）：補一個空白選項，讓使用者在編輯器補上
      out.push({ pos: c.pos, end: c.pos, idx: want, numeric: false });
      out.push(c);
      want += 2;
    }
  }
  return out;
}

const DIGITISH: Record<string, string> = { '&': '8', S: '5', s: '5', l: '1', I: '1', '|': '1', O: '0', o: '0', Z: '2', g: '9' };
// 「( )」作答括號被 OCR 認錯的各種樣子：CL、C02、CD) 5、C0 7、C6、(9、( )&、(” ) 10.
const JUNK_NUM_RE = /^(?:\(\s*["”“'’`.,:;_]*\s*\)|\(\s*(?=[\d&])|C[0oOD]?\)?(?=\s*[\d&])|CD\)|C[0oO]D\))\s*([\d&SlI|OoZg]?\d|[\d&])\s*[.、,:)]?\s*(.*)$/;
const JUNK_NONUM_RE = /^(?:\(\s*["”“'’`]*\s*\)|C[LlIJ])\s+(?=[一-鿿])(.*)$/;

/** 修復 OCR 把題號前作答括號認錯的行，改寫成標準的「N. 題目」 */
export function repairOcrQuestionStarts(text: string): string {
  let last = 0;
  return text
    .split('\n')
    .map((line) => {
      const std = line.match(/^(?:\(\s*[A-Ea-eOX]{0,5}\s*\)\s*)?(\d{1,3})\s*[.、]/);
      if (std) {
        const n = Number(std[1]);
        if (last === 0 || n === last + 1 || (n > last && n - last <= 3)) last = n;
        return line;
      }
      // (1)(2)… 是數字選項，不是題號
      const j = /^\(\s*\d{1,2}\s*\)/.test(line) ? null : line.match(JUNK_NUM_RE);
      if (j) {
        const n = Number([...j[1]].map((c) => DIGITISH[c] ?? c).join(''));
        const strict = /^C/.test(line);
        if (n === last + 1 || (last === 0 && n <= 3) || (!strict && n > last && n - last <= 2)) {
          last = n;
          return `( ) ${n}. ${j[2]}`;
        }
        return line;
      }
      // 題號完全認不出（如「《 7 上根折板塊…？ (A)…」）：開頭是括號類雜訊、且同一行有問號與 (A)
      const lost = line.match(/^[《〈(（C\[]\s*[^\u4e00-\u9fff]{0,4}(?=[\u4e00-\u9fff])(.*[?？].*\(\s*A\s*\).*)$/);
      if (lost && !/^\(\s*[A-E]\s*\)/.test(line)) {
        last += 1;
        return `( ) ${last}. ${lost[1]}`;
      }
      const k = line.match(JUNK_NONUM_RE);
      if (k) {
        last += 1;
        return `( ) ${last}. ${k[1]}`;
      }
      return line;
    })
    .join('\n');
}

function lettersToIdx(raw: string, numeric: boolean): number[] {
  const res: number[] = [];
  for (const ch of raw.replace(/[\s,、]/g, '')) {
    if (/[A-Za-z]/.test(ch) && !/[OXox]/.test(ch)) res.push(ch.toUpperCase().charCodeAt(0) - 65);
    else if (/[1-6]/.test(ch) && numeric) res.push(Number(ch) - 1);
  }
  return [...new Set(res)].sort((a, b) => a - b);
}

/** 標題要像樣：至少 4 個中文字（或 3 個英文單字），且大部分是正常文字（排除「得分」、OCR 雜訊） */
function looksLikeTitle(line: string): boolean {
  const cjk = line.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const visible = line.replace(/\s/g, '').length;
  if (cjk >= 4) return cjk / visible >= 0.6;
  const realWords = line.split(/\s+/).filter((w) => /^[A-Za-z]{3,}$/.test(w) && /[aeiouAEIOU]/.test(w)).length;
  return cjk === 0 && /^[A-Za-z0-9][A-Za-z0-9 ,.:'&()-]{2,}$/.test(line) && realWords >= 2;
}

export function parseQuestionsFromText(input: string): ParseResult {
  const text = repairOcrQuestionStarts(normalizeText(input));
  const lines = text.split('\n');
  const warnings: string[] = [];
  const drafts: Draft[] = [];
  const keyMap = new Map<number, string>();
  let cur: Draft | null = null;
  let curSection: QuestionType | undefined;
  let curPoints: number | undefined;
  let inKey = false;
  let title: string | undefined;
  let lastWasOption = false;

  const appendStem = (d: Draft, s: string) => {
    d.stem = d.stem ? `${d.stem}\n${s}` : s;
  };

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    if (KEY_HEADER_RE.test(line)) {
      inKey = true;
      cur = null;
      continue;
    }
    // 答案表：一行有 2 組以上「題號+答案」且沒有其他文字
    // 「答案：1.D 2.C 3.B」：先拿掉標籤再判斷
    const keyBody = line.replace(/^(?:答案|解答|參考答案|answers?|answer\s*key)\s*[:：]?\s*/i, '');
    const pairs = [...keyBody.matchAll(KEY_PAIR_RE)];
    const leftover = keyBody.replace(KEY_PAIR_RE, '').replace(/[\s,，、;；|]/g, '');
    if ((inKey && pairs.length >= 1 && leftover.length <= 2) || (pairs.length >= 2 && leftover.length === 0)) {
      pairs.forEach((p) => keyMap.set(Number(p[1]), p[2]));
      cur = null;
      continue;
    }
    if (inKey) continue;

    const sec = line.match(SECTION_RE);
    if (sec && (sectionType(sec[2]) || /題/.test(sec[2]))) {
      curSection = sectionType(sec[2]);
      curPoints = sectionPoints(sec[2]);
      cur = null;
      continue;
    }

    const qm = line.match(Q_START_RE);
    // 「(1)」這種全括號數字視為選項，不當作題號
    const looksLikeNumOption = /^\(\s*\d\s*\)/.test(line) && !/^\(\s*\d{1,5}\s*\)\s*\d{1,3}\s*[.、]/.test(line);
    const expectedNo: number = cur ? (cur as Draft).no + 1 : drafts.length + 1;
    const qNo = qm ? Number(qm[2]) : NaN;
    // 防止選項或內文中的數字被誤判成新題：題號需與預期相符或相近
    // 有作答括號前綴時，題號後必須是標點（避免「(A) 2 (B) 3」被當成第 2 題）
    const prefixNeedsPunct = qm && !!qm[1] && !/[.、:)]/.test(qm[3]);
    const plausible = qm && !looksLikeNumOption && !prefixNeedsPunct && (qNo === expectedNo || (qNo > 0 && Math.abs(qNo - expectedNo) <= 3) || !cur);
    if (qm && plausible && !(cur && lastWasOption && qNo !== expectedNo)) {
      cur = {
        stem: '',
        options: [],
        numericOptions: false,
        no: qNo,
        sectionType: curSection,
        points: curPoints,
        answerRaw: qm[1] ? qm[1] : undefined,
      };
      drafts.push(cur);
      line = qm[4] ?? '';
      lastWasOption = false;
      if (!line) continue;
    }

    if (!cur) {
      if (drafts.length === 0 && !title && line.length <= 40 && looksLikeTitle(line)) title = line;
      continue;
    }

    // 行內答案「答案：B」
    const am = line.match(INLINE_ANS_RE);
    if (am && cur.options.length > 0) {
      cur.answerRaw = am[1];
      line = line.slice(0, am.index).trim();
      if (!line) continue;
    } else if (cur.options.length === 0) {
      const rm = line.match(REF_RE);
      if (rm) {
        const v = rm[1].trim();
        if (/^([A-Ea-e](\s*[,、]?\s*[A-Ea-e])*|[OX]|對|錯)$/.test(v)) cur.answerRaw = v;
        else cur.reference = cur.reference ? `${cur.reference}\n${v}` : v;
        continue;
      }
    }

    const markers = findOptionMarkers(
      line,
      cur.options.length,
      cur.options.length ? cur.numericOptions : undefined,
      cur.stem.trim().length > 0,
    );
    if (markers.length === 0) {
      if (lastWasOption && cur.options.length) cur.options[cur.options.length - 1] += line;
      else appendStem(cur, line);
      continue;
    }
    const before = line.slice(0, markers[0].pos).trim();
    if (before) {
      if (cur.options.length) cur.options[cur.options.length - 1] += before;
      else appendStem(cur, before);
    }
    if (cur.options.length === 0) cur.numericOptions = markers[0].numeric;
    markers.forEach((mk, i) => {
      const next = markers[i + 1]?.pos ?? line.length;
      cur!.options.push(line.slice(mk.end, next).trim());
    });
    lastWasOption = true;
  }

  const questions: Question[] = drafts.map((d) => {
    const ansRaw = d.answerRaw ?? keyMap.get(d.no);
    const opts = d.options.map((o) => o.replace(/^[\s_|]+|[\s_|]+$/g, ''));
    let type: QuestionType;
    let options: string[] = opts;
    let answer: number[] | undefined;
    const stemTF = /[(（]\s*是非\s*[)）]/.test(d.stem);
    const stemMulti = /[(（]\s*(多選|複選)(題)?\s*[)）]/.test(d.stem);
    const tfAnswer = ansRaw && /^(O|X|對|錯)$/i.test(ansRaw.trim());

    if (opts.length >= 2 && !(d.sectionType === 'truefalse' && opts.length === 2 && tfAnswer)) {
      answer = ansRaw ? lettersToIdx(ansRaw, d.numericOptions).filter((i) => i < opts.length) : undefined;
      type =
        d.sectionType === 'multiple' || stemMulti || (answer && answer.length > 1) ? 'multiple' : 'single';
    } else if (d.sectionType === 'truefalse' || stemTF || tfAnswer) {
      type = 'truefalse';
      if (opts.length === 1) d.stem += ` ${opts[0]}`;
      options = [...TRUEFALSE_OPTIONS];
      if (ansRaw) answer = /^(O|對)$/i.test(ansRaw.trim()) ? [0] : /^(X|錯)$/i.test(ansRaw.trim()) ? [1] : undefined;
    } else {
      type = 'short';
      if (opts.length === 1) d.stem += ` (A)${opts[0]}`;
      options = [];
    }
    const stem = d.stem.replace(/^[(（]\s*(多選|複選|是非|單選)(題)?\s*[)）]\s*/, '').trim();
    if (!stem) warnings.push(`第 ${d.no} 題沒有辨識到題目內容，請手動補上。`);
    if ((type === 'single' || type === 'multiple') && options.some((o) => !o))
      warnings.push(`第 ${d.no} 題有空白選項，請檢查。`);
    return {
      id: newId(),
      type,
      stem,
      options,
      answer: type === 'short' ? undefined : answer,
      reference: type === 'short' ? d.reference : undefined,
      points: d.points ?? 1,
    };
  });

  if (questions.length === 0) warnings.push('沒有辨識到任何題號（例如「1.」「2、」），請確認文字格式，或手動新增題目。');
  return { title, questions, warnings };
}
