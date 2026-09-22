# AI 協作室（AI Agent Virtual Meeting Room）

一個瀏覽器聊天室：在同一個對話視窗用 `@Claude`、`@GPT`、`@Gemini` 點名不同 AI 供應商，
針對同一個問題平行比較各家答案；右側搭配記事本、待辦事項與檔案夾（可作為多供應商共享的上下文）。

- 完整規劃與設計決策：[`docs/MVP規劃-v2.md`](docs/MVP規劃-v2.md)
- 原始訪談紀錄：[`brainstorms/2026-09-18-ai-agent-collab-room-mvp.md`](brainstorms/2026-09-18-ai-agent-collab-room-mvp.md)

目前 MVP **只有 Claude（Anthropic API）真正可用**；GPT／Gemini 的介面已經留好，
之後申請到 API key 再啟用即可，不需要改架構。

**想要一份自己的？** 如果你是用 Claude Code 連到這個 repo，直接請它「幫我部署這個工具」即可——
它會自動叫用 [`.claude/skills/deploy-ai-collab-room`](.claude/skills/deploy-ai-collab-room/SKILL.md) 這個 Skill，
從 fork 專案、建立 Supabase、部署到 GitHub Pages，一路帶到工作型代理設定，不需要照著下面的手動步驟自己做。
下面的手動步驟是給沒有用 Claude Code、想自己一步步照做的人看的。

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
   - `supabase/migrations/0007_worker_tasks.sql`（工作型代理／任務卡片，見下方「附加設定」）
3. 到 **Project Settings → API**（新版介面可能是 **Settings → API Keys** / **Settings → Data API**，或直接點專案頁面右上角的 **Connect** 按鈕），記下：
   - `Project URL`（等一下是 `VITE_SUPABASE_URL`）
   - `anon public` key（等一下是 `VITE_SUPABASE_ANON_KEY`）

### 步驟 2：設定 Edge Function secrets（後端密鑰）

到 Supabase Dashboard 的 **Edge Functions → Secrets**（或用 Supabase CLI `supabase secrets set`），設定：

```
ANTHROPIC_API_KEY=你的 Anthropic API key（console.anthropic.com 申請）
ALLOWED_ORIGINS=https://<你的 github 帳號>.github.io
DEFAULT_CLAUDE_MODEL=claude-sonnet-5
MAX_AGENT_RUNS_PER_MESSAGE=4
```

`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 這三個是 Supabase 保留字，
平台會自動注入給每個 Edge Function，**不能也不需要**手動設定（手動加會直接被擋下，
錯誤訊息是「Name must not start with the SUPABASE_ prefix」）。

### 附加設定：工作型代理（沙盒任務，選用）

聊天室裡 `@Claude` 除了純聊天回答，也會自動判斷訊息是不是「任務」（寫程式、修 bug、產生檔案、部署等）；
如果是任務，會先出一張「任務卡片」等你按「開始執行」，才會真的動手做（設計見
[`brainstorms/2026-09-18-agentic-sandbox-workers.md`](brainstorms/2026-09-18-agentic-sandbox-workers.md)）。
這部分底層是 Anthropic 的 **Managed Agents（CMA，目前是 beta）**，需要額外一次性設定：

1. **已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
   `supabase/migrations/0007_worker_tasks.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。
2. 確認你的 `ANTHROPIC_API_KEY` 有 Managed Agents（CMA）beta 權限（跟平常聊天用的 Messages API 是同一把 key，
   但 Managed Agents 目前是 beta 功能，需要帳號開通）。
3. 在**你自己的電腦或 Codespaces**（不是 Edge Function 環境）執行一次設定腳本，建立可重複使用的
   agent／environment 設定：
   ```bash
   export ANTHROPIC_API_KEY="你的 key"
   ./scripts/setup-managed-agent.sh
   ```
   腳本執行完會印出 `agent_id` 跟 `environment_id`，照著印出的指令設定 Edge Function secrets：
   ```
   MANAGED_AGENTS_AGENT_ID=agent_xxx
   MANAGED_AGENTS_ENVIRONMENT_ID=env_xxx
   ```
4. 如果要讓工作型代理修改**這個專案自己的 GitHub repo**（訪談 Q7：這個專案優先），再加兩個 secrets：
   ```
   GITHUB_REPO_URL=https://github.com/<owner>/<repo>
   GITHUB_TOKEN=一個有這個 repo 存取權的 GitHub Personal Access Token
   GITHUB_REPO_BRANCH=要 checkout 的分支（選用，不填用預設分支）
   ```
5. 卡住時要能自動詢問 Gemini（訪談 Q1/Q2），再加：
   ```
   GEMINI_API_KEY=你的 Gemini 免費 API key（aistudio.google.com 申請）
   ```
   沒設定這個也不影響一般聊天／任務執行，只是代理卡住時求助不到人，會照自己的判斷繼續嘗試。

> ⚠️ 這個功能會讓代理在一個 Anthropic 代管的沙盒容器裡自主執行 bash／寫檔案等操作（`always_allow` 權限，
> 不會逐步跳出來要你按確認），沒有硬性花費上限（訪談 Q5 決議先不設，用真實用量再校正）。
> 部署前請自行評估你能接受的風險與花費範圍。

### 步驟 3：部署 Edge Functions（建議：用 GitHub Actions 自動部署）

`.github/workflows/deploy-functions.yml` 已經設定好，只要 repo 有兩個 Secrets，push 到 `main`
（或改到 `supabase/functions/` 底下的檔案）就會自動部署四個函式，**不需要 Codespaces、不需要終端機**：

1. 到 [Supabase Dashboard → 帳號設定 → Access Tokens](https://supabase.com/dashboard/account/tokens)
   建立一個 **Personal Access Token**，複製起來。
2. 到 repo 的 **Settings → Secrets and variables → Actions → Secrets**（注意是 **Secrets** 分頁，
   不是前面設定 `VITE_SUPABASE_URL` 用的 Variables 分頁），新增：
   - `SUPABASE_ACCESS_TOKEN` = 剛剛複製的 Personal Access Token
   - `SUPABASE_PROJECT_REF` = 你的專案 ref（Supabase Dashboard 網址裡 `project/` 後面那串）
3. 這兩個設定好之後，到 repo 的 **Actions** 分頁，手動觸發一次 **deploy-functions** 這個 workflow
   （點進去右側會有 **Run workflow** 按鈕），或者 push 一次程式碼，之後就會自動部署。

**如果你已經有終端機環境**（例如 Codespaces 網路正常時），也可以用 [Supabase CLI](https://supabase.com/docs/guides/cli) 手動執行：

```bash
npx supabase@latest link --project-ref <你的專案 ref>
npx supabase@latest functions deploy chat-dispatch
npx supabase@latest functions deploy agent-run
npx supabase@latest functions deploy approval-decide
npx supabase@latest functions deploy file-register
```

（Codespaces 有時候會遇到 DNS 暫時連不出去的狀況，導致 `failed to bundle function`；
遇到這種狀況改用上面的 GitHub Actions 方式最省事。）

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

**Email 登入的兩個小地雷：**

1. Supabase 內建的寄信服務**每小時只能寄 2 封驗證信**，測試時很容易撞到「email rate limit exceeded」。
   個人使用建議直接到 Supabase Dashboard 的 **Authentication → Sign In / Providers → Email**，
   把 **Confirm email**（確認信箱）關掉，註冊後不用等驗證信就能直接登入。
2. 也可以到 Supabase Dashboard 的 **Authentication → Providers** 打開 **Anonymous Sign-ins**，
   這樣網頁上「以訪客身分繼續」這顆按鈕才能用——不用註冊、不會寄信，直接開始使用。
   訪客資料留在該瀏覽器對應的帳號上，換裝置或清除瀏覽器資料後就無法再登入回同一個帳號；
   要長期、跨裝置保存資料還是建議用 Email 註冊。

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
- 「工作型代理」（任務卡片、沙盒執行）是第一版：只支援單一 session 跑到底、單一任務不會被拆成多個回合對話；
  Managed Agents 目前是 Anthropic beta 功能，介面與行為未來可能調整。
