import { serializeOlt, type Quiz } from './olt';
import { downloadText, safeFileName } from './util';

export const DATA_TAG_RE = /<script id="olt-data" type="application\/json">[\s\S]*?<\/script>/;

export function downloadOlt(quiz: Quiz, hideAnswers: boolean): void {
  downloadText(`${safeFileName(quiz.meta.title)}.olt`, serializeOlt(quiz, { hideAnswers }), 'application/json');
}

/** 把題目塞進自帶 UI 的離線播放器 HTML（任何裝置雙擊即可作答） */
export function buildStandaloneHtml(template: string, quiz: Quiz, hideAnswers: boolean): string {
  if (!DATA_TAG_RE.test(template)) throw new Error('離線播放器範本不完整');
  const json = serializeOlt(quiz, { hideAnswers })
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  const title = quiz.meta.title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  return template
    .replace(DATA_TAG_RE, () => `<script id="olt-data" type="application/json">${json}</script>`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${title}｜OLT 線上測驗</title>`);
}

export async function downloadStandalone(quiz: Quiz, hideAnswers: boolean): Promise<void> {
  const res = await fetch(new URL('player.html', document.baseURI).href, { cache: 'no-cache' });
  if (!res.ok) throw new Error('無法取得離線播放器（請確認網路連線）');
  const html = buildStandaloneHtml(await res.text(), quiz, hideAnswers);
  downloadText(`${safeFileName(quiz.meta.title)}.olt.html`, html, 'text/html');
}
