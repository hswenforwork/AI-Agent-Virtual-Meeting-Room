# AI 協作室（AI Agent Virtual Meeting Room）

一個瀏覽器聊天室：在同一個對話視窗用 `@Claude`、`@GPT`、`@Gemini` 點名不同 AI 供應商，
針對同一個問題平行比較各家答案；右側搭配記事本、待辦事項與檔案夾（可作為多供應商共享的上下文）。

- 完整規劃與設計決策：[`docs/MVP規劃-v2.md`](docs/MVP規劃-v2.md)
- 原始訪談紀錄：[`brainstorms/2026-09-18-ai-agent-collab-room-mvp.md`](brainstorms/2026-09-18-ai-agent-collab-room-mvp.md)

目前 MVP **只有 Claude（Anthropic API）真正可用**；GPT／Gemini 的介面已經留好，
之後申請到 API key 再啟用即可，不需要改架構。

---

## 給第一次設定的人：整個流程只需要瀏覽器

這個專案假設你平常用**公用電腦、不能安裝軟體**，所以整個開發與部署流程設計成「只靠瀏覽器＋雲端服務」就能完成：

- 寫程式：GitHub 網頁編輯器（按 `.`）或 GitHub Codespaces
- 資料庫／後端：Supabase Dashboard（網頁版）
- 建置與部署：GitHub Actions 自動完成，本機不需要跑 `npm install`

以下步驟**只需要做一次**。

### 步驟 1：建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 註冊、建立一個新專案（Free 方案即可）。
2. 進入專案的 **SQL Editor**，依序貼上並執行：
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_storage.sql`
3. 到 **Project Settings → API**，記下：
   - `Project URL`（等一下是 `VITE_SUPABASE_URL`）
   - `anon public` key（等一下是 `VITE_SUPABASE_ANON_KEY`）
   - `service_role` key（**絕對不要**放進前端或 GitHub，只用在 Edge Function secrets）

### 步驟 2：設定 Edge Function secrets（後端密鑰）

到 Supabase Dashboard 的 **Edge Functions → Manage secrets**（或用 Supabase CLI `supabase secrets set`），設定：

```
ANTHROPIC_API_KEY=你的 Anthropic API key（console.anthropic.com 申請）
SUPABASE_SERVICE_ROLE_KEY=步驟 1 記下的 service_role key
ALLOWED_ORIGINS=https://<你的 github 帳號>.github.io
DEFAULT_CLAUDE_MODEL=claude-sonnet-5
MAX_AGENT_RUNS_PER_MESSAGE=4
```

`SUPABASE_URL` 與 `SUPABASE_ANON_KEY` 這兩個變數 Supabase 平台會自動注入給 Edge Function，不需要手動設定。

### 步驟 3：部署 Edge Functions

如果你有終端機環境（例如短暫開一個 Codespace），用 [Supabase CLI](https://supabase.com/docs/guides/cli) 執行：

```bash
supabase link --project-ref <你的專案 ref>
supabase functions deploy chat-dispatch
supabase functions deploy agent-run
supabase functions deploy approval-decide
supabase functions deploy file-register
```

沒有終端機環境時，也可以在 Supabase Dashboard 的 Edge Functions 頁面手動貼上 `supabase/functions/<name>/index.ts` 的內容建立函式（`_shared/` 底下的檔案要一起帶進去，或改用 Dashboard 的「共用模組」功能）。

### 步驟 4：建立 Storage bucket 權限（已包含在 migration 裡）

`0002_storage.sql` 已經建立了 `room-files` 這個 private bucket 與存取政策，不需要額外操作。

### 步驟 5：設定 GitHub Pages 部署

1. Repo 的 **Settings → Pages**，Source 選 `GitHub Actions`。
2. Repo 的 **Settings → Secrets and variables → Actions → Variables**，新增：
   - `VITE_SUPABASE_URL` = 步驟 1 的 Project URL
   - `VITE_SUPABASE_ANON_KEY` = 步驟 1 的 anon public key
3. Push 到 `main` 後，`.github/workflows/deploy-pages.yml` 會自動建置並部署到
   `https://<你的 github 帳號>.github.io/<repo 名稱>/`。

### 步驟 6：註冊帳號、開始使用

打開部署好的網址，註冊一個帳號即可。第一次登入會自動建立一間「我的協作室」，
裡面已經有三個代理：`Claude`（啟用中）、`GPT`、`Gemini`（尚未啟用，等你申請好對應 API key 再串接）。

---

## 之後要開發／修改程式怎麼辦？

不需要在公用電腦安裝 Node.js。用以下任一方式：

- **小修改**：直接在 GitHub 網頁上編輯檔案，或按 `.` 打開 `github.dev` 線上編輯器。
- **需要跑指令（如 `npm install`、本機預覽）**：開一個 [GitHub Codespaces](https://github.com/features/codespaces)，用完即關閉，不佔用本機空間。
- **建置與部署**：完全交給 GitHub Actions，push 到 `main` 就會自動跑。

## 本機（或 Codespaces）開發指令

```bash
npm install
cp .env.example .env   # 填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev
```

```bash
npm run lint       # ESLint
npm run typecheck  # tsc 型別檢查
npm run build      # 建置到 dist/
```

## 已知限制（MVP 階段）

- 只有 Claude 真正可用；GPT／Gemini 顯示為「未啟用」，等申請到 API key 再實作對應 adapter。
- 檔案文字擷取目前只支援純文字類型（txt/md/csv）；PDF／DOCX／XLSX 會先存檔案但不會擷取內容。
- 沒有相簿、行事曆（依訪談結論延後到之後版本）。
- 沒有角色分工代理（研究/程式/測試），MVP 核心是多供應商比較，不是角色協作。
