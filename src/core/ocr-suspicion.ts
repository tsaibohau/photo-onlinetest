// 找出 OCR 可能認錯的片段：中文題目裡夾雜的無意義英文字串、怪符號

// 中文考卷裡常見、不該被當成錯誤的英文縮寫
const ALLOW = new Set(
  'DNA RNA ATP ADP GPS USB CPU LED LCD UFO CEO NBA WHO NASA AIDS HIV SARS COVID APP PDF HTML WIFI ABC XYZ mRNA tRNA pH'
    .split(' ')
    .map((s) => s.toLowerCase()),
);
const CJK = /[一-鿿]/g;
const WORD = /[A-Za-z]{3,}/g;
const SYMBOL = /[©®¦|~^`_]+|={2,}/g;

/** 回傳可疑片段（不重複）。沒有中文的文字（例如英文題目）不檢查英文字。 */
export function findSuspicious(text: string): string[] {
  const cjk = text.match(CJK)?.length ?? 0;
  const out = new Set<string>();
  if (cjk >= 3) {
    for (const w of text.match(WORD) ?? []) {
      if (ALLOW.has(w.toLowerCase())) continue;
      // 化學式、單位（NaCl、KMnO、Hz）：由元素符號組成且含小寫，放過
      if (w.length <= 8 && /[a-z]/.test(w) && /^([A-Z][a-z]?)+$/.test(w)) continue;
      out.add(w);
    }
  }
  for (const s of text.match(SYMBOL) ?? []) out.add(s);
  return [...out];
}

/** 移除可疑片段並整理空白 */
export function removeSuspicious(text: string, tokens: string[]): string {
  let t = text;
  for (const tok of tokens) t = t.split(tok).join(' ');
  return t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?([，。？！、；：,.?!;:]) ?/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}
