# 17 項修正與升級執行計劃 D 階段：檔案儲存生命週期修正 測試報告

日期：2026-09-29
基準：**PR #47**（`claude/integration-abc-17plan`，commit `f8849b7`，已整合 A/B/C 三階段
的修正與 PR #47 自己兩輪審閱意見的修正）——**不是**獨立以 `main` 為基底。
涵蓋：17 項修正與升級執行計劃項目 5、11、12、15。項目 16（預算上限執行機制）與
項目 17（完整 CI 覆蓋、`deno check` 擋 CI）**不在這次範圍內**，維持後續工作；第 6
節明列項目 11、12、15 對照原計劃仍未達成的部分。

## 0. 這一版跟先前版本的差異（審閱意見回應）

這是 D 階段的第二版。第一版（PR #48）獨立以 `main` 為基底、沒有接進 CI，審閱後要求
重做，具體變更：

1. **改以 PR #47 的分支為基底整合**，不是獨立以 main 為基底——保留 PR #47 已經整合
   過的 `approval-decide` 原子核准流程（`pending -> executing -> executed/failed`，
   PR #47 項目 8 修正）跟項目 2 的 `owner_id`／`status='active'` 跨帳號刪檔驗證，D 階段
   只在這個已經正確的基礎上加 Storage 清理，不重新實作或繞過這些既有保護。Migration
   重新編號為 `0027_file_storage_lifecycle.sql`（PR #47 分支目前到 `0026`）。
2. **新增測項：跨帳號刪檔不得移除 Storage 物件**（見 3.4 節）——證明 D 階段新增的
   Storage `remove()` 呼叫，在 PR #47 既有的 owner_id 檢查判定「不是你的檔案」時，
   完全不會被執行到，不會出現「DB 拒絕了，但 Storage 物件還是被清掉」這種矛盾狀態。
3. **修改既有的 `room_files_select_member` policy**（0002_storage.sql 建立以來就有的
   舊 policy），讓它也檢查 `files.status = 'active'`，不是只加一條新 policy——這樣
   軟刪除即使 Storage 實體清理失敗，也不會有任何人（不管是房間成員還是檔案擁有者）
   能繼續簽出新的下載網址。過程中這個改動本身踩到一個真實的 RLS 陷阱，見 1.1 節。
4. **PDF 附檔改成只依「觸發這次 agent-run 的那一則訊息本身」**，不是依整段對話歷史
   （`recentTextForKnowledge`）——避免「使用者曾經在任何一則歷史訊息提過某份 PDF
   的檔名，之後每一則完全無關的新訊息都會被重新附加」這個問題。
5. **明列項目 11、12、15 對照原 17 項計劃仍未達成的 KPI**，見第 6 節。
6. **D 階段回歸測試接進 CI**（`.github/workflows/integration-abc-regression.yml` 新增
   `phase-d-regression` job），不再是「寫了測試但沒人跑」。

## 1. 這次額外發現、修正的問題

### 1.1（實作過程中發現）SECURITY DEFINER 陷阱：RLS policy 裡查 `files` 表會被 `files` 自己的 RLS 過濾掉

第一次寫 `room_files_select_member` 的修改版本時，直接在 policy 的 `using` 子句裡寫
`exists (select 1 from public.files f where f.object_path = storage.objects.name and
f.status = 'active')`。**本機測試立刻抓到這個寫法是錯的**：`files` 表本身有
`files_select_own`（`owner_id = auth.uid()`）這條 RLS，這個 exists 子查詢是以「目前
正在查詢 storage.objects 的那個角色」執行的，一樣受 `files_select_own` 過濾——非
擁有者呼叫時，子查詢完全看不到「別人的」files 列（就算那一列真的存在、真的是
active），`exists` 恆為 false，會把「房間成員應該看得到別人上傳的檔案」這個既有
行為整個弄壞（不是理論推測，是本機測試第一輪就直接重現：房間成員原本看得到、
改完之後看不到了）。

修正：仿照既有的 `is_room_member()`（同一個陷阱、同一種解法，這個函式本來就是
`security definer`），新增 `public.room_file_status_for_object(p_object_path text)`
函式，用 `security definer` 讓查詢以建立 migration 的角色（擁有這些表、不受
`files` 自己的 RLS 限制）執行，回傳「這個物件路徑對應的 files 列，不論是誰的」，
兩條 storage policy 再各自判斷 owner_id／status。這是先重現錯誤、再修正、再驗證的
方法論在這次修正裡最直接的體現——如果只讀程式碼不跑測試，這個問題不會被發現。

## 2. 四項原本只有一句話標籤的技術判斷（沿用第一版的判斷，未變更）

（詳細判斷過程同第一版報告，這裡摘要結論；完整推導見程式碼裡對應的註解。）

- **項目 5（刪房後檔案下載）**：`files` 早就跟房間解耦（`owner_id` 才是真正歸屬，
  `room_id` 刪房後 `SET NULL`），但 Storage bucket 的 RLS 從未跟進，房間刪除後連
  檔案擁有者自己都無法再簽出下載網址。
- **項目 11（檔案登記核對）**：`file-register` 原本只驗證使用者自己宣稱的
  `size`/`mimeType`，從未跟 Storage 真正上傳的物件核對；bucket 本身也沒有任何限制。
- **項目 12（PDF 僅按需送出）**：`buildPdfDocuments()` 原本無條件下載、附加最近的
  PDF 當原生文件輸入，不管對話內容跟哪份 PDF 有沒有關係。
- **項目 15（Storage 清理）**：`approval-decide` 的 `file.delete` 原本只做軟刪除，
  物件本身從未真的從 Storage 移除（程式碼裡的既有註解自己承認「排程從來沒做出來」）。

## 3. 修正內容與實測結果（2026-09-29，本機實際執行，以 PR #47 分支為基底）

### 3.1 項目 5：Storage RLS（新增擁有者 policy + 修改既有房間成員 policy）

```
PASS: 房間還在、非擁有者的房間成員可以看到這個物件（既有 room_files_select_member policy 沒有被破壞）
PASS: 【修正生效】檔案軟刪除後，房間成員透過既有 room_files_select_member 也看不到了（修正前這裡會是 1，因為舊 policy 完全不看 files.status）
PASS: 檔案軟刪除後，就算是擁有者，新 policy 也不再放行
PASS: 確認房間刪除後 room_members 真的被 cascade 刪光（模擬前提成立）
PASS: files 這一列如預期存活（room_id 被 SET NULL，status 仍是 active，0012 migration 的既有行為）
PASS: 【修正生效】房間刪除後，檔案擁有者仍然能看到（進而能 createSignedUrl 下載）自己的物件——修正前這裡會是 0
PASS: 非擁有者（前房間成員、不是這個檔案的 owner_id）房間刪除後看不到——新 policy 只保留給檔案擁有者，沒有過度放寬
```

### 3.2 項目 11：file-register 真實 Deno 執行測試

```
PASS: Storage 裡真的找不到這個物件時，file-register 拒絕登記（HTTP 400）
PASS: 沒有留下任何『查無實體』的 files 紀錄
PASS: 登記成功（謊報的欄位不會直接被當成拒絕理由，而是被真實值取代）
PASS: 資料庫裡實際存的 size_bytes 是 Storage 真正記錄的 2048，不是使用者謊報的 1
PASS: Storage 真正記錄的物件超過 10MB，就算使用者宣稱的值沒超過，還是被拒絕——關住了『謊報小 size 繞過上限』的漏洞
PASS: 超過上限的物件沒有被登記進 files 表
```

### 3.3 項目 12：`isFileNameReferencedInText()` 單元測試（含「只看觸發訊息」語意驗證）

```
PASS: 觸發訊息直接提到完整檔名（含副檔名）
PASS: 觸發訊息只提到檔名本體、沒打副檔名
PASS: 觸發訊息完全沒提到這份檔案
PASS: 大小寫不敏感（英文檔名）
PASS: 檔名去掉副檔名後只剩 1 個字元，不納入比對避免誤判
PASS: 示範：整段歷史文字比對『會』命中（反例，agent-run 不會這樣呼叫）
PASS: 只傳入這次觸發訊息本身時，同一份檔名『不會』命中——不會因為歷史上出現過就卡住重送
```

呼叫端（`agent-run/index.ts`）改傳 `triggerMessage?.content ?? ""`，不是
`recentTextForKnowledge`（整段歷史），這個差異是架構層面的保證（哪個變數被傳進
去），上面最後兩項單元測試示範的是這個設計決策要解決的具體語意問題。

### 3.4 項目 15：approval-decide 真實 Deno 執行測試（含跨帳號刪檔新測項）

```
=== DB 軟刪除成功後，真的會呼叫 Storage remove() ===
PASS: file.delete 核准成功（HTTP 200）
PASS: DB 層確實軟刪除成功（status=deleted）
PASS: 真的呼叫了 Storage 的 remove()，帶正確的 bucket／object_path
PASS: audit_logs 正確記錄 storageRemoved=true

=== 跨帳號刪檔：不是自己的檔案，不得移除 Storage 物件（PR #48 審閱意見新增）===
PASS: 跨帳號刪檔在 DB 層被拒絕（HTTP 500，execution_failed，延續 PR #47 的既有行為）
PASS: 檔案在 DB 層仍然是 active，沒有被跨帳號核准動到
PASS: 【修正驗證】跨帳號刪檔被 DB 拒絕後，Storage remove() 完全沒有被呼叫
PASS: Storage 物件本身也還在（沒有被跨帳號核准間接清掉）

=== Storage remove() 失敗時，DB 軟刪除仍然成功、兩條 policy 都已經收回存取權限 ===
PASS: 即使 Storage remove() 失敗，approval 仍然回報成功（HTTP 200）
PASS: DB 層仍然確實軟刪除成功（status=deleted），不受 Storage 失敗影響
PASS: audit_logs 誠實記錄 storageRemoved=false
PASS: approval_requests 狀態是 executed（不是 failed）
PASS: Storage 清理失敗時，房間成員也已經看不到這個物件了（存取權限只看 DB 的 files.status，不依賴清理是否成功）
PASS: Storage 清理失敗時，就算是擁有者也已經看不到了
```

全部測項（`scripts/phase-d-regression-test.sh`，可重跑）在同一次執行裡
`=== 全部通過 ===`。

### 3.5 既有的 ABC 整合測試套件重跑（確認沒有破壞既有行為）

D 階段修改了一條 PR #47 分支既有的 storage policy（`room_files_select_member`），
新增了一份 migration（`0027`）。把 `scripts/integration-abc-sql-rpc-test.sh` 跟
`scripts/integration-abc-edge-function-test.sh` 的套用範圍從 `0001~0026` 延伸到
`0001~0027`（並補上兩支腳本各自 `storage.buckets` 樁的 `file_size_limit`／
`allowed_mime_types` 欄位，讓 `0027` 的 `update` 語句能套用），重新跑過：

```
scripts/integration-abc-sql-rpc-test.sh（套用到 0027）        → === 全部通過 ===
scripts/integration-abc-edge-function-test.sh（套用到 0027）  → === 全部通過 ===
scripts/integration-abc-knowledge-required-test.sh（不受影響）→ === 全部通過 ===
```

確認 D 階段的 migration 接在 PR #47 整合後的序列最後套用，不會讓既有測項（項目
1/2/3/4/6/7/8/9/10/13/14/16 跟 agent-run 原子搶占併發邊界）壞掉。

## 4. 前端／Edge Function 靜態檢查

```
npm run typecheck   # tsc -b --noEmit：通過，0 錯誤
npm run lint         # eslint .：0 錯誤，2 個既有 warning（跟這次改動無關）
npm run build         # tsc -b && vite build：通過
```

`deno check` 對照 PR #47 分支（未經 D 階段修改）的版本，逐一比對錯誤代碼與數量：

| 檔案 | Baseline（PR #47 分支） | 這次分支 | 新增錯誤 |
|---|---|---|---|
| `approval-decide/index.ts` | `TS2345` x1 | `TS2345` x1 | **0** |
| `file-register/index.ts` | `TS2345` x1 | `TS2345` x1 | **0** |
| `agent-run/index.ts` | `TS2304` x1, `TS2322` x1, `TS2339` x6, `TS2345` x1, `TS7006` x1 | 同左，完全一致 | **0** |

三個檔案的既有型別問題（跟這次改動無關）數量與種類完全沒有變化。

## 5. CI

`.github/workflows/integration-abc-regression.yml` 新增 `phase-d-regression` job
（下載 postgrest、設定 Deno，執行 `scripts/phase-d-regression-test.sh`），跟既有的
`sql-rpc-regression`／`edge-function-regression`／`knowledge-required-regression`
job 用同一種 CI 結構；`deno-check-no-new-errors` job 的檔案清單加上
`file-register/index.ts`。D 階段的回歸測試從這次開始接進 CI，不再是「寫了測試但
沒有任何自動化機制會去跑」。

## 6. 對照原 17 項計劃，項目 11、12、15 尚未達成的 KPI（誠實列出）

### 項目 11（檔案登記核對）

- **沒有真正的內容型別偵測（magic bytes）**：MIME 類型驗證仍然依賴 Storage 記錄的
  `metadata.mimetype`，而這個值本身來自上傳當下客戶端設定的 `Content-Type` 標頭，
  不是 Storage 對實際位元組內容做的真正偵測——一個惡意客戶端仍然可以在最初的
  upload 請求就把 `Content-Type` 設成 `image/png`，藏進其他格式的內容，bucket 層的
  `allowed_mime_types` 限制跟 file-register 的核對都會被這個假標頭騙過。要真正堵住
  這個缺口需要對實際位元組內容做 magic-byte 偵測，這次沒有做。
- **沒有病毒／惡意內容掃描**。
- **沒有使用者層級的總儲存空間配額**：目前只限制單一檔案 ≤10MB，沒有限制單一使用者
  名下檔案總大小，理論上可以無限次上傳到 10MB 上限累積佔用空間。
- **這次的核對只套用在新登記的檔案**：不會回頭核對這次修正上線前就已經登記、但中繼
  資料可能本來就跟 Storage 實際物件不一致的既有紀錄。

### 項目 12（PDF 僅按需送出）

- **只有字面檔名比對，沒有語意理解**：使用者用完全不含檔名的方式描述（例如「我上禮拜
  傳的那份文件」而不報出檔名）不會命中——這是刻意的保守選擇（沒有比對到就不送，
  優於送錯或亂猜），但確實會犧牲一部分命中率。
- **沒有「使用者明確選擇要附加的檔案」這個 UI／API 機制**：使用者只能透過在訊息裡
  提到檔名讓系統推斷需求，沒有像許多聊天工具那樣「附加檔案」的明確操作，這次沒有
  新增這個前端功能。
- **同樣「無條件送出」的模式在別的地方還在**：`buildFileContext()`（txt/md/docx/xlsx
  等文字檔案）目前仍然是每次對話都無條件夾帶最近幾份文字檔案內容（不像原生文件
  輸入那麼貴，但一樣不是「按需」），這次只處理了 PDF 原生文件輸入這一種情境，
  沒有把同一種「按需」原則套用到其他檔案類型的文字上下文。
- **最多只附加 2 份**：就算訊息裡提到 3 份以上不同的 PDF 檔名，`PDF_CONTEXT_MAX_FILES`
  的上限沒有調整，超過的部分不會被附加，也沒有任何提示告知使用者。

### 項目 15（Storage 清理）

- **沒有既有孤兒物件的回填清理**：這次的修正只讓「往後每一次 file.delete」都會嘗試
  清理 Storage，對於**這次修正上線之前**就已經軟刪除、但從來沒有被清理過的既有
  Storage 物件，不會被追溯性清掉。
- **沒有失敗重試機制**：Storage `remove()` 失敗只會誠實記錄進
  `audit_logs.metadata.storageRemoved=false`，但沒有任何排程或背景機制會去掃描這些
  記錄、重新嘗試清理——這是一次性的盡力而為，不是「最終一定會清掉」的保證，需要
  部署者自己定期查 audit_logs 找出清理失敗的紀錄、手動處理。
- **`file_text_chunks`（資料庫裡的文字切段，不是 Storage 的部分）沒有一併清理**：
  檔案軟刪除時，`files` 這一列只改 `status`，沒有真的 DELETE，對應的
  `file_text_chunks` 也就繼續留著（cascade 只在真的 DELETE `files` 列時才會觸發），
  這些資料庫層的殘留這次沒有處理，範圍限定在「Storage」這個字面意義本身。
- **沒有 Storage 用量／配額報表**：沒有任何介面讓部署者一眼看出目前 Storage 實際
  用量、或哪些物件早就該被清但沒清乾淨，只能透過 `audit_logs` 逐筆人工排查。

## 7. 部署順序（合併後）

1. 到 Supabase Dashboard 的 SQL Editor 依序執行 PR #47 分支的 `0019`~`0026`（如果
   還沒套用），再執行這次新增的 `0027_file_storage_lifecycle.sql`（實際編號依整合
   時的結果為準）。
2. GitHub Actions 自動部署有改動的 Edge Function（`file-register`、
   `approval-decide`、`agent-run`）。
3. 部署後建議：
   - 用一個測試帳號建一個房間、上傳一份 PDF、發一則提到檔名的訊息，確認 AI 回覆時
     真的有附加這份 PDF；再發一則完全無關的訊息，確認這次沒有附加。
   - 上傳一份檔案、刪除所在房間，確認自己還能在「檔案」分頁下載這份檔案。
   - 走一次 file.delete 核准流程，到 Storage Dashboard 確認物件真的被刪除。
   - 依第 6 節的建議，人工核對正式環境裡有沒有這次修正上線前就已經軟刪除、但
     Storage 物件還留著的既有孤兒資料。

## 8. 確認

- 這個分支（`claude/phase-d-on-integration`，base 是 PR #47 的
  `claude/integration-abc-17plan`）沒有合併、沒有部署到任何網站或 Edge Function、
  沒有修改正式 Supabase。
- 所有測試都在本機一次性建立、測試完即丟棄的 PostgreSQL 資料庫上執行；沒有使用
  真的付費模型、真的 Storage、正式 Supabase 做任何測試。
- PR #47 維持待審狀態，沒有因為這個分支而被合併或部署；PR #48（第一版、以 main 為
  基底）維持不合併，這個分支是取代 #48 的版本。

## 9. 第三版修正（2026-09-29，PR #49 審閱意見回應：物件上傳者驗證缺口）

PR #49 送審後，審閱意見指出一個合併前必須修的權限缺口：`file-register` 原本只確認
呼叫者是房間成員、Storage 物件路徑存在，就把呼叫者寫成 `files.owner_id`，從未核對
這個物件當初真正是「誰」上傳的（`storage.objects.owner`）。同一個房間的成員 A 只要
知道／猜到房間成員 B 已經上傳的 `object_path`，就能呼叫 `file-register` 把 B 的檔案
登記成「A 的檔案」，之後 A 甚至可以透過 `file.delete` 核准流程把 B 上傳的實體物件
刪掉，B 完全不知情也沒有核准過。同時指出 `files` 對 `(bucket, object_path)` 沒有
唯一約束、新的 SECURITY DEFINER 函式對重複路徑只 `LIMIT 1`（順序不保證），以及要求
檢查這批新函式能不能被一般使用者直接當 RPC 呼叫讀到跨使用者資訊。

### 9.1 修正內容

1. **`migrations/0027_file_storage_lifecycle.sql`**：新增 `public.room_files_storage_object_owner(bucket, object_path)`——只給
   `service_role` 呼叫的 SECURITY DEFINER 函式，讀出 `storage.objects.owner`；新增
   `public.files` 對 `(bucket, object_path)` 的唯一約束
   `files_bucket_object_path_key`。
2. **`functions/file-register/index.ts`**：新增 `getStorageObjectOwner()`，呼叫上述
   RPC 核對「呼叫者是不是真正的上傳者」，不是就直接拒絕（HTTP 403
   `not_uploader`）；`insert` 的錯誤處理改為辨識 `23505`（唯一約束衝突）——同一個
   真正上傳者重試時冪等回傳既有 `fileId`，擁有者不是自己時回報 409
   `already_registered`，不會讓其中一筆變成看不見的殭屍資料，也不會直接 500。

### 9.2（本機測試時實際發現，不是理論推測）SECURITY DEFINER 函式權限收窄失敗：`revoke ... from public` 對已透過 default privileges 直接授權的角色沒有效果

第一版的 `room_files_storage_object_owner()` 只下了
`revoke all on function ... from public; grant execute on function ... to
service_role;`，自認為已經把權限收窄到只剩 `service_role`。**本機測試直接用
`authenticated`／`anon` 的 JWT 呼叫這支函式的 `/rpc/` 端點，發現兩者都能呼叫成功
（HTTP 200），完全沒有被擋下來**——不是理論推測，是先寫測試、測試真的失敗了才
發現。

根因：Supabase 專案（以及本機測試基礎設施，見
`scripts/phase-d-regression-test.sh`）在 `public` schema 上都設有
`alter default privileges ... grant execute on functions to authenticated, anon,
service_role`，讓每一個新建立的函式預設就對 `authenticated`／`anon` 開放執行權限
（`is_room_member()` 等既有函式從來不用額外下 `grant` 就能被 policy／PostgREST
呼叫，就是因為這個預設）。`revoke all ... from public` 撤銷的是 `PUBLIC` 這個虛擬
角色本身的權限，**不會**撤銷已經透過 default privileges 直接授與 `authenticated`／
`anon` 這兩個實際角色的權限——這支函式建立後，這兩個角色其實還是能直接呼叫成功。

修正：明確把 `authenticated`／`anon` 兩個角色本身也一起列進 `revoke` 對象
（`revoke all on function ... from public, authenticated, anon;`），而不是只
revoke `public`。修正後重測，`authenticated`／`anon` 呼叫都被 Postgres 權限系統
擋下（`42501 permission denied for function`），`service_role` 呼叫仍然正常。

### 9.3 實測結果

```
PASS: 【修正生效】A 不是真正的上傳者，file-register 拒絕登記（HTTP 403 not_uploader）——修正前這裡會是 200，B 的檔案會被 A 偷走
PASS: 沒有留下任何 owner_id=A 的冒名檔案紀錄
PASS: 真正的上傳者可以正常登記成功（HTTP 200）——修正沒有誤傷正常流程
PASS: files 表裡這筆紀錄的 owner_id 正確是真正的上傳者 B
PASS: 同一個上傳者重試時冪等成功（HTTP 200），不是噴 500
PASS: 重試回傳的 fileId 跟第一次登記的相同，是同一筆紀錄，不是新建的重複列
PASS: files 表裡這個 object_path 仍然只有 1 筆紀錄（唯一約束生效，沒有留下重複列）
PASS: 資料庫層確實存在 files_bucket_object_path_key 唯一約束
PASS: 非擁有者直接呼叫 room_file_is_active_owned_by_caller 只會拿到 false，問不到『這個路徑其實是誰的、還在不在』
PASS: 擁有者直接呼叫可以問到自己檔案的狀態（true），符合函式設計意圖——只能問自己的
PASS: authenticated 角色呼叫 room_files_storage_object_owner 被 Postgres 權限系統拒絕（HTTP 403，不是 200）
PASS: anon 角色呼叫也被拒絕（HTTP 401，不是 200）
PASS: service_role 呼叫成功，且正確讀出真正的上傳者——函式本身邏輯正確，只是權限收得夠窄
```

`scripts/phase-d-regression-test.sh`／`scripts/integration-abc-sql-rpc-test.sh`／
`scripts/integration-abc-edge-function-test.sh`／
`scripts/integration-abc-knowledge-required-test.sh` 全部重新跑過，均
`=== 全部通過 ===`；`npm run typecheck`／`npm run lint`（0 錯誤，2 個跟這次改動無關
的既有 warning）／`npm run build` 全部通過；`deno check --no-lock
--node-modules-dir=none file-register/index.ts` 仍然只有既有的 `TS2345` x1（跟第
二版報告第 4 節記錄的 baseline 一致，這次修正沒有新增任何型別錯誤）。

### 9.4 這一輪修正後，項目 11 的「上傳者身分」缺口已經補上

第 6 節列出的項目 11 KPI 缺口（magic-byte 偵測、病毒掃描、使用者總儲存空間配額、
回溯既有紀錄）維持不變，這一輪不影響那份清單；「物件上傳者是否真的等於登記者」
這個缺口（PR #49 審閱意見新發現，不在原本第 6 節清單內）已經在這一輪修正並實測
通過。

- 分支、合併、部署狀態不變：`claude/phase-d-on-integration` 仍然沒有合併、沒有
  部署、沒有動到正式 Supabase；PR #47 維持待審，PR #48 維持不合併。
