# 階段 2：建立 Supabase 專案、跑資料庫 migration

## 目標
建立一個新的 Supabase 專案，依序執行下方列出的 migration，拿到之後每個階段都要用的三個值：
`project_ref`、`project_url`（`https://<project_ref>.supabase.co`）、`anon_key`。

## 第一選擇：Supabase 官方 MCP 工具

先 `ToolSearch` 查 `supabase`。查得到 `mcp__supabase__*` 工具的話，優先用它們完成這個階段：建立專案、跑 migration、查 API 金鑰通常都有對應的工具（例如建立專案、列出/執行 SQL、取得專案的 anon key 之類），不需要自己組 curl、不用擔心欄位名稱記錯。實際工具名稱以當下 `ToolSearch` 回傳的為準，這裡不列死，因為工具版本可能更新。用 MCP 工具做完，直接跳到「依序執行 migration」那一段（MCP 版通常一個工具呼叫可以跑一個 SQL 檔案），略過下面的 curl 步驟。

查不到 `mcp__supabase__*` 工具，才進入下面的「備援：手刻 Management API」。

## 備援：手刻 Management API（沒有 Supabase MCP 工具時）

### ⚠️ 執行前一定要先做的事：查證 Supabase Management API 的真實規格

撰寫這份文件時，作者的網路存取被限制在 `supabase.com` / `api.supabase.com` 之外，**沒辦法直接打開官方文件核對**。
下面寫的端點與欄位名稱是最後一次確認過的理解，**執行任何一個 API 呼叫之前**，先做以下其中一件事重新確認：

- 用 WebFetch 讀 `https://supabase.com/docs/reference/api/introduction`（Management API 總覽）與相關的單一端點頁面，或
- 直接打 `GET https://api.supabase.com/api/v1-json`（這是 Management API 自己的 OpenAPI spec，永遠是最新的），解析出建立專案／跑 SQL／設定 secrets／查 Auth 設定這幾個端點的正確路徑與欄位名稱

如果兩者都連不出去（跟作者當時一樣被擋），才使用下面「最後已知規格」當備援直接嘗試，並且**呼叫後一定要檢查回應內容**，欄位對不上就照回應內容修正，不要盲目相信本文件。

### 引導使用者申請 Management API Token（這是必須的人工步驟，一次講清楚）

跟使用者說（一次把要做的事講完，不要分好幾句話）：

> 接下來我需要一把可以幫你在 Supabase 建立專案、跑資料庫設定的金鑰。麻煩你：
> 1. 打開 https://supabase.com ，用 GitHub 帳號註冊／登入（免費）
> 2. 打開 https://supabase.com/dashboard/account/tokens
> 3. 點「Generate new token」，取個名字（例如 `deploy-ai-collab-room`），建立後**立刻複製**那串金鑰貼給我——這串只會顯示一次
>
> 這把金鑰只有這次部署用得到，我不會把它存進任何檔案。

拿到 token 後：
- 只在接下來的工具呼叫（curl／Bash 環境變數）裡使用，**絕對不要**寫進任何要 commit 的檔案、不要 echo 到會被記錄的地方以外的日誌。
- 如果使用者明確拒絕提供（依訪談 Q10，使用者本人已表態要全自動，但如果實際使用這個 Skill 的是別人、真的不想給），才退回舊版 README 步驟 1、2 的手動流程：引導對方自己到 Supabase Dashboard 點「New Project」、貼 SQL 到 SQL Editor 執行。

### 用 Management API 建立專案

1. `GET /v1/organizations`（帶 `Authorization: Bearer <token>`）拿到 `organization_id`；使用者通常只有一個組織，直接用第一個。
2. `POST /v1/projects`，帶上 `name`（可以用 `target_repo` 當名稱）、`organization_id`、`region`（沒特別要求就選離使用者近的，不確定就用 `us-east-1` 或請使用者選）、`db_pass`（**自己產生一組高強度隨機密碼，不要用弱密碼、不要讓使用者想**，這組密碼之後不太會用到，但還是要存在只有這次工具呼叫看得到的地方）、`plan`（`free`）。
3. 輪詢 `GET /v1/projects/{ref}` 直到狀態變成健康／可用（依實際回應欄位判斷，常見會是類似 `ACTIVE_HEALTHY` 這種值），通常需要等 1-2 分鐘，不要低於 10 秒的頻率狂打。
4. 專案就緒後，查該專案的 API 金鑰端點拿到 `anon` public key（前端要用），組出 `project_url = https://<ref>.supabase.co`。

## 依序執行 migration —— 全新專案只需要 5 個檔案，不是全部照編號跑

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_storage.sql
supabase/migrations/0007_worker_tasks.sql
supabase/migrations/0008_room_sidebar_history.sql
supabase/migrations/0009_byok_api_keys.sql
```

**⚠️ 不要跑 `0003`～`0006`。** 這四個檔案是專門給「已經在跑的舊資料庫」補的增量修正（訪客顯示名稱、房間建立權限、Realtime 註冊），
對應的修正內容**已經直接寫進 `0001_init.sql` 本體**（`handle_new_user()` 已經有 `'訪客'` 保底、`rooms_select_member` 政策已經是修好的版本、
結尾已經有 `alter publication supabase_realtime add table ...`）。全新專案先跑過 `0001` 之後，如果再跑 `0006`，
會因為 `alter publication ... add table` 沒有防重複的判斷式而直接報錯（`relation "messages" is already member of publication`）。
這是這個 repo 目前 migration 檔案編號延續舊有增量修正史、但沒有特別標註哪些檔案只給舊資料庫用所造成的落差——README 的步驟 1 其實也只列了
`0001`／`0002`／`0007`／`0008`／`0009` 五個檔案，跟這裡是一致的，照這五個檔案執行即可。

`0009_byok_api_keys.sql` 會啟用 `supabase_vault` extension（多數 Supabase 專案預設已經有，`create extension if not exists`
重跑安全）並建立使用者自己輸入 API key 用的資料表跟函式——這是後面「不需要使用者提供任何 AI 金鑰」的關鍵：
每個使用者登入後自己到「設定」頁輸入自己的 key，部署者不用經手任何 AI 供應商的金鑰。

有 Supabase MCP 工具就用跑 SQL 的那個工具，依序、一個檔案一個檔案送出；沒有的話用「對這個專案執行任意 SQL」的 Management API 端點（依查證結果調整呼叫方式）。不論哪種方式，都**一個檔案一個檔案**執行（不要把多個檔案串成一個大字串一次送出，失敗要能明確定位是哪一個），每一個檔案執行完，檢查回應沒有錯誤才繼續下一個。

## 打開兩個 Auth 設定（讓登入順暢）

對應 README「步驟 6」提到的兩個小地雷，這兩個也儘量用 Supabase MCP 工具或 Management API 的專案 Auth 設定端點直接打開，不要求使用者自己去 Dashboard 點：

- 關掉 Email 確認信（`Confirm email` / 對應設定值可能叫 `mailer_autoconfirm` 之類，執行前依查證結果確認），避免個人使用時撞到「每小時只能寄 2 封信」的限制
- 打開 Anonymous Sign-ins（訪客登入用），對應網站上的「以訪客身分繼續」按鈕

如果 Auth 設定的 API 端點查證後發現目前確實無法用 API 改（或呼叫失敗），才退回人工：明確告訴使用者去 **Authentication → Sign In / Providers**，兩個開關各自要切成什麼狀態，一次講完不要分兩次問。

## 完成判斷
- 五個 migration 都成功執行（可以額外用 SQL 查 `select count(*) from public.rooms` 之類簡單語句驗證資料表確實存在）
- 拿得到 `project_ref`、`project_url`、`anon_key`

把這三個值記在這次對話的工作記憶裡（不要寫進 repo），下一階段要用。

## 跟使用者說的話（範例）
> Supabase 專案建好了，資料庫設定檔也都跑完了。接下來要把這個網址設定回你的 GitHub 專案裡，這步我可以自己做，不需要你操作。

接著進入 `references/03-github-config.md`。
