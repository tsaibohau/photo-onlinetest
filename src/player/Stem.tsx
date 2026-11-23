// 題目文字顯示：「【附表】」後面以「｜」分隔的連續行畫成表格，其餘保持原樣（保留換行）
export function Stem({ text, class: cls = 'q-stem' }: { text: string; class?: string }) {
  const lines = text.split('\n');
  const parts: ({ kind: 'text'; text: string } | { kind: 'table'; rows: string[][] })[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '【附表】' && lines[i + 1]?.includes('｜')) {
      const rows: string[][] = [];
      while (lines[i + 1]?.includes('｜')) rows.push(lines[++i].split('｜').map((c) => c.trim()));
      parts.push({ kind: 'table', rows });
    } else {
      const last = parts[parts.length - 1];
      if (last?.kind === 'text') last.text += `\n${lines[i]}`;
      else parts.push({ kind: 'text', text: lines[i] });
    }
  }
  return (
    <div class={cls}>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i} class="stem-text">
            {p.text}
          </span>
        ) : (
          <div key={i} class="stem-table-wrap">
            <table class="stem-table">
              <thead>
                <tr>
                  {p.rows[0].map((c, j) => (
                    <th key={j}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.rows.slice(1).map((r, k) => (
                  <tr key={k}>
                    {r.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}
