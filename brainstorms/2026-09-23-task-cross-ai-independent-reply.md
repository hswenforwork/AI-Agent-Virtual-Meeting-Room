# 任務裡被諮詢的 AI 也要自己發獨立訊息：腦力激盪／探索紀錄
日期：2026-09-23 · 目標：統一各 AI 自己回復（不管一般聊天還是任務），讓使用者能確認 AI 之間溝通是否順暢
狀態：進行中
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

## 待釐清事項
（隨訪談持續更新）
