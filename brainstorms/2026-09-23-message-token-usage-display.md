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

### 發現：工作型代理（Managed Agents）目前完全沒有 token 用量追蹤
- 已記錄（技術事實，非使用者回答）：查過 `supabase/functions/worker-task-start/index.ts`
  跟 `supabase/functions/_shared/managedAgents.ts`，兩個檔案裡都沒有任何 usage/token
  相關的程式碼——Managed Agents 的執行是透過 SSE 事件串流回報進度，但目前完全沒有解析
  或儲存任何 usage 數字。這跟一般聊天／classifyMessage 那種直接呼叫 Messages API、
  回應裡就帶 usage 欄位的情況不一樣：Managed Agents 的用量需要另外從它的 session
  事件裡擷取（如果有提供的話），這部分目前是全新的功能，不是「補顯示既有數字」
  這麼單純。
- 待釐清：Managed Agents API 的 SSE 事件裡到底有沒有帶 usage/token 資訊、格式是什麼
  → 需要另外查證 Managed Agents API 文件才能回答，會影響任務卡片能不能顯示 token（或
  能顯示到多精確）。

## 待釐清事項
- Managed Agents API 的 session 事件是否回報 token 用量、格式為何 → 需要查證 API 文件
