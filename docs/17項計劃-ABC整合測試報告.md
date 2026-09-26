# 17 項修正與升級執行計劃：A/B/C 三個 PR 整合測試報告

日期：2026-09-26
基準：`origin/main` `fa126b5`（PR #44、#45、#46 全部尚未合併）
整合分支：`claude/integration-abc-17plan`（依序 merge `claude/phase-a-cross-account-security`
→ `claude/intelligent-mccarthy-i4bn6p`（PR #44）→ `claude/phase-c-reliability`（PR #46））
對應 PR：#45（項目 1/2/3/8）、#44（項目 4/13/14，另含跨聊天室共享知識新功能）、
#46（項目 6/7/9/10/16）

## 0. 這份報告要回答什麼

三個 PR 都各自完整測試過（見各自的測試報告），但都是**在互相看不到對方的分支上**測試的。
GitHub 顯示「可合併」只代表 git 的文字層級 diff 沒有衝突，不代表：

1. 三份 migration 用同一個序號（`0019`）能不能真的照某個順序連續套用到同一個資料庫；
2. 三份都改到同一支 Edge Function（`chat-dispatch`/`agent-run`/`worker-task-start`）或
   同一支前端元件（`TaskCardMessage.tsx`）的地方，合在一起邏輯還對不對；
3. 其中一個 PR 收緊的 RLS policy，會不會讓另一個 PR 新加的 RPC 出現沒人測過的行為。

這份報告的測試方法論跟 Phase A/B/C 三份報告一致：**先重現/確認問題存在或程式碼邏輯，
再用真實 PostgreSQL + standalone PostgREST（真實 HTTP + RLS）+ standalone Deno（真實
JWT `auth.uid()`，必要時直接執行未修改的 Edge Function 原始檔）驗證**，不是只讀程式碼
就下結論。

## 1. 三方合併過程與衝突檢查（不只看 GitHub 的「可合併」）

### 1.1 檔案層級重疊

| 檔案 | 被誰改到 | git 自動合併 | 人工語意檢查結果 |
|---|---|---|---|
| `src/types/database.ts` | #45（`ApprovalStatus` 加 `executing`）、#44（新增知識系統的十幾個型別） | 乾淨自動合併 | ✅ 兩邊的型別都在，互不影響 |
| `supabase/functions/chat-dispatch/index.ts` | #45（`agents` 查詢加 `room_id` 過濾，第二層防禦跨房間點名）、#46（改寫派送迴圈為冪等 insert + 加上 `triggerAgentRun` 逾時重試） | 乾淨自動合併 | ✅ 兩處改動在檔案裡完全不同的區塊（#45 在第 97/108/116 行左右，#46 在第 141 行之後），實際跑過（見第 3 節）確認兩個修正都生效 |
| `supabase/functions/agent-run/index.ts` | #44（注入知識/決策內容到 system prompt、`propose_knowledge` 工具）、#46（`upsertUsage()` 改呼叫 `increment_usage_daily()` RPC） | 乾淨自動合併 | ✅ 兩處改動分屬不同函式（知識注入在請求處理主流程，`upsertUsage` 是獨立函式），`grep` 確認合併後兩邊程式碼都存在 |
| `supabase/functions/worker-task-start/index.ts` | #44（注入知識內容到 Managed Agents 初始訊息）、#46（原子搶占 `pending_confirmation/failed -> queued`） | 乾淨自動合併 | ✅ #44 改在組 `initialUserMessage` 那段，#46 改在請求一開始的權限/狀態檢查，順序上 #46 的原子搶占會先執行，之後才組訊息內容，邏輯順序正確 |
| `src/features/messages/TaskCardMessage.tsx` | #44（`highlighted` prop、來源連結跳轉高亮）、#46（`failed` 狀態下也顯示「重試」按鈕） | 乾淨自動合併 | ✅ 兩處改動分別在元件簽名/外層 `div` 的 className，跟按鈕的顯示條件，互不干擾 |

沒有一處是「git 沒標記衝突，但兩邊改到同一行、實際上互相覆蓋掉對方」的情況——這點是
逐一讀兩邊的 diff、確認改動的行號區間不重疊之後才下的結論，不是只看 `git merge` 沒有
印出 `CONFLICT` 就假設沒事。

### 1.2 Migration 層級：三個 PR 各自的 SQL 有沒有真的衝突

檢查方式：讀完三份 migration 的實際 SQL 內容，確認彼此有沖沒有互相 `alter`/`create` 到
同一個物件：

- #45（`cross_account_security_fixes.sql`）：只改 `room_members`、`message_mentions`、
  `approval_requests` 三張既有表的 **RLS policy** 和一個 **check constraint**，沒有新建表。
- #44（`shared_knowledge.sql` / `knowledge_retrieval_indexes.sql`）：只新建
  `knowledge_items`／`decisions`／`knowledge_sources`／`knowledge_links`／
  `knowledge_proposals` 五張全新的表，**沒有 alter 任何既有表**（`grep -iE "alter table
  (public\.)?(rooms|messages|agents|agent_runs|message_mentions)"` 確認為空）。
- #46（四份 migration）：`agent_runs` 加唯一索引、`message_mentions` 加唯一約束（新增
  `send_message_with_mentions()` RPC 用）、`rooms` 加 `summary_locked_at` 欄位、新增
  `increment_usage_daily()` RPC。

結論：**三個 PR 的 migration 沒有任何一處真的改到同一個資料庫物件**，唯一的衝突是三個
PR 各自都想用 `0019` 這個檔名序號——這是純粹的檔名/序號問題，不是 SQL 語意衝突。

### 1.3 Migration 重新編號

原本各自的序號：

| PR | 原始檔名 |
|---|---|
| #45 | `0019_cross_account_security_fixes.sql` |
| #44 | `0019_shared_knowledge.sql`、`0020_knowledge_retrieval_indexes.sql` |
| #46 | `0021_agent_run_dispatch_idempotency.sql`、`0022_send_message_with_mentions.sql`、`0023_conversation_summary_lock.sql`、`0024_usage_daily_atomic_increment.sql` |

整合後唯一、連續的最終順序（SQL 語意完全不變，只是改檔名跟開頭的說明註解，內容一律
逐字保留）：

| 最終序號 | 檔名 | 內容 | 排序理由 |
|---|---|---|---|
| 0019 | `cross_account_security_fixes.sql` | #45 全部 | 基礎安全修正，不依賴任何其他兩個 PR 的物件，且 #46 的 RPC 依賴它收緊過的 RLS policy（見 3.2 節），排在最前面 |
| 0020 | `shared_knowledge.sql` | #44 | 獨立新功能，不依賴 #45/#46 |
| 0021 | `knowledge_retrieval_indexes.sql` | #44 | 依賴 0020 建立的表 |
| 0022 | `agent_run_dispatch_idempotency.sql` | #46 項目 7 | 獨立於 0019~0021 |
| 0023 | `send_message_with_mentions.sql` | #46 項目 9 | 新增的 RPC 是 `security invoker`，實際受 0019 收緊過的 `message_mentions_insert_own` policy 約束（見 3.2 節），排在 0019 之後 |
| 0024 | `conversation_summary_lock.sql` | #46 項目 10 | 獨立 |
| 0025 | `usage_daily_atomic_increment.sql` | #46 項目 16 | 獨立 |

所有程式碼裡（Edge Function 註解、`src/types/database.ts`、`README.md`、三份既有測試
報告）對舊序號的引用都已經找出來並改成新序號（用 `grep -rn "migrations/00[12][0-9]"`
逐一核對，不是只改檔名不改引用）。三份既有測試報告（Phase A／共享知識系統／Phase C）
保留原本撰寫時的舊檔名當作歷史紀錄，開頭加上編號對照的說明框，不逐字改寫內文。

## 2. 從乾淨資料庫依最終順序套用全部 migration

`scripts/integration-abc-sql-rpc-test.sh` 跟 `scripts/integration-abc-edge-function-test.sh`
都會先從全新資料庫，套用 main 既有的 `0001`~`0018`（逐字不改），再依上面的最終順序套用
`0019`~`0025`。兩支腳本都實際跑過、全部通過（見第 3 節），確認：**這個順序真的可以從
main 現有的 schema 一路套用下去，不是只在理論上排得出順序**。

## 3. 逐項回歸結果

每一項都附：對應程式碼、可重跑指令、實際結果。指令統一用
`POSTGREST_BIN=/path/to/postgrest [DENO_BIN=/path/to/deno] bash scripts/xxx.sh` 執行，
CI 中由 `.github/workflows/integration-abc-regression.yml` 自動下載 postgrest／deno 執行。

### 3.1 逐項清單

| 項目 | 對應程式碼 | 測試腳本／測項 | 結果 |
|---|---|---|---|
| 1．room_members 自行入會 | `0019` policy | `integration-abc-sql-rpc-test.sh`「[項目 1]」 | ✅ PASS |
| 2．approval-decide file.delete owner 驗證 | `approval-decide/index.ts` | `integration-abc-edge-function-test.sh`「[項目 2]」x2（越權失敗／合法成功） | ✅ PASS |
| 3．跨房間點名 | `0019` policy、`chat-dispatch` room_id 過濾 | `integration-abc-sql-rpc-test.sh`「[項目 3]」 | ✅ PASS |
| 4．決策只追加不可繞過 | `0020` REVOKE UPDATE | `integration-abc-sql-rpc-test.sh`「[項目 4]」 | ✅ PASS |
| 6．worker-task-start 原子搶占 | `worker-task-start/index.ts` | `integration-abc-sql-rpc-test.sh`「[項目 6]」（SQL 層原子性，理由見 3.3） | ✅ PASS |
| 7．chat-dispatch 派送冪等與逾時重試 | `chat-dispatch/index.ts`、`0022` | `integration-abc-edge-function-test.sh`「[項目 7]」x3（冪等／一路失敗轉 failed／孤兒 queued 缺口確認） | ✅ PASS（含如實記錄的殘留風險，見 3.4） |
| 8．approval_requests 原子搶占 | `0019` + `approval-decide/index.ts` | `integration-abc-sql-rpc-test.sh`「[項目 8]」（SQL 層競態）＋`integration-abc-edge-function-test.sh` 間接覆蓋（呼叫真的 approval-decide） | ✅ PASS |
| 9．send_message_with_mentions() 冪等與原子性 | `0023` | `integration-abc-sql-rpc-test.sh`「[項目 9]」x3（合法路徑冪等／20 併發相同 client_id／跟 #45 mention RLS 的交互測試） | ✅ PASS |
| 10．對話摘要不漏訊息 | `0024`、`conversationSummary.ts` | `integration-abc-sql-rpc-test.sh`「[項目 10]」 | ✅ PASS |
| 13．知識檢索跨聊天室 | `0020`、`knowledgeContext.ts` | `integration-abc-sql-rpc-test.sh`「[項目 13]」 | ✅ PASS |
| 14．knowledge-audit 分頁 | `knowledge-audit/index.ts` | `integration-abc-sql-rpc-test.sh`「[項目 14]」 | ✅ PASS |
| 16．usage_daily 原子累加 | `0025` | `integration-abc-sql-rpc-test.sh`「[項目 16]」（20 併發） | ✅ PASS |

兩支腳本目前的完整輸出（`=== 全部通過 ===`）已經在整合分支上實際跑過，不是只列出
測項清單。

### 3.2 三個 PR 各自報告都沒測過的交互作用（這次整合測試才驗證）

**#45 的 mention RLS 收緊 + #46 的 `send_message_with_mentions()` RPC 合在一起**：

- 直接呼叫 RPC、`p_mention_agent_ids` 帶一個跨房間的 `agent_id`：實測回應是
  **HTTP 403**，錯誤訊息是 PostgREST 直接把 `message_mentions` 的 RLS 違規往外丟
  （`new row violates row-level security policy for table "message_mentions"`）。
- 確認**整個交易（含訊息本體）一起 rollback**，資料庫裡完全沒有半成品訊息——不是
  「訊息送出去了、只有 mention 被擋下」。
- ⚠ **跟修正前的行為不同**：#46 修正前的舊三步驟寫法是「訊息 insert 成功、mentions
  insert 被 RLS 擋下」，訊息本身還是會送出去（沒有 mention，之後也不會被
  `chat-dispatch` 派送到任何代理）；改成 RPC 原子寫入之後，同一個異常輸入會讓
  **使用者自己的訊息也送不出去**。這只會在使用者自己的用戶端組出不存在或跨房間的
  `agent_id` 時發生（正常 UI 的候選清單只會來自同一個房間），不是被別人利用來影響
  別人；但如果之後有人繞過前端直接打 RPC（例如寫腳本），要注意這個行為差異。
  **列入後續工作**：是否要讓 RPC 對無效的 `agent_id` 靜默忽略（跟 `on conflict do
  nothing` 的哲學一致）而不是讓整個交易失敗，需要產品面決定，這次整合測試只負責
  如實記錄行為，不擅自更動邏輯。

### 3.3 項目 6 的測試範圍限制（沿用 Phase C 報告，不是這次新出現的限制）

`worker-task-start` 的 `createSession()` 呼叫的是硬編碼、不可用環境變數改的真實
Anthropic Managed Agents API（`CMA_BASE = "https://api.anthropic.com/v1"`）。改這行
程式碼本身超出這次修正範圍，因此這一項延續 Phase C 報告的作法：只驗證 SQL 層「條件式
UPDATE 原子搶占」本身的正確性（兩個並發交易只有一個搶到 `RETURNING` 的那一列），不
執行真的會呼叫 Managed Agents API 的程式碼路徑。

### 3.4 項目 7：新發現的殘留風險——中斷後的 queued 紀錄沒有逾時修復機制

這是這次整合測試**特別要求驗證**、Phase C 報告原本沒有測到的問題（見任務指示第 5 點）。

**Phase C 報告測過的**：`agent-run` 端點回應失敗（500）或逾時（hang）不回應，
`chat-dispatch` 的 `triggerAgentRun()` 會重試 3 次、退避間隔，用盡後把這筆 `agent_run`
標成 `failed`——這段邏輯這次整合測試重新跑過一次仍然正確（3.1 節）。

**這次額外檢查的問題**：`triggerAgentRun()` 的重試/逾時判定，只有在**同一次
`chat-dispatch` 呼叫真的執行到 `dispatchAgentRuns()`／進入 `EdgeRuntime.waitUntil()`
那一步**才會跑到。讀完 `chat-dispatch/index.ts` 全部程式碼，**沒有找到任何其他機制**
（沒有 `pg_cron` 排程、沒有另一支 Edge Function、沒有資料庫 trigger）會去偵測「已經
insert 進 `agent_runs`、狀態是 `queued`，但已經很久沒有任何後續動作」的紀錄。

如果中斷點比「fetch 失敗」更早——例如 Edge Function 執行環境在剛 insert 完
`agent_runs`（狀態 `queued`）、還沒開始執行 `dispatchAgentRuns()` 之前，就被平台強制
回收（isolate 被砍、冷啟動被中斷等，這類事件不受應用程式碼控制）——這筆 `agent_run`
會**永遠卡在 `queued`**，沒有任何背景程式會發現並修復它。

**實測驗證方式**：不透過 `chat-dispatch` 自己 insert，而是直接在資料庫插入一筆兩小時前
建立、狀態 `queued` 的 `agent_runs` 紀錄（代表「insert 成功後，這次呼叫再也沒有執行過
任何後續程式碼」的狀態），確認除了我們自己的測試腳本以外，資料庫裡沒有任何東西去動
它——兩秒後重新查詢，狀態依然是 `queued`。

**影響**：使用者會看到這則訊息卡在「OOO 回覆中…」，UI 上目前**沒有「重新派送」的按鈕**
（`useSendMessage()` 的重試邏輯只覆蓋「這次呼叫 `chat-dispatch` 本身失敗」，不覆蓋
「`chat-dispatch` 呼叫成功、但背景派送半路中斷」這種情況）；除非使用者對同一則訊息的
`chat-dispatch` 剛好又被呼叫一次（例如重新整理頁面後某個動作意外重新觸發），這筆卡住
的紀錄不會自己恢復。

**這不在這次三個 PR 的修正範圍內**，列入下面第 5 節「後續工作」。

## 4. 前端／Edge Function 靜態檢查

### 4.1 前端

```
npm run typecheck   # tsc -b --noEmit：通過，0 錯誤
npm run lint         # eslint .：0 錯誤，2 個既有 warning（AuthProvider.tsx／AppLayout.tsx
                      # 的 react-refresh/only-export-components，跟這次改動無關，三份
                      # 既有報告都提過同樣兩個 warning）
npm run build         # tsc -b && vite build：通過
```

### 4.2 Edge Function `deno check`：新舊錯誤分類

用 `git worktree` checkout 出未修改的 `origin/main`，對每一支被改到的 Edge Function
分別在 baseline（main）跟整合分支上跑 `deno check --no-lock --node-modules-dir=none`，
比對錯誤代碼（`TSxxxx`）的種類與數量是否完全一致：

| 檔案 | Baseline 錯誤 | 整合分支錯誤 | 新增錯誤 |
|---|---|---|---|
| `approval-decide/index.ts` | `TS2345` x1 | `TS2345` x1 | **0** |
| `chat-dispatch/index.ts` | `TS18047` x1, `TS2304` x2, `TS2322` x1, `TS2339` x2, `TS2345` x1 | 同左，完全一致 | **0** |
| `agent-run/index.ts` | `TS2304` x1, `TS2322` x1, `TS2339` x6, `TS2345` x1, `TS7006` x1 | 同左，完全一致 | **0** |
| `worker-task-start/index.ts` | `TS2304` x1, `TS2339` x1, `TS2345` x1, `TS7006` x1 | 同左，完全一致 | **0** |
| `knowledge-audit/index.ts`（PR #44 新增） | 不存在（main 沒有這支檔案） | 0 個錯誤 | 不適用 |
| `_shared/knowledgeContext.ts`（新增） | 不存在 | 0 個錯誤 | 不適用 |
| `_shared/knowledgeProposal.ts`（新增） | 不存在 | 0 個錯誤 | 不適用 |
| `_shared/conversationSummary.ts` | `TS2322` x1, `TS2339` x2 | 同左，完全一致 | **0** |

**結論：三個 PR 合併後，既有的型別問題（`jsonError()` 呼叫參數簽章、`EdgeRuntime`
全域型別等）數量與種類完全沒有變化，三個 PR 的改動本身沒有引入任何新的型別錯誤。**
`deno check` 目前仍然不在既有 CI 裡（`.github/workflows/integration-abc-regression.yml`
的 `deno-check-no-new-errors` job 只是把結果印出來，`|| true` 讓型別錯誤不擋 CI），修正
這些既有型別問題本身超出這次整合的範圍，列入項目 17 的後續工作。

## 5. 對照原計劃的 KPI，誠實列出「已有程式碼」跟「全部完成」的差距

- **項目 16（用量與預算原子計數）**：這次（含三個 PR 各自的版本）只修正了「計數本身
  要原子、不能在併發下漏算」，**沒有**任何「超過預算就擋下後續請求」的執行機制，也
  **沒有**各供應商/模型的單價換算表。`usage_daily` 目前純粹是累計數字，沒有任何程式碼
  讀取它、跟金額上限比對。這是從 Phase C 報告就明確記錄的殘留風險，這次整合沒有新增
  也沒有解決，繼續列在後續工作。
- **項目 17（CI 回歸覆蓋）**：這次整合把 CI 回歸覆蓋範圍從「只有項目 1/2/3/8」
  （`security-regression.yml`）擴大到「項目 1/2/3/4/6/7/8/9/10/13/14/16」
  （`integration-abc-regression.yml`），但**還不是全部 17 項**：
  - 項目 5、11、12、15（D 階段：刪房後檔案下載、檔案登記核對、PDF 僅按需送出、Storage
    清理）完全還沒開始，將在下一個獨立 PR 處理（見任務指示）。
  - `deno check` 型別檢查目前只是「印出來但不擋 CI」，還不是真正的品質閘門。
  - 項目 6、7 的 Managed Agents／Anthropic Managed Agents session 建立、真的三家供應商
    API 呼叫，都還是只在 SQL／邏輯層驗證，沒有接上真實付費 API 的端對端測試（見下面
    第 6 節的限制說明）。
  - 項目 7 的孤兒 `queued` 紀錄逾時修復機制（3.4 節）目前**完全沒有**，不只是「還沒
    測」，是「還沒做」。
- **項目 7（新發現）**：如 3.4 節，`chat-dispatch` 呼叫本身中斷（不是 fetch 失敗）導致
  的孤兒 `queued` 紀錄，目前沒有任何逾時/重試機制，也沒有對應的前端「重新派送」UI。

## 6. 測試限制（沒有真實付費模型／Storage／正式 Supabase）

延續三份既有報告的限制，這次整合測試同樣：

- **沒有任何一次呼叫真的打到 Anthropic／OpenAI／Google／Managed Agents 的正式付費
  端點**。所有涉及這些呼叫的邏輯（項目 6 的 session 建立、項目 7 的 `agent-run` 呼叫、
  項目 10 的摘要文字生成品質）都只驗證了本機邏輯層/資料庫層可以驗證的部分，沒有驗證
  「真的呼叫外部 API 之後的行為」。
- **沒有使用真的 Supabase 專案、真的 Storage bucket**。`files`／`storage.objects` 都是
  最小化的資料庫 schema 樁，沒有真的檔案上傳/下載/物件儲存行為。
- **沒有瀏覽器互動測試**。前端只做了 `typecheck`/`lint`/`build`，沒有用真的瀏覽器操作
  UI（例如連點「開始執行」按鈕、實際發訊息斷網重試、知識來源連結跳轉高亮）。
- **稽核排程（`pg_cron`）沒有測試**，這個 repo 本身也不會幫使用者打開。
- 部署後才能驗證的情境（需要你自己在正式環境對照）：
  1. 兩個瀏覽器分頁／兩個真實帳號，重複三份既有報告第 7 節列出的手動驗收清單。
  2. 真的讓 `worker-task-start` 建立 Managed Agents session，連點「開始執行」，確認
     只扣一次費用、只產生一個 session。
  3. 接上真實三家供應商 API key，實際發訊息、模擬網路中斷，確認 `agent_runs.status`
     正確反映結果，且確認本報告 3.4 節描述的孤兒 `queued` 紀錄情境在真實 Edge Runtime
     下的實際發生機率（本機測試只能證明「沒有程式碼機制修復它」，無法測「平台實際上
     多常發生這種中斷」）。
  4. 真的讓對話累積超過 300 則積壓訊息，確認摘要文字品質與 `summary_covered_until`
     在真實 Edge Runtime（含 `EdgeRuntime.waitUntil`）下的行為跟本機測試一致。
  5. 接上真實用量後，確認 `usage_daily` 的數字跟供應商帳單對得上。

## 7. 合併後的部署順序

**這個 PR 沒有合併、部署或修改正式 Supabase。** 你檢閱通過後，正式部署請照下面順序：

1. 到 Supabase Dashboard 的 SQL Editor，**依序**執行：
   - `supabase/migrations/0019_cross_account_security_fixes.sql`
   - `supabase/migrations/0020_shared_knowledge.sql`（如果你要用共享知識系統；純安全/
     可靠性修正可以跳過 0020/0021，見 README「附加設定」）
   - `supabase/migrations/0021_knowledge_retrieval_indexes.sql`（只有套用 0020 才需要）
   - `supabase/migrations/0022_agent_run_dispatch_idempotency.sql`
   - `supabase/migrations/0023_send_message_with_mentions.sql`
   - `supabase/migrations/0024_conversation_summary_lock.sql`
   - `supabase/migrations/0025_usage_daily_atomic_increment.sql`
2. 合併後 GitHub Actions 的 `deploy-functions.yml` 會自動部署所有 Edge Function（含
   PR #44 新增的 `knowledge-audit`），不用手動處理。
3. 部署後對照第 6 節「測試限制」列出的情境，用兩個真實帳號在瀏覽器裡實際驗收一次。
4. 如果你要開啟共享知識系統的排程稽核，照 README「附加設定：跨聊天室共享知識系統」的
   `pg_cron` 範例自行決定要不要打開（這個 PR 不會幫你打開）。

## 8. 確認

- 這個 PR（整合分支 `claude/integration-abc-17plan`）沒有合併、沒有部署到任何網站或
  Edge Function、沒有修改正式 Supabase。
- 所有測試都在本機一次性建立、測試完即丟棄的 PostgreSQL 資料庫上執行；沒有使用真實
  付費模型、真實 Storage、正式 Supabase 做任何測試。
- 新增的兩支整合測試腳本（`scripts/integration-abc-sql-rpc-test.sh`、
  `scripts/integration-abc-edge-function-test.sh`）與新增的 CI workflow
  （`.github/workflows/integration-abc-regression.yml`）已經提交到這個分支，後續對
  這些程式碼的修改會自動重新觸發這些測試；任何一項回歸失敗，CI 會失敗（`deno check`
  除外，見 4.2 節說明）。
