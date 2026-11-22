# 📝 OLT 線上測驗

拍一張考卷 → 變成互動線上測驗 → 交卷後一鍵產生 AI 解析提示詞。

- **出題**：拍照或上傳圖片／PDF（含掃描檔）／Word／文字檔，瀏覽器端 OCR（Tesseract.js）辨識後自動解析成題目；也可貼上文字，或用自己的 AI 轉檔。
- **題型**：單選、多選（全對／部分給分）、是非、簡答；可附圖、設配分、解析、時間限制、題序隨機。
- **`.olt` 檔**：JSON 格式的測驗檔，可選「隱藏答案」。另可匯出 **`.olt.html` 離線版**，任何裝置雙擊即可作答。
- **交卷**：自動計分、作答回顧，並產生三種模式的 AI 提示詞（重點錯題／全部詳解／弱點分析），可一鍵複製或直接用 ChatGPT、Claude、Gemini 開啟。
- **隱私**：所有處理都在瀏覽器中完成，不會上傳任何檔案。

計劃書見 [`docs/PLAN.md`](docs/PLAN.md)。

## 開發

```bash
npm install
npm run dev        # 本機開發 http://localhost:5173
npm test           # 單元測試
npm run build      # 產出 dist/（含 player.html 離線播放器範本）
```

🌐 **正式網址**：https://photo-onlinetest.park-3d-nav.workers.dev

## 部署（GitHub → Cloudflare）

**直接部署（目前使用）**：`CLOUDFLARE_API_TOKEN=… npm run deploy:embedded`
— 把 `dist/` 全部內嵌進單一 Worker 腳本後上傳（`wrangler.embedded.toml`）。

**GitHub 連動自動部署（建議長期使用）**：

1. Cloudflare 後台 → **Workers & Pages → Create → Import a repository**，選 `photo-onlinetest`。
2. Build command：`npm run build`；Deploy command：`npx wrangler deploy`（設定已在 `wrangler.toml`）。
3. 之後每次 push：`main` 自動部署正式站，其他分支產生預覽網址。

## 專案結構

```
src/core/       與 UI 無關的邏輯（.olt 格式、文字解析、OCR/PDF/Word 匯入、計分、提示詞）
src/pages/      首頁、建立（匯入）、編輯器
src/player/     作答與結果頁（主站與離線版共用）
player.html     離線播放器入口，打包成單一 HTML 作為 .olt.html 範本
public/         PWA manifest（.olt 檔案關聯）、service worker、範例測驗
```
