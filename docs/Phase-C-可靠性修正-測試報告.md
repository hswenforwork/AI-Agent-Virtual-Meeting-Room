# Phase C．付費呼叫可靠性 — 測試報告

對應「AI 代理協作室：17 項修正與升級執行計劃」C 階段，涵蓋項目 6、7、9、10、16。

基準：`origin/main`（PR #44、PR #45 尚未合併，此分支從 main 獨立切出）

> **編號更新（三 PR 整合時）**：這份報告當初測試時，這裡的 migration 叫 `0021`～`0024`
> （PR #46 自己的編號）。整合 PR #44／#45／#46 時改編號成 `0022`～`0025`（SQL 語意完全
> 不變，只是檔名／序號不同）。完整編號對照、三個 PR 合在一起重新驗證的結果（包含本報告
> 沒測過的「#45 的 mention 權限與 #46 的 send_message_with_mentions() 合在一起」、
> 「chat-dispatch 中斷後 queued 紀錄逾時修復」等項目），見
> [`docs/17項計劃-ABC整合測試報告.md`](17項計劃-ABC整合測試報告.md)。這份報告下面內文
> 保留原本撰寫時的檔名，作為當時測試過程的原始紀錄，不逐一改寫。

## 0. 測試方法

延續 Phase A／Phase B 已經驗證過的本機測試基礎設施：standalone PostgREST（真實 HTTP + RLS）
+ standalone Deno（真實 JWT `auth.uid()`）+ 套用 repo 既有 migrations 0001-0018 逐字不改，
額外只套用這次要驗證的新 migration。所有測試腳本、seed 資料、假的付費 API 端點都不是
repo 的一部分，執行完就丟棄的測試資料庫；**沒有任何一次呼叫真的打到 Anthropic／OpenAI／
Google／Managed Agents 的正式付費端點**（詳見各項目的「避免真的付費呼叫」說明）。

每個項目都遵守「先在未修正的程式碼上重現問題 → 套用修正 → 重新驗證問題被擋下、
合法路徑仍然正常」的方法論，不是只看程式碼順不順。

## 項目 6：worker-task-start 任務重複啟動防護

**問題**：原本只是讀一次 `worker_tasks.status` 判斷是否為 `pending_confirmation`，
真正的搶占（UPDATE 成 `running`）發生在建立 Managed Agents session 之後，中間隔著
好幾個 `await`。兩個幾乎同時按下「開始執行」的請求都會通過檢查，各自建立一個
真的會計費的 Managed Agents session，其中一個變成孤兒 session。

**修正**：`supabase/functions/worker-task-start/index.ts` 改用條件式 UPDATE 原子搶占
（`status in ('pending_confirmation','failed') -> 'queued'`），搶不到（0 筆）代表已經
有另一個請求在處理，直接回報「已經開始執行過了」。允許從 `failed` 重新搶占，讓
「上一次建立 session 失敗」也能重試；`src/features/messages/TaskCardMessage.tsx`
新增 `failed` 狀態下的「重試」按鈕。

**避免真的付費呼叫**：`worker-task-start` 的 `createSession()` 呼叫的是硬編碼、
不可用環境變數改的真實 Anthropic Managed Agents API（`CMA_BASE =
"https://api.anthropic.com/v1"`），修改這行程式碼本身超出這次修正範圍。因此這一項
只在 SQL 層驗證「條件式 UPDATE 的原子搶占」本身：直接對測試資料庫下跟程式碼邏輯
逐字一致的 SQL（舊寫法 vs 新寫法），用兩個併發 psql transaction 模擬「兩個請求幾乎
同時搶占」，確認：
- 舊寫法（先 SELECT 判斷、之後才 UPDATE）：兩個並發交易都會通過檢查，各自認為
  自己搶到了。
- 新寫法（條件式 UPDATE、`RETURNING`）：兩個並發交易裡恰好只有一個拿到
  `RETURNING` 的那一列，另一個 0 筆。

狀態：**已修且實測**（SQL 層原子性實測；`deno check` 對照 baseline 零新增錯誤；
前端 `npm run typecheck` 通過）。

## 項目 7：chat-dispatch 派送冪等與佇列復原

**問題**：`chat-dispatch/index.ts` 原本 (a) 每次呼叫都無條件對每個被點名代理
`insert` 一筆新的 `agent_runs`，同一則訊息被重複呼叫（例如前端網路逾時重試、
使用者連點）會建立重複的 `agent_runs`、重複觸發真的會計費的 LLM 呼叫；
(b) 觸發 `agent-run` 的內部 `fetch()` 不檢查回應狀態碼、失敗只是 log 一行，
讓那筆 `agent_run` 永遠卡在 `queued`，使用者只看到無限轉圈，沒有任何錯誤提示。

**修正**：
1. `supabase/migrations/0021_agent_run_dispatch_idempotency.sql`：在
   `agent_runs(trigger_message_id, agent_id)` 加**部分唯一索引**（`where not
   is_loop_in`），讓 chat-dispatch 對同一則訊息、同一個代理最多只能建立一筆非
   loop-in 的執行紀錄。排除 loop-in 是因為兩個不同的被點名代理各自呼叫
   `loop_in_agent` 工具拉進同一個第三方供應商、共用同一個原始 `trigger_message_id`
   是合法情境（已確認 `agentCollaboration.ts` 的 `spawnLoopInRun()` 行為），不是
   chat-dispatch 那種需要防止的重複派送。
2. `chat-dispatch/index.ts`：insert 撞到唯一索引（`23505`）就代表已經有一筆執行
   紀錄，只有在那筆還卡在 `queued` 時才重新觸發，其餘狀態不重複觸發。
3. 觸發 `agent-run` 的 fetch 加上逾時（`AbortController`）、最多 3 次嘗試（含退避
   500ms/1500ms），重試用盡就把該筆 `agent_run` 標成 `failed`（`error_code:
   dispatch_failed`），不再永遠卡在 `queued`。

**避免真的付費呼叫**：用 `globalThis.EdgeRuntime = { waitUntil: ... }` 補上
standalone Deno 沒有的 Edge Runtime 全域物件，**直接執行真正的
`chat-dispatch/index.ts` 原始程式碼**（不是重寫邏輯），把 `SUPABASE_URL` 指向
一個本機閘道，閘道把 `/functions/v1/agent-run` 導向一個假端點（依環境變數控制
回傳 200／500／逾時不回應），完全不會打到任何真的付費 provider。

**實測結果**（4 項，全部 PASS）：
1. 正常派送：只建立 1 筆 `agent_run`、`agent-run` 只被真的觸發呼叫 1 次。
2. 同一則訊息連續呼叫 chat-dispatch 兩次：兩次回應是同一個 `runId`，資料庫裡只有
   1 筆 `agent_run`（唯一索引擋下重複 insert）。
3. `agent-run` 端點一路回 500：重試 3 次後該筆 `agent_run` 變成 `failed`，
   `error_code=dispatch_failed`。
4. `agent-run` 端點逾時不回應：`AbortController` 正確中止並重試，最終同樣標成
   `failed`，不會無限等待。

另外在資料庫層直接驗證：loop-in（`is_loop_in=true`）的兩筆同 `(trigger_message_id,
agent_id)` 可以並存（不受唯一索引影響）；非 loop-in 的兩筆同樣的鍵值會被唯一索引
擋下（`23505`）。

狀態：**已修且實測**（4 項端到端 Deno 執行測試 + 2 項 SQL 層邊界測試全部通過；
`deno check` 對照 baseline 零新增錯誤）。

## 項目 9：訊息三步寫入原子性

**問題**：前端 `useSendMessage()` 原本是三個獨立步驟：insert `messages` → insert
`message_mentions` → 呼叫 `chat-dispatch`。第一步成功、第二步失敗（網路中斷、
RLS 檢查沒過）就會留下一則「使用者看得到、但沒有 mention、也永遠不會有代理回覆」
的半成品訊息；使用者重新輸入同樣內容再送一次，變成兩則重複訊息，其中一則永遠
孤立。

**修正**：
1. `supabase/migrations/0022_send_message_with_mentions.sql`：新增 `security
   invoker` 函式 `send_message_with_mentions()`，在同一個交易內完成訊息本體 +
   mentions 的寫入，用既有的 `(room_id, client_id)` 唯一索引當冪等鍵：同一個
   `client_id` 重複呼叫直接回傳既有那筆訊息、補齊還沒寫進去的 mentions，不會
   插入第二筆。函式用 `security invoker`（不是 `definer`），既有 RLS policy
   （`messages_insert_own`／`message_mentions_insert_own`）照樣生效，沒有重新
   實作一份權限檢查。另外幫 `message_mentions` 加上
   `(message_id, agent_id)` 唯一約束，讓函式內的 `on conflict do nothing`
   補寫邏輯能用。
2. `src/features/messages/useMessages.ts` 改呼叫這個 RPC；`chat-dispatch` 本身
   已經冪等（項目 7），dispatch 呼叫失敗時安全地重試一次即可。
3. `src/features/messages/MessageComposer.tsx` 用 `useRef` 讓同一次送出嘗試的
   `clientId` 在失敗重試之間保持不變，只有送出成功後才換下一個——避免使用者
   點兩次送出按鈕、或依同樣內容重送時，兩次呼叫各自帶不同的 `clientId`，讓
   冪等鍵形同虛設。

**實測結果**（真實 PostgREST HTTP + RLS，5 項全部 PASS）：
1. 正常送出訊息 + 2 個 mention：訊息與 2 筆 mentions 都正確寫入。
2. 同一個 `client_id` 循序呼叫兩次（模擬前端重試）：兩次回傳同一個訊息 id，
   資料庫裡只有 1 筆訊息、1 筆 mention（沒有變成重複訊息或重複 mention）。
3. 兩個並發請求帶同一個 `client_id`（真正的 race，不是先後重試）：也只產生
   1 筆訊息（唯一索引 + `unique_violation` 例外處理擋下另一個）。
4. 先只送訊息本體、不帶 mentions（模擬「上一次只成功一半」），用同一個
   `client_id` 補送 mentions：補送用的是同一筆訊息、mentions 正確補齊成 1 筆，
   整個過程訊息表只有 1 筆（不是變成兩則重複訊息）。
5. 對照組（RLS 沒被破壞）：非房間成員用別人的房間 id 呼叫這個 RPC，被 RLS 擋下
   （HTTP 403 `new row violates row-level security policy`），資料庫裡沒有寫入
   任何東西。

狀態：**已修且實測**（5 項 HTTP 層測試全部通過；`npm run typecheck` 通過）。

## 項目 10：對話摘要不漏訊息

**問題**：`supabase/functions/_shared/conversationSummary.ts` 的
`maybeSummarizeConversation()` 有兩個獨立問題：
1. 積壓（backlog）查詢用「最新在前（desc）+ LIMIT」抓要摘要的那批訊息。一旦真正
   尚未摘要的訊息數量超過 `BACKLOG_FETCH_CAP`（300），desc + LIMIT 抓到的永遠是
   最新的一批，`summary_covered_until` 被推進到這批的頭，中間比這批更舊、但還沒
   被摘要過的積壓（超過 300 則時最舊的那一段）就被**永久跳過**：之後
   `summary_covered_until` 已經推過去，`gt(created_at, summary_covered_until)`
   再也不會抓到它們。
2. 同一個房間的多個 `agent_run` 可能平行執行（chat-dispatch 一次點名多位代理會
   平行觸發），每一個都各自呼叫這個函式，彼此沒有任何協調：兩個呼叫都讀到同一份
   舊摘要、各自生成新版本，後寫入覆蓋先寫入，先寫入那次涵蓋到的內容就從最終
   存檔的摘要裡消失。

**修正**：
1. `supabase/migrations/0023_conversation_summary_lock.sql`：`rooms` 加
   `summary_locked_at` 欄位；`maybeSummarizeConversation()` 改用條件式 UPDATE
   原子搶占這個鎖（搶不到就跳過，避免重複打一次真的會計費的摘要 LLM 呼叫，也
   避免兩份摘要互相覆蓋），鎖有 5 分鐘逾時，避免持鎖呼叫意外中斷導致永久卡死。
2. 積壓查詢改成「先找出最新 `RECENT_WINDOW`（24）則的邊界時間點 `recentCutoff`，
   再用最舊在前（asc）+ LIMIT 抓積壓，上界卡在 `recentCutoff`（嚴格小於，不含
   邊界本身，第一版曾經用 `<=` 多算進邊界那一則，被自己的測試抓到後改成
   `<`）」。`summary_covered_until` 只推進到「這批實際被摘要進去的最新一則」，
   一次涵蓋不完（超過 `BACKLOG_FETCH_CAP`）也不會跳過任何訊息，下一次呼叫會
   從那裡繼續接著涵蓋。

**避免真的付費呼叫**：這個函式最終會用真的 Anthropic API 生成摘要文字，測試
不引入任何假金鑰去打正式 API，改成直接對測試資料庫下跟程式碼邏輯逐字一致的
SQL 查詢（`recentCutoff` 計算、asc+limit 的積壓查詢、鎖的條件式 UPDATE），只驗證
「不漏訊息」與「鎖」這兩個修正本身的正確性，不涉及摘要文字生成品質。

**實測結果**（4 項，全部 PASS）：
1. 塞入 374 則訊息（24 則最新視窗 + 350 則積壓，刻意超過 `BACKLOG_FETCH_CAP=300`）
   第一輪：積壓總數正確為 350 則；asc+limit 300 抓到的確實是最舊的一批（msg
   1~300），不是最新的一批。
2. 把 `covered_until` 推進到第一輪涵蓋位置，第二輪接續：積壓剩下 50 則
   （msg 301~350），第一筆是 msg 301，跟第一輪最後一筆 msg 300 無縫接續，沒有
   重複也沒有跳過。
3. 對照組：重現舊的 desc+limit 寫法，確認它會從 msg 351 開始摘要，msg 1~350
   全部被永久跳過——證明這是真的 bug，不是臆測。
4. 鎖的原子搶占：兩個並發請求，恰好只有 1 個搶到（`UPDATE ... WHERE
   summary_locked_at IS NULL OR ... < 逾時界線` 只有一個交易的 `RETURNING`
   非空）。

狀態：**已修且實測**（4 項 SQL 層測試全部通過，含用實測反向重現原本的漏訊息
bug；`deno check` 對照 baseline 零新增錯誤；過程中這份測試本身也抓到我第一版
修正的一個邊界差一的 bug（`<=` vs `<`），修正後才全部通過）。

## 項目 16：用量與預算原子計數

**問題**：`supabase/functions/agent-run/index.ts` 的 `upsertUsage()`
原本是「先 `select` 現有值、應用程式層加 1、再 `upsert` 寫回去」，中間沒有任何鎖。
同一個代理同一天有兩個 `agent_run` 幾乎同時完成時（例如同一個代理被兩則不同訊息
分別點名、平行派送前後腳完成；或 loop-in 把同一個代理拉進不同對話），兩次呼叫
都可能讀到同一個舊值、各自加 1 後寫回去，後寫入覆蓋先寫入，等於少算一次請求跟
那次的 token 用量。

**修正**：`supabase/migrations/0024_usage_daily_atomic_increment.sql` 新增
`increment_usage_daily()` 函式，用資料庫端原子的 `INSERT ... ON CONFLICT DO
UPDATE SET x = x + excluded.x` 累加，靠 PostgreSQL 對同一列的寫入鎖保證多個
並發呼叫的加總結果一定正確。`agent-run/index.ts` 的 `upsertUsage()` 改呼叫這個
RPC。

**殘留風險（不在這次修正範圍內）**：`usage_daily` 目前只有「累計計數」，資料庫
或 Edge Function 完全沒有讀取這些數字、跟任何金額上限比對後擋下後續請求的邏輯
——沒有真的「預算上限」執行機制，也沒有各家供應商/模型的單價換算表。這次只修正
「計數本身要原子、不能漏算」，還沒有實作「達到預算上限就擋下」；後者需要額外
定義每個供應商/模型的單價，屬於新功能而不是併發 bug 修正，超出這次範圍。

**實測結果**（真實 PostgREST HTTP，2 項全部 PASS）：
1. 20 個並發 HTTP 請求打 `increment_usage_daily()`（每次 `input_tokens=10,
   output_tokens=5`）：加總結果剛好是 `request_count=20`、`input_tokens=200`、
   `output_tokens=100`，沒有任何一次併發加總被覆蓋掉。
2. 對照組：重現舊的「先讀、應用程式層加、再 upsert」寫法，10 個併發（每個都先讀
   `existing`、`sleep 0.05` 模擬時間差、再寫回 `existing+1`）：結果
   `request_count=1`（應該是 10），證明舊寫法在併發下確實會嚴重漏算，不是假設。

狀態：**已修且實測**（併發計數正確性 + 反向重現舊 bug 全部通過；`deno check`
對照 baseline 零新增錯誤）。

## 靜態檢查總表

| 檔案 | `deno check` 錯誤數（本分支） | baseline（origin/main 逐字不改） | 是否一致 |
|---|---|---|---|
| `supabase/functions/chat-dispatch/index.ts` | 7 | 7 | 是（零新增） |
| `supabase/functions/agent-run/index.ts` | 10 | 10 | 是（零新增） |
| `supabase/functions/worker-task-start/index.ts` | 4 | 4 | 是（零新增） |
| `supabase/functions/_shared/conversationSummary.ts` | 3 | 3 | 是（零新增） |

所有既有錯誤都是 pre-existing（`EdgeRuntime` 全域型別、`anthropic.ts` 既有的
型別窄化問題等），跟這次修正的程式碼無關；用「複製未修改的原始檔案到獨立資料夾
重新 `deno check`、逐一比對錯誤數與位置」的方式確認。

前端：`npm run typecheck`、`npm run lint`（0 errors，2 個跟這次修正無關的既有
`react-refresh` warning）、`npm run build` 全部通過。

## Migration 編號協調（殘留事項）

這個分支從 `origin/main` 獨立切出，跟同樣未合併的 PR #45（Phase A，用
`0019_cross_account_security_fixes.sql`）、PR #44（用 `0019_shared_knowledge.sql`
+ `0020_knowledge_retrieval_indexes.sql`）各自獨立編號。這個分支用 `0021`~`0024`。
三個分支的 migration 檔名最終需要由合併順序最後的那一個依實際合併結果重新編號，
在此標註供之後合併時參考。

## 部署後驗收（尚需真實 Supabase／瀏覽器／真實付費 LLM 才能做的項目）

- 項目 6：真的建立 Managed Agents session、用瀏覽器連點「開始執行」按鈕，確認
  只會扣一次費用、只產生一個真的 session（這次只驗證了資料庫層的原子搶占）。
- 項目 7：接上真的三家供應商 API key，用瀏覽器實際發訊息、模擬網路中斷，確認
  `agent-run` 真的執行、`agent_runs.status` 正確反映結果。
- 項目 9：瀏覽器實際測試斷網情境下的訊息送出與自動重試 UX。
- 項目 10：真的讓對話累積超過 300 則積壓訊息，確認摘要文字本身的品質與
  `summary_covered_until` 在真實 Supabase Edge Runtime（含 `EdgeRuntime.waitUntil`）
  下的行為跟本機測試一致。
- 項目 16：接上真實用量後，確認 `usage_daily` 的數字跟供應商帳單對得上。

## 確認

- 本分支未合併、未部署到任何網站或 Edge Function、未修改正式 Supabase。
- 所有測試都在本機一次性建立、測試完即丟棄的 PostgreSQL 資料庫上執行；沒有
  使用真實付費模型呼叫做任何測試。
