// A synthetic event floor map, for trying the free path without a camera.
export function drawSampleMap() {
  const W = 1600, H = 1000;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#222';
  g.lineWidth = 8;
  g.strokeRect(20, 20, W - 40, H - 40);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const booth = (x, y, w, h, label, sub) => {
    g.fillStyle = '#f4f4f4';
    g.fillRect(x, y, w, h);
    g.lineWidth = 5;
    g.strokeRect(x, y, w, h);
    g.fillStyle = '#111';
    g.font = 'bold 44px "Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif';
    g.fillText(label, x + w / 2, y + h / 2 - (sub ? 26 : 0));
    if (sub) {
      g.font = '34px "Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif';
      g.fillText(sub, x + w / 2, y + h / 2 + 30);
    }
  };
  const cols = [140, 560, 980];
  const names = [
    ['A1', '手作皮件'], ['A2', '陶藝工坊'], ['A3', '植物小舖'],
    ['B1', '咖啡餐車'], ['B2', '服務台'], ['B3', '二手書攤'],
  ];
  names.forEach(([code, name], i) => {
    const x = cols[i % 3];
    const y = i < 3 ? 160 : 560;
    booth(x, y, 300, 260, code, name);
  });
  booth(1400, 160, 140, 260, '廁所');
  // entrance marker on the bottom wall
  g.fillStyle = '#fff';
  g.fillRect(100, H - 40, 220, 40);
  g.fillStyle = '#c00';
  g.font = 'bold 44px "Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif';
  g.fillText('入口', 210, H - 90);
  g.font = 'bold 40px sans-serif';
  g.fillStyle = '#111';
  g.fillText('2026 春季手作市集', W / 2, 80);
  return c;
}
