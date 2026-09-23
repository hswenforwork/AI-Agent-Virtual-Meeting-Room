# 任務裡被諮詢的 AI 也要自己發獨立訊息：腦力激盪／探索紀錄
日期：2026-09-23 · 目標：統一各 AI 自己回復（不管一般聊天還是任務），讓使用者能確認 AI 之間溝通是否順暢
狀態：訪談完成，待確認是否還有補充後開始實作
背景來源：`supabase/functions/worker-task-start/index.ts`（`handleConsultOtherAi()`）、
`supabase/functions/_shared/providers/gemini.ts`（`consultGemini()`）、
`supabase/functions/_shared/agentCollaboration.ts`（`spawnLoopInRun()`，一般聊天已有的對照組）、
`brainstorms/2026-09-23-worker-agent-notebook-write.md`（write_to_notebook，架構模式相同）

## 已知既有系統事實（訪談前已確認，不重問）
- 兩套跨 AI 協作機制目前行為不一致：
  1. **一般聊天回覆**（非任務）：`loop_in_agent` 工具把另一位代理拉進來，被拉入的代理會
     自己生成一則獨立訊息、用自己的身分顯示在聊天室——已經符合這次想要的行為。
  2. **工作型代理任務**：Claude 卡住時透過 `consult_other_ai` 呼叫 Gemini，但答案只是
     純文字 tool result 回傳給沙盒裡的 Claude，不會變成獨立訊息、不會用 Gemini 的身分
     出現——這是使用者這次回報疑惑的來源，也是這次要改的部分。
- 架構參考：跟上一輪剛做完的 `write_to_notebook` 同一種模式——`worker-task-start` 事件
  迴圈收到 `agent.custom_tool_use`、執行邏輯、`sendCustomToolResult()` 回傳給沙盒繼續跑。
  這次要在 `handleConsultOtherAi()` 裡，拿到 Gemini 答案後，除了現有的
  `sendCustomToolResult()`，還要額外 insert 一則 `messages`（`sender_agent_id` 是這個
  房間 Gemini 的 agent id，`agents` 表已經有固定的三個供應商 agent，需要另外查一次）。
- 沒有設定 Gemini key 時，`consult_other_ai` 現在直接回傳提示文字給 Claude、不會真的
  呼叫 Gemini——這種情況沒有 Gemini 答案，不需要另外發訊息。
- 使用者的目的：「這樣我才能確認 AI 之間溝通是否順暢」——重點是「看得到、能驗證」，
  不是要重新設計整個委派流程。

## 問答紀錄
### Q1：Gemini 獨立訊息要不要取代 Claude 進度日誌裡的描述？
- 問題：這則 Gemini 獨立訊息要不要取代 Claude 進度日誌裡「正在詢問另一位 AI（Gemini）
  協助：...」那行的描述，還是兩者並存（使用者兩則都看得到）？
- 已記錄：（待訪談）

- 已記錄：兩則並存。Claude 進度日誌繼續顯示「正在詢問 Gemini」作為執行過程的透明度，
  另外新增 Gemini 自己的獨立訊息顯示它的完整回答，不互相取代。

### Q2：這則獨立訊息要回覆到哪裡？
- 問題：Gemini 的獨立訊息要回覆（`reply_to_id`）到哪裡，讓使用者看得出來龍去脈？
- 已記錄：回覆到任務卡片本身（`reply_to_id` 指向 `task_card_message_id`），視覺上最清楚
  看出「這是因為這個任務才觸發的」。

### Q3：呼叫多次要不要每次都發訊息
- 問題：如果同一個任務裡 Claude 卡住好幾次、呼叫了好幾次 Gemini，要每次都發一則獨立
  訊息，還是要避免洗版（例如只發最後一次）？
- 已記錄：每次都發。跟 `consult_other_ai` 本身不限制呼叫次數的既有行為一致，每一次
  諮詢都是獨立事件，都值得讓使用者看到，符合「確認溝通是否順暢」的目的。

### Q4：Claude 的 SUMMARY 措辭要不要跟著調整
- 問題：Claude 的 SUMMARY 措辭要不要跟著調整，避免讓人誤以為它自己代答了 Gemini 的
  問題（例如「已呼叫 Gemini 代理計算，結果為 615」這種聽起來像自己代答的寫法）？
- 已記錄：要調整。在 `consult_other_ai` 工具的說明或系統提示詞裡明確要求：已經有
  Gemini 自己的訊息時，SUMMARY 不要重複代答結果，改成指引使用者去看 Gemini 自己的
  回答（例如「已請教 Gemini，答案請見上方 Gemini 的訊息」）。

### Q5：要不要顯示 token 用量
- 問題：這則 Gemini 獨立訊息要不要也顯示 token 用量（需要額外接上 `consultGemini()`
  目前完全沒追蹤過的 usage 數字），還是先不管、留空白就好？
- 已記錄：也顯示，跟既有機制一致。`consultGemini()` 改成回傳 usage，寫進這則新訊息的
  `input_tokens`/`output_tokens`。

## 摘要／重要決策
1. **並存**：Claude 進度日誌繼續顯示「正在詢問 Gemini」，另外新增 Gemini 自己的獨立
   訊息，不互相取代。
2. **回覆對象**：Gemini 的獨立訊息 `reply_to_id` 指向任務卡片本身。
3. **多次呼叫**：每次呼叫 `consult_other_ai` 都各自發一則獨立訊息，不去重、不限制。
4. **SUMMARY 措辭**：更新工具說明/系統提示詞，要求 Claude 不重複代答 Gemini 的結果，
   改成指引使用者去看 Gemini 自己的訊息。
5. **Token 用量**：`consultGemini()` 也回傳 usage，寫進這則新訊息，跟既有顯示機制一致。

## 待釐清事項
（都已解決，見上）
