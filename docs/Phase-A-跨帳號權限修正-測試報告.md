# Phase A：跨帳號權限隔離修正——測試報告

日期：2026-09-23
基準：`main` `fa126b56b8463477d717e6738707d000ed94b5df`
分支：`claude/phase-a-cross-account-security`
範圍：17 項修正計劃「A．權限隔離與核准」——項目 1、2、3、8

## 0. 測試方法（比之前幾輪更嚴謹的地方）

跟先前 PR #44 幾輪 review 用簡化 fixture 測 RLS/trigger 不同，這次：

1. **套用 `main` 實際的 18 個既有 migration**（`0001_init.sql` ~ `0018_worker_task_notebook_tool.sql`，一字不改，只在本機測試固定裝置額外補了 `storage`／`vault` 這兩個 Supabase 平台 schema 的最小樁——這個 repo 目前只有 `0002_storage.sql`／`0009_byok_api_keys.sql` 摸到它們，Phase A 四項都不依賴它們的實際行為），不是重新手刻一份簡化 schema。
2. **真的起了 PostgREST**（standalone 靜態執行檔，不需要 Docker），用跟 Supabase 正式環境一致的 JWT 驗證機制（`auth.uid()` 讀 `request.jwt.claims` 的 `sub`），對兩個測試帳號簽發真正的 JWT，透過**真實 HTTP 請求**測 RLS，而不是用 superuser 或手動 `SET ROLE` 模擬。
3. **真的起了 Deno**（standalone 執行檔），直接執行專案裡未經修改的 `approval-decide/index.ts`，搭配一個十幾行的本機閘道（把 `/rest/v1/*` 轉給 PostgREST、`/auth/v1/user` 解 JWT 回傳），讓 Edge Function 本身的程式碼邏輯（不是重寫的等價邏輯）真的被執行到。
4. **併發測試用兩個真正獨立的背景 HTTP 請求**（bash `&`/`wait`），不是同一個連線序列呼叫兩次。

仍然做不到的（環境限制，如實記錄）：`chat-dispatch`／`agent-run` 因為還會呼叫其他 Edge Function、Vault、外部供應商 API，這次沒有整支用 Deno 執行；項目 3 的 `chat-dispatch` 二次驗證是**程式碼審閱＋針對那段查詢邏輯單獨用 PostgREST 驗證同一個查詢條件**，不是完整執行整支函式。Storage 物件本身（真正的檔案上傳/下載）這個環境沒有 Docker 起不了，不在 Phase A 測試範圍內（Phase A 的項目都不需要真的操作 Storage 物件）。

## 1. 項目 1：`room_members_insert_owner` 自行入會

**先重現（對著未修改的 `main` 程式碼）**：A、B 兩個帳號，B 建立房間。A 用自己的 JWT 直接 POST `/room_members`，body 是 `{room_id: B的房間, user_id: A自己}`。

```
HTTP 201
```

A 成功把自己加進 B 的房間，之後能查到 B 房間的 `room_members` 列。（用 `Prefer: return=representation` 重新呼叫這個端點會拿到 403——這是 PostgreSQL 對 `INSERT ... RETURNING` 額外套用 SELECT policy 的已知行為，跟這個 repo `0001_init.sql` 自己註解描述 `rooms_select_member` 的那個情境一樣；不加這個 header 時，插入本身確實成功，用一次獨立查詢確認新列已經寫入。）

**修正**：`supabase/migrations/0019_cross_account_security_fixes.sql`，拿掉 policy 裡 `or user_id = auth.uid()` 這個分支，只保留「房主可以幫房間加成員」。

**修正後重測**：

| 測項 | 結果 |
|---|---|
| A 直接 POST 加入 B 的房間 | `HTTP 403`，`42501 new row violates row-level security policy`；查詢確認 `room_members` 沒有新增這一列 |
| B 的 owner membership 仍然是 1 筆 | ✅ |
| A 建立自己的新房間（驗證 `handle_new_room()` trigger 沒被連帶破壞） | `HTTP 201`，正常建立 |
| A 讀 B 房間的 `messages`／`agents`／`approval_requests`（`is_room_member()` 全部依賴 `room_members`） | 全部 `[]`，確認拿不到 membership 之後這些連帶權限也一起被擋下 |

## 2. 項目 2：`approval-decide` 的 `file.delete` 沒驗證 owner

**先重現（未修改的 `approval-decide/index.ts`，真的用 Deno 執行）**：B 有一個檔案（`owner_id = B`）。A 在**自己的房間**建立一筆 `approval_requests`（`room_id` 是 A 自己有權限的房間，`requested_by = A`），`arguments_json.fileId` 填 B 的檔案 id——`approval_requests_insert_member` 這條 RLS policy 只檢查「這一列的 room_id/requested_by 是不是自己」，完全不檢查 `arguments_json` 裡任意塞的內容。A 再呼叫 `approval-decide` 核准自己建的這筆請求（`room_members` 檢查會過，因為房間是 A 自己的）。

```
POST /approval_requests  -> HTTP 201（A 自己房間的合法請求，內容夾帶 B 的 fileId）
POST /approval-decide {"decision":"approved"}  -> HTTP 200 {"status":"executed"}
```

B 的檔案 `status` 從 `active` 變成 `deleted`——A 完全沒有這個檔案的權限，卻透過「先幫自己的房間建一筆核准請求、內容指向別人的資源」刪掉了它。

**修正**：`executeTool()` 的 `file.delete` 分支改成：
```ts
.update({ status: "deleted", deleted_at: ... })
.eq("id", fileId)
.eq("owner_id", approverId)   // 新增：核准者本人的 auth.uid()
.eq("status", "active")        // 新增：避免對已刪除的檔案重複執行
.select("id").maybeSingle();
if (!data) throw new Error("找不到可刪除的檔案，或這個檔案不屬於你");
```
零筆更新（檔案不存在/不是自己的/已經刪除）視為失敗，不再默默回報成功。

**修正後重測**：

| 測項 | 結果 |
|---|---|
| A 核准指向 B 檔案的請求 | `HTTP 500 execution_failed`；B 的檔案 `status` 仍是 `active`；該筆 `approval_requests.status` 變成 `failed`（不是誤報 `executed`） |
| A 核准指向**自己**檔案的請求（合法路徑） | `HTTP 200 {"status":"executed"}`；檔案正確變成 `deleted` |

## 3. 項目 3：跨房間點名

**先重現（未修改的 `0001_init.sql` RLS + 未修改的 `chat-dispatch`）**：A 在自己房間發一則訊息，直接 POST `/message_mentions`，`agent_id` 填 B 房間裡的代理 id。

```
HTTP 201
```

成功插入——`message_mentions_insert_own` 原本只檢查「這則訊息是不是我發的」，不檢查 `agent_id` 屬於哪個房間。

**修正**：
1. `message_mentions_insert_own` policy 改成同時 join `agents`，要求 `agent.room_id = message.room_id`。
2. `chat-dispatch` 查 `targetAgents` 時加上 `.eq("room_id", message.room_id)`，當資料庫層之外的第二層防禦。

**修正後重測（資料庫層，真實 HTTP）**：

| 測項 | 結果 |
|---|---|
| A 在自己房間的訊息底下點名 B 房間的代理 | `HTTP 403`，`42501`；`message_mentions` 沒有新增這一列 |
| A 點名自己房間裡的代理（合法路徑） | `HTTP 201`，正常插入 |

`chat-dispatch` 的 `.eq("room_id", ...)` 這段屬於**程式碼修正＋邏輯審閱**：因為上面的 RLS policy 已經讓「新增跨房間點名」這個動作本身在資料庫層就不可能發生，`chat-dispatch` 這段是第二層防禦（例如未來如果哪個內部流程改用 service_role 直接寫入 `message_mentions` 而繞過這條 RLS，這裡還能擋住），沒有用 Deno 完整執行整支 `chat-dispatch`（它還會呼叫 `agent-run`、Vault 等其他依賴，這次沒有搭建），但查詢條件本身（`agents` 表加 `room_id` 篩選）跟上面已經驗證過的 RLS join 邏輯一致，且 `deno check` 確認這個改動沒有引入新的型別錯誤（詳見第 5 節）。

## 4. 項目 8：核准原子化與過期

**先重現（未修改的 `approval-decide`，真的用 Deno 執行，兩個真正獨立的背景 HTTP 請求同時送出同一個 `approvalId`）**：

第一次嘗試（真實時序，兩個請求幾乎同時抵達）：req1 拿到 `executed`，req2 拿到 `409 already_decided`，`audit_logs` 只有 1 筆——這次剛好沒有觸發競態（時序運氣，TOCTOU 視窗本來就不保證每次都會撞上）。

為了可靠重現，在**另一份獨立的除錯用副本**（不是提交到分支的檔案）裡，在「讀 `status` 判斷」跟「執行工具」之間人為加一個 400ms 延遲，撐開競態視窗，再送出同樣的兩個並發請求：

```
[req1] {"status":"executed"}   HTTP 200
[req2] {"status":"executed"}   HTTP 200
audit_logs: file.delete.executed  count=2
```

兩個請求都回報成功，`file.delete` 被實際執行兩次，稽核紀錄也留下兩筆——確認這是一個真實、可重現的競態，不是一次性巧合。

**修正**：`supabase/migrations/0019_cross_account_security_fixes.sql` 新增 `executing` 中繼狀態；`approval-decide` 改成先用條件式 `UPDATE ... WHERE status = 'pending'`（PostgreSQL 對同一列的並發 UPDATE 保證只有一個交易能搶到）原子搶占 `pending -> executing`／`pending -> rejected`，搶不到（0 筆）的請求直接回 `409`，不會執行任何工具；`decision === "approved"` 前先檢查 `expires_at`，過期就標記 `expired` 並回 `410`，不進入搶占流程。

**修正後重測**：

| 測項 | 做法 | 結果 |
|---|---|---|
| 兩個真正並發的核准請求（無人為延遲，貼近真實時序） | 兩個背景 HTTP 請求同時打同一個 `approvalId` | ✅ 1 個 `executed`（HTTP 200），1 個 `409 already_decided`；`audit_logs` 只有 1 筆 `executed`；檔案正確變成 `deleted` 一次 |
| 已過期的核准請求（`expires_at` 設在過去） | A 核准一筆 `expires_at: 2020-01-01` 的請求 | ✅ `HTTP 410 expired`；檔案維持 `active`，執行 0 次；`approval_requests.status` 變成 `expired` |
| 核准／拒絕同時送出同一筆請求（互斥終態） | 一個請求核准、一個請求同時拒絕 | ✅ 核准贏得這次競賽（`executed`），拒絕拿到 `409`；最終只有一個終態（`executed`），沒有出現核准又拒絕的矛盾紀錄 |

（沒有重跑「加人為延遲」版本的併發測試，因為修正後的原子性來自 PostgreSQL 對單一列的 row lock，不是「應用層剛好夠快」——延遲加在「搶占 UPDATE 之前」不會改變 UPDATE 陳述式本身的原子性；上面「無延遲、真正並發」的測試已經是符合 KPI 描述情境的直接驗證。）

## 5. 型別檢查／lint／build

```
$ npm run typecheck   # tsc -b --noEmit → 無錯誤
$ npm run lint        # eslint . → 0 error（2 個跟這次改動無關的既有 warning）
$ npm run build        # tsc -b && vite build → 建置成功
```

另外用 `deno check` 個別檢查這次改動到的兩支 Edge Function：
- `approval-decide/index.ts`：有 1 個既有型別錯誤（`jsonError()` 呼叫少帶一個參數，`code`／`extraHeaders` 對不上，導致這個特定的 400 回應少了 CORS header），**這個錯誤在未修改的 `main` 版本就已經存在**，不是這次修正引入的，這次的改動沒有增加新的 `deno check` 錯誤（原本 1 個，改完還是 1 個，且是同一行）。
- `chat-dispatch/index.ts`：有 7 個既有型別錯誤（`EdgeRuntime` 全域型別、`user` 可能是 `null`、`anthropic.ts` 內的既有問題、同樣的 `jsonError` 呼叫問題），跟未修改的 `main` 版本逐一比對，**錯誤數與位置完全相同**，這次的改動（加一行 `.eq("room_id", ...)`）沒有新增任何錯誤。
- `deno check` 目前**不是**這個 repo CI（`.github/workflows/check.yml`）的一部分，只跑 `npm run lint/typecheck/build`（純前端 `src/`，不含 `supabase/functions/`）。這是項目 17（CI 回歸閘門）尚待補上的缺口，這次先如實記錄、不在 Phase A 範圍內修正。

## 6. 沒有做、也做不到的測試（誠實列出）

1. `chat-dispatch`／`agent-run` 整支函式沒有用 Deno 完整執行過（它們還會呼叫其他 Edge Function、Vault、外部供應商 API），項目 3 的 `chat-dispatch` 二次防禦只驗證了查詢邏輯本身，不是整支函式的端到端行為。
2. Storage 物件（真正的檔案上傳/下載）：這個環境沒有 Docker，起不了 Supabase Storage API，Phase A 四項都不需要操作真正的 Storage 物件，所以沒有測，但項目 1 提到「Storage 物件也被拒」這件事仍待部署後用真實 Storage 驗證（是否也依賴 `is_room_member()`，理論上會，但沒有實測）。
3. 瀏覽器互動測試：前端目前沒有 UI 直接呼叫這幾個修正過的路徑產生新畫面（`approval-decide` 走既有的檔案刪除按鈕，UI 本身沒有改動），型別檢查/建置通過，但沒有在真實瀏覽器點過。
4. 這次的併發測試只驗證了兩個並發請求的情境（符合 KPI 描述），沒有測試更大量（例如 10+ 並發）的核准請求。

## 7. 部署後驗收清單

1. 套用 `0019_cross_account_security_fixes.sql`（跟 PR #44 的 `0019_shared_knowledge.sql` 序號衝突，需要協調由哪一個先合併、後合併的重新編號成 `0020`）。
2. 用兩個真實帳號重複本報告第 1～4 節的操作（透過瀏覽器或直接呼叫 API），確認生產環境的 PostgREST／Edge Function 部署後行為與本機測試一致。
3. 確認 Storage policy（`storage.objects` 的 `room_files_select_member`/`insert_member`）在拿掉自行入會之後，跨帳號物件存取確實被擋（本機沒有真實 Storage 可測）。
