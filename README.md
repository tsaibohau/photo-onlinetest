# PhotoPath（`.phop`）

拍下現場的導覽圖／樓層圖，變成可以導航的 `.phop` 檔案。不用 GPS、不用布建硬體。

## 文件

- [`PhotoPath_phop企劃書.md`](PhotoPath_phop企劃書.md)：企劃書 v0.2（2026-11-19，目前版本）
- [`docs/封存/PhotoPath_phop企劃書_v0.1.md`](docs/封存/PhotoPath_phop企劃書_v0.1.md)：舊版 v0.1
- 變更日誌與 `docs/plans/` 尚未搬入（日誌含真實導覽圖照片，不放公開 repo）。

## 網站（`site/`）

純靜態網站（無建置步驟），從 Google Drive `我的雲端硬碟/PhotoPath/phop/site` 搬入（雲端最後修改 2026-11-22）。

| 頁面 | 用途 |
|---|---|
| `index.html` | 首頁 |
| `create.html` | 建立 `.phop`（含 Tesseract OCR 辨識） |
| `view.html` | 開啟 `.phop` 導航 |
| `editor.html` | 地圖編輯器 |
| `survey.html` | 走一圈畫室內地圖 |

- `js/`：36 個 ES 模組；`css/style.css`：樣式。
- `_headers`：Cloudflare Pages 標頭設定（`.phop` 的 Content-Type）。
- 外部函式庫從 jsDelivr 載入：JSZip 3.10.1、Tesseract.js 5.1.1。

### 本機執行

```bash
cd site
python3 -m http.server 8000
# 開 http://localhost:8000
```

ES 模組不能用 `file://` 直接開，一定要透過 HTTP 伺服器。
