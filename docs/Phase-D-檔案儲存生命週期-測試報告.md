# 17 項修正與升級執行計劃 D 階段：檔案儲存生命週期修正 測試報告

日期：2026-09-29
基準：`origin/main` `fa126b56b8463477d717e6738707d000ed94b5df`（PR #44、#45、#46、#47 均尚未合併，
此分支從 main 獨立切出，未包含另外四個 PR 的變更，跟 Phase A/B/C 三個階段各自獨立
的作法一致）
涵蓋：17 項修正與升級執行計劃項目 5、11、12、15。項目 16（預算上限執行機制）與
項目 17（完整 CI 覆蓋 Phase D、`deno check` 擋 CI）**不在這次範圍內**，維持後續工作。

## 0. 這四項原本只有一句話的標籤，這次補上的技術判斷

`docs/17項計劃-ABC整合測試報告.md` 只留下「項目 5、11、12、15（刪房後檔案下載、檔案
登記核對、PDF 僅按需送出、Storage 清理）」這樣一句話的標籤，沒有更詳細的規格文件。
這次先讀程式碼重建每一項實際指的是什麼問題，再動手修正——不是照著一份現成規格清單
打勾，過程與判斷依據如下。

### 項目 5：刪房後檔案下載

- `files` 資料表早在 `0012_workspace_owner_id.sql` 就已經徹底跟房間解耦：`owner_id`
  才是真正歸屬，`room_id` 在房間被刪除時會被 `SET NULL`（不是 cascade 刪除，見該
  migration 第 96-99 行），`files_select_own` RLS policy 也只看 `owner_id = auth.uid()`，
  完全不管 `room_id` 還在不在。
- 但 Storage bucket 本身的 RLS（`0002_storage.sql` 的 `room_files_select_member`）
  從來沒有跟著更新，仍然只看「檔案路徑第一段的 `room_id`，使用者現在是不是這個房間
  的成員」。房間被刪除時，`room_members` 會 cascade 刪光（`room_id references
  rooms(id) on delete cascade`），導致 `is_room_member()` 對任何人（包含檔案擁有者
  自己）都回傳 `false`。
- 前端 `getFileDownloadUrl()`（`src/features/files/useFiles.ts`）呼叫的
  `createSignedUrl()` 本身就需要通過這條 RLS 才簽得出網址——不是「簽出來的網址之後
  失效」，是「房間一刪除，連網址都簽不出來」。
- 結論：這是「檔案理論上應該還在、卻永遠拿不回來」的正確性缺陷，不是資料外洩型的
  安全漏洞（是變得太嚴、不是太鬆）。已用下面 3.1 節的 RLS 角色切換測試證實。

### 項目 11：檔案登記核對

- `file-register/index.ts` 的 10MB／MIME 白名單檢查，只驗證請求 body 裡使用者
  「自己宣稱」的 `sizeBytes`／`mimeType`，從來沒有跟 Storage 裡真正上傳的物件核對過。
- `room-files` bucket 建立時（`0002_storage.sql`）沒有設定 `file_size_limit`／
  `allowed_mime_types`，代表任何人直接呼叫 Storage API（不透過前端 UI）都能上傳任意
  大小、任意類型的檔案，`file-register` 只是照抄一份使用者自己填的數字寫進 `files`
  表，兩個獨立的資料來源（真正上傳的物件 vs. 使用者宣稱的中繼資料）從未互相核對。
- 結論：這是「宣稱值可以跟實際值不一致、且完全沒人發現」的資料完整性缺陷，會讓
  `size_bytes`（可能用在配額顯示）、`mime_type`（決定要不要跑 mammoth/xlsx 解析、
  要不要被當 PDF 原生文件輸入送給供應商）都可能被污染。已用下面 3.2 節的三個情境
  （物件不存在／宣稱值造假／真實物件超過上限）證實。

### 項目 12：PDF 僅按需送出

- `workspaceContext.ts` 的 `buildPdfDocuments()` 原本不管這次對話內容，每一次
  `agent-run` 都無條件下載、base64 附加使用者名下最近的（最多 2 份）PDF，當作原生
  文件輸入送給供應商——PDF 原生文件輸入是三家供應商公認很貴的輸入型態（程式碼裡的
  既有註解就寫著「一頁至少兩三百 token 起跳」）。
- 結論：這是成本浪費，不是功能缺陷或安全問題——使用者問一句「今天天氣如何」也會
  被夾帶一份完全無關的 PDF。已用下面 3.3 節的純函式單元測試證實新的關鍵字比對邏輯。

### 項目 15：Storage 清理

- `approval-decide/index.ts` 的 `file.delete` 執行邏輯原本的註解就寫著：「軟刪除：
  先標記 `deleted_at`，物件本身之後由排程清理（對應原始規劃文件 7.5 節）」——這個
  排程從來沒有真的做出來。`files.status` 改成 `deleted` 之後，Storage 裡的實體物件
  （跟它佔用的空間）永遠留著，且因為它的路徑沒變，只要呼叫端還是房間成員或（這次
  項目 5 新增的）檔案擁有者，這個「已刪除」的物件其實還是能被下載——soft delete
  並沒有真的收回下載權限，只是列表看不到而已。
- 結論：這同時是儲存空間成本問題（物件永遠不會被清掉）跟存取控制問題（軟刪除沒有
  真的收回下載權限）。已用下面 3.4 節的真實 Deno 執行證實。

## 1. 修正內容

| 項目 | 檔案 | 修正 |
|---|---|---|
| 5 | `supabase/migrations/0019_file_storage_lifecycle.sql` | 新增 `room_files_select_owner` policy：檔案擁有者（`public.files.owner_id = auth.uid()` 且 `status='active'`）永遠能存取自己的物件，跟既有的房間成員 policy 並存（Postgres 對同一指令的多個 permissive policy 用 OR 合併，不影響既有行為） |
| 11 | `supabase/migrations/0019_file_storage_lifecycle.sql`（bucket 限制）+ `supabase/functions/file-register/index.ts`（`verifyUploadedObject()`） | bucket 層設定 `file_size_limit=10485760`／`allowed_mime_types`（Storage 原生擋下，不用等到 file-register 才擋）；file-register 改用 Storage `list()` API 讀出物件真正的 `size`／`mimetype`，寫進 `files` 表跟做各項檢查一律用這個真實值，不是請求 body 裡使用者宣稱的值；物件不存在直接拒絕登記 |
| 12 | `supabase/functions/_shared/workspaceContext.ts`（新增 `isFileNameReferencedInText()`，`buildPdfDocuments()` 加上 `recentText` 參數）+ `supabase/functions/agent-run/index.ts`（呼叫端傳入最近對話文字） | 只有這次對話最近提到的檔名，才會被當作「使用者這次真的需要這份 PDF」而下載附加；完全沒提到任何檔名時回傳空陣列，不退回「猜最近的幾份」這種還是會花錢的 fallback |
| 15 | `supabase/functions/approval-decide/index.ts` | DB 軟刪除成功之後（安全關鍵的存取權限收回已經完成），才嘗試呼叫 Storage `remove()` 真的刪除物件；`remove()` 失敗不會讓整個核准回報失敗，但會誠實寫進 `audit_logs.metadata.storageRemoved`，供之後人工排查 Storage 用量時直接查出哪些刪除沒清乾淨 |

## 2. 測試方法論

延續 Phase A/B/C／ABC 整合測試已驗證過的本機測試基礎設施：standalone PostgreSQL +
standalone PostgREST（真實 HTTP + RLS）+ standalone Deno（直接執行未修改的 Edge
Function 原始檔）。Storage 沒有可用的本機服務（沒有 Docker，也沒有真實 Supabase
專案），這次在既有「假端點」手法（`chat-dispatch` 測試已經在用同一種手法假
`agent-run` 端點）之上，額外幫 Storage 的 `list()`／`remove()` 兩個 HTTP API 做了
最小 stub，讓 `file-register`／`approval-decide` 真的執行到會呼叫 Storage 的那段
程式碼，不是只讀程式碼假設行為；`download()`（文字擷取路徑）跟真正的檔案位元組
內容不在這次的 stub 範圍內，見第 4 節測試限制。

測試腳本：`scripts/phase-d-regression-test.sh`（單一腳本涵蓋全部四項，可重跑，
`POSTGREST_BIN=... DENO_BIN=... bash scripts/phase-d-regression-test.sh`）。

## 3. 逐項實測結果（2026-09-29，本機實際執行）

### 3.1 項目 5：Storage RLS 角色切換測試

直接用 `psql` 切到 `authenticated` 角色、設定 `request.jwt.claim.sub`，測試真正的
RLS 判斷式（跟透過 PostgREST HTTP 測的是同一段 SQL 邏輯，少繞一層 HTTP）：

```
PASS: 房間還在、非擁有者的房間成員可以看到這個物件（既有 room_files_select_member policy 沒有被破壞）
PASS: 確認房間刪除後 room_members 真的被 cascade 刪光（模擬前提成立）
PASS: files 這一列如預期存活（room_id 被 SET NULL，status 仍是 active，0012 migration 的既有行為）
PASS: 【修正生效】房間刪除後，檔案擁有者仍然能看到（進而能 createSignedUrl 下載）自己的物件——修正前這裡會是 0
PASS: 非擁有者（前房間成員、不是這個檔案的 owner_id）房間刪除後看不到——新 policy 只保留給檔案擁有者，沒有過度放寬
PASS: 檔案軟刪除後，就算是擁有者，新 policy 也不再放行
```

### 3.2 項目 11：file-register 真實 Deno 執行測試

```
=== Storage 真正記錄的物件不存在時，直接拒絕 ===
PASS: Storage 裡真的找不到這個物件時，file-register 拒絕登記（HTTP 400）
PASS: 沒有留下任何『查無實體』的 files 紀錄

=== 使用者宣稱的中繼資料跟 Storage 真正記錄的不一致時，以 Storage 真正記錄的為準 ===
PASS: 登記成功（謊報的欄位不會直接被當成拒絕理由，而是被真實值取代）
PASS: 資料庫裡實際存的 size_bytes 是 Storage 真正記錄的 2048，不是使用者謊報的 1

=== Storage 真正記錄的物件超過 10MB 時要被拒絕，即使使用者宣稱的 sizeBytes 沒有超過 ===
PASS: Storage 真正記錄的物件超過 10MB，就算使用者宣稱的值沒超過，還是被拒絕——關住了『謊報小 size 繞過上限』的漏洞
PASS: 超過上限的物件沒有被登記進 files 表
```

### 3.3 項目 12：`isFileNameReferencedInText()` 純函式單元測試

```
PASS: 訊息直接提到完整檔名（含副檔名）
PASS: 訊息只提到檔名本體、沒打副檔名
PASS: 訊息完全沒提到這份檔案
PASS: 大小寫不敏感（英文檔名）
PASS: 檔名去掉副檔名後只剩 1 個字元，不納入比對避免誤判
```

### 3.4 項目 15：approval-decide 真實 Deno 執行測試

```
=== DB 軟刪除成功後，真的會呼叫 Storage remove() ===
PASS: file.delete 核准成功（HTTP 200）
PASS: DB 層確實軟刪除成功（status=deleted）
PASS: 真的呼叫了 Storage 的 remove()，帶正確的 bucket／object_path
PASS: audit_logs 正確記錄 storageRemoved=true

=== Storage remove() 失敗時，DB 軟刪除仍然成功、approval 仍然回報 executed ===
PASS: 即使 Storage remove() 失敗，approval 仍然回報成功（HTTP 200，安全關鍵的 DB 狀態已經達成）
PASS: DB 層仍然確實軟刪除成功（status=deleted），不受 Storage 失敗影響
PASS: audit_logs 誠實記錄 storageRemoved=false，之後人工排查 Storage 用量時可以直接查出這筆沒清乾淨
PASS: approval_requests 狀態是 executed（不是 failed）——核准動作本身沒有失敗
```

全部測項（含 4.1 節的靜態檢查）在同一次執行裡 `=== 全部通過 ===`。

## 4. 前端／Edge Function 靜態檢查

```
npm run typecheck   # tsc -b --noEmit：通過，0 錯誤
npm run lint         # eslint .：0 錯誤，2 個既有 warning（AuthProvider.tsx／AppLayout.tsx
                      # 的 react-refresh/only-export-components，跟這次改動無關）
npm run build         # tsc -b && vite build：通過
```

`deno check` 對照 `origin/main` 未修改版本，逐一比對錯誤代碼與數量：

| 檔案 | Baseline | 這次分支 | 新增錯誤 |
|---|---|---|---|
| `approval-decide/index.ts` | `TS2345` x1 | `TS2345` x1 | **0** |
| `file-register/index.ts` | `TS2345` x1 | `TS2345` x1 | **0** |
| `agent-run/index.ts` | `TS2304` x1, `TS2322` x1, `TS2339` x6, `TS2345` x1, `TS7006` x1 | 同左，完全一致 | **0** |

三個檔案的既有型別問題（跟這次改動無關）數量與種類完全沒有變化，這次的改動本身
沒有引入任何新的型別錯誤。`deno check` 仍然不在任何 CI 裡（項目 17 的既有缺口，
這次沒有處理）。

## 5. 測試限制（誠實列出，沒有做/做不到的部分）

- **沒有真實 Supabase Storage 服務**：`list()`／`remove()` 用最小 HTTP stub 模擬，
  沒有驗證過跟真實 Supabase Storage API 的請求/回應格式逐位元組一致，只依照公開
  文件描述的形狀（`list()` 回傳 `{name, id, metadata:{size, mimetype, ...}}` 陣列，
  `remove()` 是 `DELETE .../object/{bucket}` 帶 `{prefixes:[...]}`）建構；`download()`
  （`extractTextChunks()` 用到的路徑，這次沒有改動邏輯）完全沒有 stub，這次的測試
  刻意都用 `image/png`（不會觸發文字擷取）繞開這個限制。部署後建議至少手動測試一次
  「上傳 PDF/DOCX → file-register 成功登記 → 文字確實被擷取進 file_text_chunks」，
  確認跟真實 Storage 服務互動時行為一致。
- **項目 15 沒有回填既有的孤兒物件**：這次的修正只讓「往後每一次 file.delete」都會
  嘗試清理 Storage，對於**這次修正上線之前**就已經軟刪除、但從來沒有被清理過的
  Storage 物件（如果有正式環境已經在跑，累積到現在可能已經有這種孤兒物件），不會
  被這次的程式碼追溯性清掉，需要部署者自行到 Storage Dashboard 或寫一次性腳本核對
  `files.status='deleted'` 但 Storage 裡仍然存在的物件。
- **項目 12 的關鍵字比對是保守的字面比對**：使用者用完全不含檔名的方式描述（例如
  「我上禮拜傳的那份文件」而不是報出檔名）不會命中，這是刻意的保守選擇（見
  workspaceContext.ts 裡的說明）——沒有比對到就不送，不會為了提高命中率而退回
  「送最近幾份」這種違反「僅按需送出」精神的 fallback，但確實會犧牲一些命中率。
  這個取捨沒有再往下做語意比對或詢問使用者要不要附加，超出這次修正範圍。
- **沒有任何一次呼叫真的打到 Anthropic／OpenAI／Google 的正式付費端點**，也沒有用
  真的 Supabase 專案或正式 Storage bucket。
- **項目 16、17 明確不在這次範圍內**：`usage_daily` 仍然只有原子計數，沒有預算上限
  執行機制；`deno check` 仍然只是「印出來但不擋 CI」，Phase D 這支測試腳本目前也還
  沒有接進任何 CI workflow（main 上目前沒有 CI 涵蓋這支腳本，需要之後跟其他階段一起
  整合進 CI，比照 `integration-abc-regression.yml` 的作法）。

## 6. Migration 編號協調

此分支獨立於 PR #44（`0019`/`0020`）、PR #45（`0019`）、PR #46（`0021`~`0024`）、
PR #47（整合後的 `0019`~`0026`），用 `0019_file_storage_lifecycle.sql`。這個分支
最終需要在合併順序最後的整合步驟裡重新編號（比照 PR #47 把 #44/#45/#46 重新編號
的作法），不在這次修正範圍內處理。

## 7. 部署順序（合併後）

1. 到 Supabase Dashboard 的 SQL Editor 執行
   `supabase/migrations/0019_file_storage_lifecycle.sql`（實際編號依整合時的結果
   為準）。
2. GitHub Actions 自動部署有改動的 Edge Function（`file-register`、
   `approval-decide`、`agent-run`）。
3. 部署後建議：
   - 用一個測試帳號建一個房間、上傳一份 PDF、發一則提到檔名的訊息，確認 AI 回覆時
     真的有附加這份 PDF；再發一則完全無關的訊息，確認這次沒有附加。
   - 上傳一份檔案、刪除所在房間，確認自己還能在「檔案」分頁下載這份檔案。
   - 走一次 file.delete 核准流程，到 Storage Dashboard 確認物件真的被刪除。
   - 依第 5 節的建議，人工核對正式環境裡有沒有這次修正上線前就已經軟刪除、但
     Storage 物件還留著的既有孤兒資料。

## 8. 確認

- 這個分支（`claude/phase-d-file-storage-lifecycle`）沒有合併、沒有部署到任何網站
  或 Edge Function、沒有修改正式 Supabase。
- 所有測試都在本機一次性建立、測試完即丟棄的 PostgreSQL 資料庫上執行；沒有使用
  真的付費模型、真的 Storage、正式 Supabase 做任何測試。
- PR #47（三個階段的整合分支）維持待審狀態，沒有因為這個新 PR 而被合併或部署。
