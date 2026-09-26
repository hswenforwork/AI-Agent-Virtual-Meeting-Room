# AI 協作室（AI Agent Virtual Meeting Room）

一個瀏覽器聊天室：在同一個對話視窗用 `@Claude`、`@GPT`、`@Gemini` 點名不同 AI 供應商，
針對同一個問題平行比較各家答案；右側搭配記事本、待辦事項與檔案夾（可作為多供應商共享的上下文）。

- 完整規劃與設計決策：[`docs/MVP規劃-v2.md`](docs/MVP規劃-v2.md)
- 原始訪談紀錄：[`brainstorms/2026-09-18-ai-agent-collab-room-mvp.md`](brainstorms/2026-09-18-ai-agent-collab-room-mvp.md)

Claude／GPT／Gemini 三家都可以用——每個使用者在網頁「設定」頁輸入**自己的** API key
即可啟用對應的代理，金鑰加密存放在 Supabase Vault，部署者不需要幫任何人代墊費用
（設計見 [`brainstorms/2026-09-22-user-api-key-settings.md`](brainstorms/2026-09-22-user-api-key-settings.md)）。

**想要一份自己的？** 如果你是用 Claude Code 連到這個 repo，直接請它「幫我部署這個工具」即可——
它會自動叫用 [`.claude/skills/deploy-ai-collab-room`](.claude/skills/deploy-ai-collab-room/SKILL.md) 這個 Skill，
從 fork 專案、建立 Supabase、部署到 GitHub Pages，一路帶到工作型代理設定，不需要照著下面的手動步驟自己做。
這個 Skill 會優先透過 repo 內建的 [`.mcp.json`](.mcp.json)（Supabase 官方 MCP Server）直接操作 Supabase，
比自己組 API 呼叫更準確；要用到這個能力，先設定環境變數 `SUPABASE_ACCESS_TOKEN`（去
[Supabase Personal Access Tokens](https://supabase.com/dashboard/account/tokens) 申請），
第一次開啟這個 repo 時 Claude Code 會問要不要信任這個 MCP 設定，按同意即可；沒設定也沒關係，Skill 會自動退回手動呼叫 API。
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
   - `supabase/migrations/0008_room_sidebar_history.sql`（左側聊天室歷史清單，見下方「附加設定」）
   - `supabase/migrations/0009_byok_api_keys.sql`（使用者自己輸入 API key，見下方「附加設定」）
   - `supabase/migrations/0010_provider_model_selection.sql`（使用者選擇模型，見下方「附加設定」）
   - `supabase/migrations/0011_shared_workspace.sql`（記事本／待辦事項／檔案夾跨聊天室共用，見下方「附加設定」）
   - `supabase/migrations/0012_workspace_owner_id.sql`（記事本／待辦事項／檔案夾徹底跟房間解耦，見下方「附加設定」）
   - `supabase/migrations/0013_agent_collaboration.sql`（代理互相協作，見下方「附加設定」）
   - `supabase/migrations/0014_conversation_summary.sql`（對話自動摘要，見下方「附加設定」）
   - `supabase/migrations/0015_agent_run_cancel.sql`（停止 AI 回覆，見下方「附加設定」）
   - `supabase/migrations/0016_message_token_usage.sql`（訊息泡泡顯示 token 用量，見下方「附加設定」）
   - `supabase/migrations/0017_workspace_realtime.sql`（記事本/待辦/檔案夾即時更新，見下方「附加設定」）
   - `supabase/migrations/0018_worker_task_notebook_tool.sql`（工作型代理寫進記事本/待辦事項，見下方「附加設定」）
   - `supabase/migrations/0019_cross_account_security_fixes.sql`（跨帳號權限隔離修正：自行加入別人房間、
     跨房間點名、核准競態，**必要修正，不是選用附加設定**，新建立的專案也要套用）
   - `supabase/migrations/0020_shared_knowledge.sql`（跨聊天室共享知識系統，見下方「附加設定」）
   - `supabase/migrations/0021_knowledge_retrieval_indexes.sql`（跟隨 0020 的知識檢索效能索引，
     有套用 0020 才需要這個）
   - `supabase/migrations/0022_agent_run_dispatch_idempotency.sql`（訊息派送冪等，防止同一則訊息
     重複觸發同一個代理回覆，**必要修正**）
   - `supabase/migrations/0023_send_message_with_mentions.sql`（訊息本體與 @提及 原子寫入，
     **必要修正**）
   - `supabase/migrations/0024_conversation_summary_lock.sql`（對話摘要並行鎖，避免積壓漏摘要，
     **必要修正**）
   - `supabase/migrations/0025_usage_daily_atomic_increment.sql`（用量統計原子累加，避免併發低估，
     **必要修正**）

   > **已經是既有專案（資料庫已經套用過 0001~0018）**：`0019`、`0022`、`0023`、`0024`、`0025`
   > 這五個標「必要修正」的 migration 請務必依序補套用，不是可以跳過的選用附加設定——分別修正
   > 跨帳號權限隔離漏洞、訊息重複派送、訊息半成品寫入、對話摘要漏訊息、用量統計併發低估。
   > `0020`／`0021`（共享知識系統）才是真正選用，看下方「附加設定：跨聊天室共享知識系統」
   > 再決定要不要套用。
3. 到 **Project Settings → API**（新版介面可能是 **Settings → API Keys** / **Settings → Data API**，或直接點專案頁面右上角的 **Connect** 按鈕），記下：
   - `Project URL`（等一下是 `VITE_SUPABASE_URL`）
   - `anon public` key（等一下是 `VITE_SUPABASE_ANON_KEY`）

### 步驟 2：設定 Edge Function secrets（後端密鑰）

到 Supabase Dashboard 的 **Edge Functions → Secrets**（或用 Supabase CLI `supabase secrets set`），設定：

```
ALLOWED_ORIGINS=https://<你的 github 帳號>.github.io
DEFAULT_CLAUDE_MODEL=claude-sonnet-5
MAX_AGENT_RUNS_PER_MESSAGE=4
```

`DEFAULT_GPT_MODEL`（預設 `gpt-5.1`）、`DEFAULT_GEMINI_MODEL`（預設 `gemini-3.8-flash`）可選填，
不填就用程式內的預設值。**不需要**設定 `ANTHROPIC_API_KEY`／`GEMINI_API_KEY` 這類全域 AI 金鑰——
BYOK 上線後每個使用者在「設定」頁輸入自己的 key，部署者不用、也不會代墊任何 AI 費用。

`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` 這三個是 Supabase 保留字，
平台會自動注入給每個 Edge Function，**不能也不需要**手動設定（手動加會直接被擋下，
錯誤訊息是「Name must not start with the SUPABASE_ prefix」）。

### 附加設定：工作型代理（沙盒任務，選用）

聊天室裡 `@Claude` 除了純聊天回答，也會自動判斷訊息是不是「任務」（寫程式、修 bug、產生檔案、部署等）；
如果是任務，會先出一張「任務卡片」等你按「開始執行」，才會真的動手做（設計見
[`brainstorms/2026-09-18-agentic-sandbox-workers.md`](brainstorms/2026-09-18-agentic-sandbox-workers.md)）。
這部分底層是 Anthropic 的 **Managed Agents（CMA，目前是 beta）**，需要額外一次性設定：

1. **已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，依序貼上並執行
   `supabase/migrations/0007_worker_tasks.sql` 跟 `0009_byok_api_keys.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。
2. 每個使用者要用工作型代理前，先到「設定」頁輸入**自己的** Anthropic API key（要有 Managed Agents／CMA
   beta 權限，跟平常聊天用的 Messages API 是同一把 key，只是 Managed Agents 目前是 beta 功能，需要帳號開通）。
   第一次按「開始執行」時，系統會自動用這把 key 建立這個使用者專屬的 Managed Agents agent／environment
   並重複使用，**不需要**部署者手動跑設定腳本或設定任何全域 secrets
   （設計見 [`brainstorms/2026-09-22-user-api-key-settings.md`](brainstorms/2026-09-22-user-api-key-settings.md) Q9/Q10；
   舊版手動流程的 `scripts/setup-managed-agent.sh` 已經不需要再執行，留著只是給想了解底層 API 呼叫長怎樣的人參考）。
3. 卡住時自動詢問 Gemini（訪談 Q1/Q2）用的也是該使用者自己在「設定」頁輸入的 Google API key，
   沒設定的話不影響一般聊天／任務執行，只是代理卡住時求助不到人，會照自己的判斷繼續嘗試。
4. 如果要讓工作型代理修改**這個專案自己的 GitHub repo**（訪談 Q7：這個專案優先），部署者加兩個
   Edge Function secrets（這是專案層級的 GitHub 存取權限，跟使用者各自的 AI key 無關）：
   ```
   GITHUB_REPO_URL=https://github.com/<owner>/<repo>
   GITHUB_TOKEN=一個有這個 repo 存取權的 GitHub Personal Access Token
   GITHUB_REPO_BRANCH=要 checkout 的分支（選用，不填用預設分支）
   ```

> ⚠️ 這個功能會讓代理在一個 Anthropic 代管的沙盒容器裡自主執行 bash／寫檔案等操作（`always_allow` 權限，
> 不會逐步跳出來要你按確認），沒有硬性花費上限（訪談 Q5 決議先不設，用真實用量再校正）。
> 每個使用者用的是自己的 key、自己的 Managed Agents 資源，花費也算在使用者自己的 Anthropic 帳號上；
> 使用前請自行評估你能接受的風險與花費範圍。

### 附加設定：左側聊天室歷史清單（選用但建議）

左側會列出你所有的聊天室，支援新增、重新命名、關閉（封存）、永久刪除，新聊天室也會在第一則訊息送出後
自動用 AI 取一個精簡標題（設計見 [`brainstorms/2026-09-22-room-sidebar-history.md`](brainstorms/2026-09-22-room-sidebar-history.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0008_room_sidebar_history.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。
這個 migration 會順便把既有房間目前的名稱／最後活動時間補上正確的值，不會覆蓋掉你已經取好的房間名稱。

### 附加設定：使用者自己輸入 API key（選用但建議，讓 GPT／Gemini 真正能用）

每個使用者到網頁右上角「設定」頁（`/settings`）輸入自己的 Anthropic／OpenAI／Google API key，
就能點名對應的代理；金鑰會先被拿去對該供應商發一次最小額度的測試呼叫，成功才加密存進
Supabase Vault，部署者跟其他使用者都看不到明碼（設計見
[`brainstorms/2026-09-22-user-api-key-settings.md`](brainstorms/2026-09-22-user-api-key-settings.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0009_byok_api_keys.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。
這個 migration 會啟用 `supabase_vault` extension、建立金鑰資料表，跟只授權給 service_role
呼叫的加解密函式，不需要額外的 Dashboard 設定。

### 附加設定：使用者選擇模型（選用但建議）

金鑰測試通過、存好之後，網站會自動抓一次該供應商目前實際可用的模型清單（不是寫死在程式碼裡
的清單，避免模型過期），使用者可以在「設定」頁的下拉選單挑選要用哪個模型，也可以按重新整理
按鈕手動拿最新清單；工作型代理（Managed Agents）用的 Claude 模型也會跟著使用者的選擇走，
沒選過就繼續用環境變數的預設值（設計見
[`brainstorms/2026-09-22-provider-model-selection.md`](brainstorms/2026-09-22-provider-model-selection.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0010_provider_model_selection.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：記事本／待辦事項／檔案夾跨聊天室共用、AI 可直接寫回

右側的記事本、待辦事項、檔案夾**不再分房間**，同一個帳號底下所有聊天室共用同一份資料，任何一個聊天室的
AI 都能讀到、也能直接寫入（例如請 AI「幫我記一下 XX」會真的寫進記事本，而不是變成一個檔案）；
每筆資料如果是舊資料（改版前建立的），旁邊會顯示一個小標籤標明「來自：原本的房間名稱」方便追溯，新建立的
資料則沒有這個標籤（設計見
[`brainstorms/2026-09-23-notes-write-and-shared-workspace.md`](brainstorms/2026-09-23-notes-write-and-shared-workspace.md)）。
AI 判斷「這句話是不是要記事/加待辦」是額外一次輕量分類呼叫，三家供應商都適用；找不到、或不確定要修改
哪一筆既有記事/待辦時，AI 不會亂猜，只會回問你說清楚是哪一筆。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0011_shared_workspace.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。
這個 migration 只改 RLS 政策，不搬動任何既有資料、也不改欄位，上傳過的檔案不受影響。

### 附加設定：記事本／待辦事項／檔案夾徹底跟房間解耦（建議，修正刪除房間會連帶刪掉共用資料的問題）

`0011` 只是放寬「誰看得到」的權限，資料本身仍然掛在某個房間下、跟著房間一起被刪除；這個 migration
新增 `owner_id` 欄位當真正的歸屬，`room_id` 降級成「來源房間」的參考欄位（房間被刪除時會自動變成
空值，不會連帶刪掉記事本／待辦事項／檔案夾本身）。既有資料會自動回填 `owner_id`，不用手動搬移
（設計見 [`brainstorms/2026-09-23-gpt-audit-followups.md`](brainstorms/2026-09-23-gpt-audit-followups.md) Q1）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0012_workspace_owner_id.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：代理互相協作（選用但建議）

點名的代理現在會**平行**回覆，不再依序等待、也不會看到同時被點名的其他代理的答案（符合「各自獨立
回答、平行並排顯示」的設計初衷）。此外，任何一則回覆（不分有沒有被使用者明確點名）都能用 AI 原生
的 tool use 判斷「這個問題交給另一位供應商的代理回答更合適」，自動把它拉進對話——它的回答會獨立
顯示成一則新訊息，同一則使用者訊息最多接力一次，不會無限循環。這個功能只在你自己有設定超過一家
供應商的 API key 時才會出現（沒有其他家的 key 就不會附帶這個能力，設計見
[`brainstorms/2026-09-23-gpt-audit-followups.md`](brainstorms/2026-09-23-gpt-audit-followups.md) Q2-Q8）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0013_agent_collaboration.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：對話自動摘要（選用但建議）

每個聊天室的歷史訊息累積到一定數量後（AI 平常只看得到最近 24 則），較早的部分會自動被 AI 折進一份
「對話摘要」存起來，之後組上下文時會一起帶入，讓 AI 不會完全忘記更早之前聊過什麼；摘要內容可以在
右側欄位新增的「對話摘要」分頁查看。畫面上的聊天紀錄也補上「往上捲動載入更舊訊息」，不再固定卡在
最新 200 則（設計見
[`brainstorms/2026-09-23-gpt-audit-followups.md`](brainstorms/2026-09-23-gpt-audit-followups.md) Q10-Q13）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0014_conversation_summary.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

> 這三個附加設定牽涉到的 PDF 原生文件輸入（Anthropic／OpenAI／Google 各自的文件輸入格式）跟
> DOCX/XLSX 文字擷取不需要額外的資料庫設定，Edge Functions 部署完就會生效。

### 附加設定：停止 AI 回覆（建議，同時修正卡在「回覆中…」不會消失的問題）

每個「OOO 回覆中…」旁邊會出現一顆「停止」按鈕，點擊後會中止正在生成中的那則回覆；同時修正了一個
既有的 bug——代理執行過程中如果發生非供應商 API 本身的錯誤（例如資料庫寫入失敗），原本完全不會
更新執行狀態，導致「回覆中…」永遠不會消失（設計見
[`brainstorms/2026-09-23-stop-generation.md`](brainstorms/2026-09-23-stop-generation.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0015_agent_run_cancel.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：訊息泡泡顯示 token 用量（選用但建議）

一般聊天回覆、任務卡片（含工作型代理執行過程）的訊息泡泡時間戳旁邊會顯示這則訊息用了
多少 token（例如「14:32 · 1,234 tokens」），只顯示合計數字，不含意圖分類呼叫本身的用量；
記事本/待辦短確認訊息不顯示。上線前已存在的舊訊息沒有這筆資料，維持現狀不顯示任何提示
（設計見 [`brainstorms/2026-09-23-message-token-usage-display.md`](brainstorms/2026-09-23-message-token-usage-display.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0016_message_token_usage.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：記事本／待辦事項／檔案夾即時更新（建議，修正 AI 新增內容後畫面不會自動更新的問題）

AI 直接寫入記事本／待辦事項（或工作型代理把產出檔案登記進檔案夾）時，畫面現在會立刻
顯示最新內容，不用再手動切到其他分頁再切回來才看得到（設計見
[`brainstorms/2026-09-23-workspace-realtime-refresh.md`](brainstorms/2026-09-23-workspace-realtime-refresh.md)）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0017_workspace_realtime.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：工作型代理寫進記事本/待辦事項（選用但建議）

原本工作型代理（沙盒任務）被要求「記進記事本」時，只能寫一個沙盒裡的檔案模擬，跟聊天室
右側真正的記事本/待辦事項是兩回事。現在只要任務的原始訊息明確要求記錄（例如提到「記進
記事本」），代理就會拿到一個新工具，真的把結果新增一則記事或待辦（只能新增，不能修改
既有項目），跟一般聊天寫記事本走同一套邏輯（設計見
[`brainstorms/2026-09-23-worker-agent-notebook-write.md`](brainstorms/2026-09-23-worker-agent-notebook-write.md)）。
這次也順便修正了工作型代理產出檔案一直沒辦法出現在「檔案夾」的既有 bug（登記檔案時漏帶
必填的 `owner_id`，見同一份設計紀錄）。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，貼上並執行
`supabase/migrations/0018_worker_task_notebook_tool.sql`（新建立的專案照步驟 1 的清單做過一次就夠了）。

### 附加設定：跨聊天室共享知識系統（選用但建議）

新增「共享知識」分頁：由你自己確認的長期背景（目標／專案／用語／工作規則／事實）、只追加
的決策紀錄（取代舊決策要明確指定，不會悄悄覆蓋）、每則知識/決策的來源索引（區分「知道
存在」跟「已驗證內容」）、代理在聊天中主動提出的知識/決策/關聯草稿（要你自己確認、修改
或拒絕才會變成正式資料）、依證據檢查的稽核報告，以及可搜尋、可點擊的 2D 知識關聯圖。
跟記事本/待辦事項一樣是跨聊天室共用（依帳號、不依房間），設計與借鏡對照見
[`docs/AI-Partner借鏡對照.md`](docs/AI-Partner借鏡對照.md)。

**已經是既有專案（資料庫已經在跑）**：到 Supabase Dashboard 的 **SQL Editor**，依序貼上並執行
`supabase/migrations/0020_shared_knowledge.sql`、`supabase/migrations/0021_knowledge_retrieval_indexes.sql`
（新建立的專案照步驟 1 的清單做過一次就夠了）。

**這個 migration 也會新增兩個 Edge Function**（`.github/workflows/deploy-functions.yml` 會自動
部署，不用手動處理）：

- `knowledge-audit`：手動觸發一次稽核檢查（「共享知識 → 稽核」分頁的「立即檢查」按鈕），
  用呼叫者自己的登入身分查詢，不需要額外的權限設定。

**選用：排程自動稽核**（這個 repo 不會幫你打開，你要自己決定要不要、多常跑，避免非預期的
費用或通知）。

`knowledge-audit` 支援兩種呼叫方式：一般使用者用自己的登入身分（JWT）手動觸發（前端「立即
檢查」按鈕就是這樣呼叫的），或是帶 `service_role` key＋明確的 `ownerId` 觸發（給排程用）。
**排程一定要用第二種**——使用者登入的 JWT 通常一小時左右就會過期，寫死存進 `pg_cron` 的排程
SQL 裡遲早會開始失敗，不是真正「可持續使用」的排程；`service_role` key 本身不會過期，才適合
放進長期排程。

`service_role` key 等同整個資料庫的完整存取權，**絕對不要直接寫在 SQL 裡**（`cron.job` 這張表
本身是明文可查的）。改用 Supabase Vault 存起來，排程執行當下才解密取出：

```sql
-- 1. 確認 pg_cron 與 pg_net 兩個 extension 已啟用（Database → Extensions）

-- 2. 把 service_role key 存進 Vault（只需要做一次；<service-role-key> 到
--    Project Settings → API 複製，不要外流）
select vault.create_secret('<service-role-key>', 'knowledge_audit_service_key');

-- 3. 建立排程（範例：每週一早上 9 點 UTC；<project-ref> 換成你的專案 ref，
--    <owner-user-id> 換成 auth.users 裡要稽核的那個使用者 id）
select cron.schedule(
  'knowledge-audit-weekly',
  '0 9 * * 1',
  $$
  select net.http_post(
    url := 'https://<project-ref>.functions.supabase.co/knowledge-audit',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'knowledge_audit_service_key'),
      'content-type', 'application/json'
    ),
    body := jsonb_build_object('ownerId', '<owner-user-id>')
  );
  $$
);
```

要停用時執行 `select cron.unschedule('knowledge-audit-weekly');`。這個範例一次只排一個帳號；
多個使用者要各自排一份（`cron.schedule` 名稱要不同），這個 repo 沒有另外做「幫所有帳號各跑
一次」的批次版本。

### 步驟 3：部署 Edge Functions（建議：用 GitHub Actions 自動部署）

`.github/workflows/deploy-functions.yml` 已經設定好，只要 repo 有兩個 Secrets，push 到 `main`
（或改到 `supabase/functions/` 底下的檔案）就會自動掃描並部署 `supabase/functions/` 底下的每一個函式，**不需要 Codespaces、不需要終端機**：

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
npx supabase@latest functions deploy agent-run-stop
npx supabase@latest functions deploy approval-decide
npx supabase@latest functions deploy file-register
npx supabase@latest functions deploy worker-task-start
npx supabase@latest functions deploy save-api-key
npx supabase@latest functions deploy delete-api-key
npx supabase@latest functions deploy refresh-provider-models
npx supabase@latest functions deploy select-provider-model
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
裡面已經有三個代理：`Claude`、`GPT`、`Gemini`；先到右上角「設定」頁輸入你自己對應供應商的
API key，才能點名該代理（見上方「附加設定：使用者自己輸入 API key」）。

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
- 「共享知識系統」的相關度排序是關鍵字重疊＋更新時間，沒有做向量嵌入／語意搜尋；工作型代理
  （沙盒任務）目前只會讀取共享知識，不會主動提出知識/決策草稿（一般聊天才會）；知識關聯圖
  是手繪的簡易 2D 力導向佈局，沒有另外安裝圖形函式庫。詳見
  [`docs/AI-Partner借鏡對照.md`](docs/AI-Partner借鏡對照.md) 最後一節。
