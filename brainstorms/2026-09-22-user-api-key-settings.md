# 使用者在網頁上輸入自己的 AI API Key：腦力激盪／探索紀錄
日期：2026-09-22 · 目標：設計「讓使用者能在這個網頁工具上安全輸入自己的 AI API Key、串接自己的模型」這個功能，問清楚需求再動手
狀態：進行中
背景來源：
- 目前架構：`ANTHROPIC_API_KEY` 等金鑰是部署者一次性設定在 **Supabase Edge Function secrets**，整個部署實例共用同一把，前端／使用者完全碰不到、也看不到這把金鑰
- `agents` 表：每個房間有 `claude`／`gpt`／`gemini` 三個代理列，`status` 決定是否啟用；GPT/Gemini 目前是 `inactive`，因為沒有對應 API key
- `supabase/functions/agent-run/index.ts`：目前直接讀 `Deno.env.get("ANTHROPIC_API_KEY")` 這一把全域的 Edge Function secret 來呼叫 Anthropic API
- 原始 MVP 訪談（`brainstorms/2026-09-18-ai-agent-collab-room-mvp.md`）Q7：這個工具的使用範圍設定是「主要自己一個人用」，不是多租戶產品；但資料庫的 `room_members`／`rooms` 本來就支援多使用者共用同一個部署

## 使用者原話
「新增功能：以安全的方式讓使用者可以在這個網頁工具上輸入AI API KEY，以便串接自己的模型API KEY」

## 摘要／重要決策
（隨訪談持續更新）

## 問答紀錄

### Q1：這個功能的使用者範圍是？
- 問題：(a) 每個使用者各自帶自己的金鑰（多租戶 BYOK） (b) 你自己管理那唯一一把共用金鑰，只是想要網頁介面而不是 Supabase Dashboard
- 已記錄：使用者選 **(a) 每個使用者各自帶自己的金鑰（多租戶 BYOK）**。
- 影響：這是真正的多租戶設計，複雜度明顯提高：
  - 需要一張新的資料表存「每個使用者、每個供應商各自的金鑰」，不能只改 Edge Function 的全域 secret
  - 金鑰要加密儲存，不能明碼放在資料庫
  - `agent-run`／`chat-dispatch` 現在讀的是全域 `Deno.env.get("ANTHROPIC_API_KEY")`，要改成依「這次是誰在用」查對應使用者的金鑰
  - **待釐清的關鍵問題**：`rooms`／`room_members` 本來就支援一間房間有多個成員，如果一間房間裡有兩個使用者、各自有不同的 Anthropic key，代理回覆時該用誰的金鑰？→ 待下一題釐清

### Q2：多成員房間裡，代理回覆該用誰的金鑰？
- 問題：(a) 用發訊息觸發回覆的那個使用者的金鑰（建議） (b) 用房間擁有者（owner_id）的金鑰
- 已記錄：使用者選 **(a) 用發訊息觸發回覆的那個使用者的金鑰**。
- 影響：`chat-dispatch` 傳給 `agent-run` 的資訊要多帶一個「誰觸發這次回覆」的使用者 id（其實已經有：`trigger_message_id` 對應的訊息本身就有 `sender_user_id`，`agent-run` 直接查那則訊息的發送者即可，不需要額外傳參數）；`agent-run` 查金鑰時要用「觸發訊息的發送者」而不是房間擁有者。使用者沒有設定金鑰的情況下會發生什麼事，待下一題釐清。

### Q3：使用者還沒設定自己的 API key 時，發訊息會發生什麼事？
- 問題：(a) 不回覆，提示去設定金鑰（建議） (b) 沒設定就用部署者的共用金鑰當備援
- 已記錄：使用者選 **(a) 不回覆，提示去設定金鑰**。
- 影響：部署者的金鑰跟使用者的金鑰完全分離，不會有部署者幫別人付費的情況；`agent-run` 查不到觸發訊息發送者的金鑰時，直接寫一則 system 訊息告知「請先到設定頁輸入你的 API key」，不嘗試用任何備援金鑰。這也代表部署者自己原本設定的那把全域 `ANTHROPIC_API_KEY` Edge Function secret，之後對「一般聊天」這個情境會變成完全不使用（可能還是要留給工作型代理 Managed Agents 那條路徑用，待確認）。

### Q4：這次要支援哪些供應商的金鑰？
- 問題：(a) 只做 Anthropic（Claude） (b) Anthropic + OpenAI + Google 三家一起做（建議）
- 已記錄：使用者選 **(b) 三家一起做**。
- 影響：範圍明顯擴大，這次除了「使用者輸入金鑰」的機制本身，還要**補實作 OpenAI 跟 Google 的 Provider Adapter**（目前 `supabase/functions/_shared/providers/` 底下只有 `anthropic.ts`，`types.ts` 定義的 `AIProvider` 介面已經預留好、`agents` 表的 `gpt`／`gemini` 列也已經存在，只是 `status` 一直是 `inactive`）。輸入金鑰、Provider Adapter 實作、`agent-run` 依供應商查對應金鑰跟建立對應 provider 呼叫，三件事要一起做完整個功能才算真的可用。

### Q5：@GPT／@Gemini 能不能被點名的判斷要怎麼改？
- 問題：(a) 改成看發訊息的使用者自己有沒有設金鑰（建議） (b) 保留房間層級 `agents.status` 判斷，改成誰設定金鑰誰就能把該代理打開
- 已記錄：使用者選 **(a) 改成看發訊息的使用者自己有沒有設金鑰**。
- 影響：`chat-dispatch` 判斷「代理是否可用」的邏輯要從查 `agents.status` 欄位，改成查「這則訊息的發送者，有沒有設定對應供應商的金鑰」。`agents.status` 這個欄位對「一般聊天」情境會變成不再使用（也代表前端 @mention 清單的「已啟用/未啟用」顯示邏輯要跟著改：不是房間固定的，而是依「目前登入的這個使用者」自己有沒有設金鑰決定哪些代理能點名）。

### Q6：金鑰要怎麼加密儲存？
- 問題：(a) 用 Supabase 官方的 Vault 功能（建議） (b) 自己在 Edge Function 裡實作加密（AES-GCM，加密金鑰存成 Supabase secret）
- 已記錄：使用者選 **(a) 用 Supabase 官方的 Vault 功能**。
- 影響：用 Supabase Vault（`pgsodium`／`supabase_vault` extension）存這些金鑰，不用自己管理加密邏輯與加密金鑰。實作時要先查證 Supabase 目前的 Vault API 用法（`vault.create_secret()`／`vault.update_secret()`／`vault.decrypted_secrets` 這類函式/視圖的確切用法可能隨版本調整），不要憑印象猜——這點記錄下來，實作前再核對官方文件。金鑰只能透過 SECURITY DEFINER 的資料庫函式解密讀取，不能直接讓前端的 anon/使用者角色查到明碼。

### Q7：使用者要在哪裡輸入自己的 API key？
- 問題：(a) 新建一個「設定」頁面／彈窗，全域入口（建議） (b) 放進現有房間工作區加第四個分頁
- 已記錄：使用者選 **(a) 新建一個「設定」頁面／彈窗**。
- 影響：新增一個全域「設定」入口（跟房間無關），從 `AppLayout`（側欄或 header）就能點進去；符合金鑰是「跟使用者綁定、不是跟房間綁定」的實際資料模型，不會讓使用者誤以為金鑰是房間層級的設定。

### Q8：儲存金鑰前要不要先測試有效性？
- 問題：(a) 先測試再儲存（建議） (b) 直接儲存，不驗證
- 已記錄：使用者選 **(a) 先測試再儲存**。
- 影響：需要一個新的 Edge Function（例如 `save-api-key`），收到金鑰後先對該供應商發一次最小額度的測試呼叫（例如問一句極短的話，`max_tokens` 設最小），成功才寫進 Vault，失敗回傳清楚的錯誤（金鑰格式錯、金鑰無效、額度問題等，盡量分辨清楚），不寫入。三個供應商（Anthropic/OpenAI/Google）都要各自有一個最小測試呼叫的實作。

### Q9：工作型代理（Managed Agents）要不要一起改成用觸發使用者的金鑰？
- 問題：(a) 不改，保持用部署者的全域金鑰（建議） (b) 一起改成用觸發使用者的金鑰
- 已記錄：使用者選 **(b) 一起改成用觸發使用者的金鑰**——不採納建議選項。
- 影響（助理判斷，重要）：這個決定牽動的範圍比想像中大。Managed Agents 的 `agent`／`environment` 是 Anthropic 那邊「綁定特定帳號」的資源（透過 `scripts/setup-managed-agent.sh` 用某把 key 建立），`POST /v1/sessions` 建立工作階段時，用來呼叫的 API key 必須跟建立這個 `agent_id`／`environment_id` 時是同一個帳號，不然大概率會遇到「找不到這個 agent」之類的錯誤。也就是說，光是換掉呼叫時用的金鑰還不夠——**如果要讓每個使用者用自己的金鑰觸發工作型代理，這個使用者也必須擁有自己的 Managed Agents agent／environment**，不能繼續共用部署者當初建好的那一套。
- 待釐清：這代表 `worker-task-start` 要新增邏輯——使用者第一次觸發工作型代理時，用他自己的金鑰**自動建立**一份專屬的 agent／environment（背後呼叫跟 `scripts/setup-managed-agent.sh` 一樣的建立邏輯），存起來下次重複使用，不能再依賴全域的 `MANAGED_AGENTS_AGENT_ID`／`MANAGED_AGENTS_ENVIRONMENT_ID` 這兩個 Edge Function secrets。這是否是使用者真正想要的範圍？→ 待下一題確認

### Q10：確認 Managed Agents 自動建置的範圍
- 問題：使用者第一次觸發工作型代理時，自動用他自己的金鑰建一份專屬的 agent/environment、之後重複使用，這樣的範圍對嗎？
- 已記錄：使用者確認 **對，就是這樣**。
- 影響：`worker-task-start` 要新增「使用者專屬 Managed Agents 資源」的建立與查詢邏輯（第一次用的時候自動建立、存起來、之後重複使用，邏輯比照 `scripts/setup-managed-agent.sh` 但改成程式內執行、不需要使用者手動跑腳本）；`consult_other_ai` 卡住求助用的 Gemini key，順理成章也改成用該使用者自己輸入的 Google 金鑰（不用另外問，這是 Q4／Q9 的自然結果）；部署者原本的全域 `ANTHROPIC_API_KEY`／`GEMINI_API_KEY`／`MANAGED_AGENTS_AGENT_ID`／`MANAGED_AGENTS_ENVIRONMENT_ID` 這幾個 Edge Function secrets，在這個功能上線後對「一般聊天」與「工作型代理」都不會再被使用到（可能還有其他用途要盤點，例如部署驗收階段）。

## 待釐清事項
