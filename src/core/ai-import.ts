// 「用自己的 AI 轉檔」：給使用者一段提示詞，請 AI 把照片/文件轉成 .olt JSON，再貼回來匯入
import { validateQuiz, newQuiz, OltError, type Quiz } from './olt';

export const CONVERSION_PROMPT = `請把我附上的考卷（照片或文件）中的所有題目，轉換成下面這個 JSON 格式。規則：
- 只輸出 JSON，不要任何說明文字。
- type 只能是 "single"（單選）、"multiple"（多選）、"truefalse"（是非）、"short"（簡答/問答/填充）。
- options 是選項文字陣列，不要包含 (A)(B) 等標號；是非題與簡答題的 options 給 []。
- answer 是正確選項的索引陣列（A=0, B=1…；是非題 O=0, X=1）。考卷上沒有答案就給 []，不要自己猜。
- 簡答題若考卷上有參考答案，放在 "reference"。
- points 是配分，看不出來就給 1。
- 題目文字請完整保留，數學式可用文字表示（例如 x^2、√2）。

{
  "format": "olt",
  "version": 1,
  "meta": { "title": "測驗名稱", "subject": "科目" },
  "questions": [
    { "id": "q1", "type": "single", "stem": "題目", "options": ["選項1", "選項2", "選項3", "選項4"], "answer": [0], "points": 1 },
    { "id": "q2", "type": "short", "stem": "題目", "options": [], "answer": [], "reference": "參考答案", "points": 5 }
  ]
}`;

/** 解析 AI 回傳內容：容忍 \`\`\`json 圍欄、前後廢話、只給 questions 陣列 */
export function parseAiJson(text: string): Quiz {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new OltError('找不到 JSON 內容，請確認有貼上 AI 的完整回覆。');
  const open = t[start];
  const end = t.lastIndexOf(open === '{' ? '}' : ']');
  t = t.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    throw new OltError('JSON 格式有誤（可能被截斷），請請 AI 重新輸出完整 JSON。');
  }
  if (Array.isArray(raw)) raw = { ...newQuiz(), questions: raw };
  return validateQuiz(raw);
}

/** OCR 文字錯字多時，請使用者自己的 AI 校正並直接轉成 JSON */
export function proofreadPrompt(ocrText: string): string {
  return `下面是用 OCR 從考卷照片辨識出來的文字，裡面有不少錯字、亂碼與漏字（例如「板直」應為「板塊」、作答括號被認成 CL / C02 之類）。
如果我有附上考卷照片，請以照片為準；沒有照片就依上下文合理校正。

${CONVERSION_PROMPT}

【OCR 辨識文字】
${ocrText.trim()}
`;
}
