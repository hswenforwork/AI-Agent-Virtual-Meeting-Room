-- 訊息泡泡顯示 token 用量：對應 brainstorms/2026-09-23-message-token-usage-display.md
--
-- 只記錄「產生這則訊息內容」那次呼叫的用量（不含意圖分類呼叫本身）：
-- - 一般聊天串流回覆：agent-run 完成串流時直接寫入同一則訊息
-- - task_card 任務卡片：worker-task-start 收到 Managed Agents 的 session.usage 事件、
--   任務執行完成時寫回對應的 task_card 訊息列
-- workspace_write 記事本/待辦短確認不記錄（訪談 Q3 決定不顯示）。
-- 分開存 input/output（訪談 Q5：為以後可能的用量統計打底），畫面上（MessageBubble）
-- 依訪談 Q2 只顯示合計數字。舊訊息沒有這兩欄資料，維持 null，前端不顯示任何提示
-- （訪談 Q6）。

alter table public.messages add column if not exists input_tokens integer;
alter table public.messages add column if not exists output_tokens integer;
