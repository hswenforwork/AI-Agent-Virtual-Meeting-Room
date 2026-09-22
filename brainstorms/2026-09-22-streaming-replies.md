# AI 回覆改成串流輸出：腦力激盪／探索紀錄
日期：2026-09-22 · 目標：聊天室裡的 AI 回覆從「等整段回完才一次顯示」改成逐字/逐段串流顯示
狀態：進行中
背景來源：
- 現況：`chat-dispatch` 用 `EdgeRuntime.waitUntil()` 射後不理觸發 `agent-run`，前端從來不直接跟 `agent-run` 通訊；`agent-run` 呼叫供應商 API（非串流）拿到完整文字後才 `insert` 一則 `messages` 列，前端靠 Realtime 訂閱 `messages` 的 INSERT 事件才「看到」回覆。這個設計讓生成過程跟使用者是否還開著分頁脫鉤（使用者切走、@多個代理平行跑，都不受影響）
- 已經在跑、可以參考的既有模式：工作型代理的任務卡片（`worker_tasks`／`messages.metadata`）就是用「先 insert 一則訊息拿到 id，之後多次 update 同一則訊息」的方式呈現進度，前端 `useMessages.ts` 的 Realtime 訂閱已經同時監聽 INSERT 跟 UPDATE
- 初步技術方向（已經在對話中跟使用者討論過、使用者選 grill-me 前的鋪陳，不是訪談內的正式問答）：`agent-run` 先 insert 一則 `status="streaming"`、內容空白的訊息，收到供應商串流片段時節流 update `content`，最後一次 update 把 `status` 改成 `completed`；三家供應商（Anthropic/OpenAI/Google）都要補上串流呼叫與 SSE 解析邏輯，目前 `AIProvider.generate()` 只有非串流版本
- `agent-run` 現有流程：先跑 `classifyTaskOrQuestion()`（用非串流呼叫判斷這則訊息是「任務」還是「問題」，只有 Claude/Anthropic 這條路徑會做這個判斷），是「問題」才會走到最後產生一般聊天回覆的 `provider.generate()` 呼叫

## 使用者原話
「聊天室的 AI 回覆要改成串流輸出（逐字/逐段顯示），不要像現在這樣等供應商整個回完才一次顯示。」（延續自「這個專案在市場上缺乏什麼功能」的討論，使用者認可「透過 Realtime UPDATE 做準串流」這個推薦方向後選擇 grill-me）

## 摘要／重要決策
（隨訪談持續更新）

## 問答紀錄
