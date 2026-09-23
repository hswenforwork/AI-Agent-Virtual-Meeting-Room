# 訊息泡泡顯示 token 用量：腦力激盪／探索紀錄
日期：2026-09-23 · 目標：在 AI 回覆的對話泡泡裡顯示「這一輪對話用了多少 token」
狀態：進行中
背景來源：`supabase/functions/agent-run/index.ts`、`src/features/messages/MessageBubble.tsx`、`src/types/database.ts`

## 摘要／重要決策
（隨訪談持續更新）

## 已知既有系統事實（訪談前已確認，不重問）
- `agent_runs.usage_json`（`{inputTokens, outputTokens}`）在串流回覆結束後寫入，是
  `classification.usage`（意圖分類呼叫）+ `streamUsage.usage`（真正生成回覆的串流呼叫）的
  加總（`agent-run/index.ts` 第 409-421 行附近），兩者目前混在一起、沒有分開存。
- `agent_runs.trigger_message_id` 指向觸發這次 run 的使用者訊息，但沒有欄位指向這次 run
  產生的 AI 回覆訊息（`messages` 表裡 `sender_type='agent'` 那一則）。
- `messages` 表目前沒有任何 token/usage 相關欄位。
- 三種「AI 回覆」路徑，目前算 usage 的方式不一致：
  - 一般聊天串流回覆：`combinedUsage`（分類 + 生成兩次呼叫加總）
  - `workspace_write` 短確認（記事本/待辦寫入確認）：只有 `classification.usage`
    （沒有真正生成回覆內容的呼叫）
  - `task_card` 任務卡片：只有 `classification.usage`

## 問答紀錄
### Q1：「這一輪」要不要含意圖分類呼叫的 token？
- 問題：使用者說「我問一次 AI 答一次」用了多少 token，這個數字要不要包含意圖分類
  （`classifyMessage()`，判斷訊息是 task/question/workspace_write）那次額外呼叫的用量？
  還是只算真正組成回覆內容那次呼叫？
- 已記錄：只算真正生成回覆內容那次（比較貼近「這則訊息本身」的用量），**但要包含
  執行任務工作（task）所使用的 token**——也就是分類判斷出是「task」、走工作型代理
  （Managed Agents 沙盒）執行的情況，執行過程中花的 token 也要算進這則訊息的用量，
  不是只看分類呼叫本身那一小段。

### 發現：工作型代理（Managed Agents）目前完全沒有 token 用量追蹤，但 API 有提供，可以補
- 已記錄（技術事實，非使用者回答）：查過 `supabase/functions/worker-task-start/index.ts`
  跟 `supabase/functions/_shared/managedAgents.ts`，兩個檔案裡都沒有任何 usage/token
  相關的程式碼——`worker-task-start` 的事件迴圈（第 223-251 行附近）目前只處理
  `agent.message`／`agent.custom_tool_use`／`session.error`／`session.status_idle`／
  `session.status_terminated` 這五種事件類型，其他類型一律被無聲丟棄。
- 已記錄（查證 Managed Agents API 官方文件得到的答案，解決上面的待釐清）：**SSE 事件裡
  確實有 usage 資訊**——`session.usage` 事件會在 session 結束前帶一次「累計」的 token
  總量快照（`input_tokens`/`output_tokens`，還有 `list_cost` 等），另外每次模型請求結束
  也會有 `span.model_request_end` 事件帶當次的 `model_usage`（`input_tokens`/
  `output_tokens`/快取 token）。也就是說只要在既有的事件迴圈裡多加一個
  `case "session.usage"`，把這次快照存下來，就能取得整個任務執行過程總共花了多少
  token，不需要額外呼叫或猜測——是可以做的，只是目前完全沒接。

### Q2：顯示格式要多細？
- 問題：決定顯示「這則訊息用了多少 token」之後，要怎麼呈現——(a) 只顯示一個合計數字
  （例如「1,234 tokens」）、(b) 分開顯示輸入/輸出（例如「輸入 890 · 輸出 344」）、
  (c) 要不要順便顯示這次用的模型名稱？
- 已記錄：只顯示一個合計數字（選項 a），不分輸入/輸出，也不顯示模型名稱。

### Q3：workspace_write 短確認訊息要不要顯示 token？
- 問題：記事本/待辦短確認（例如「已幫你記到記事本：XXX」）背後只有一次分類呼叫，依 Q1
  邏輯這其實就是「產生這則訊息內容」的呼叫，可以比照顯示，但這種訊息通常很短。要顯示嗎？
- 已記錄：不需要。適用範圍確定為：一般聊天串流回覆、task_card 任務卡片（含執行過程）
  兩種；workspace_write 短確認不顯示。

### Q4：UI 呈現方式——常駐顯示還是 hover 才顯示？
- 問題：token 數字要常駐顯示在時間戳旁邊（例如「14:32 · 1,234 tokens」），還是預設精簡、
  hover／點擊才顯示完整數字？
- 已記錄：常駐顯示（選項 a），直接放在時間戳旁邊。

### Q5：要不要順便為以後的用量統計打底？
- 問題：儲存方式要 (a) 只求輕量顯示這個數字，還是 (b) 順便打底（即使畫面上只顯示合計，
  資料存的時候還是分開存 input/output），方便以後做用量統計/圖表？
- 已記錄：選 (b)，順便打底——存的欄位分開存 input/output tokens，即使畫面（依 Q2）只顯示
  合計數字。

## 待釐清事項
（已解決：Managed Agents 用量可行性，見上）
