-- 停止代理回覆：前端「停止」按鈕呼叫 agent-run-stop 這個 Edge Function，
-- 把 cancel_requested 標成 true；agent-run 在串流過程中會定期輪詢這個欄位，
-- 偵測到後 abort() 呼叫中的供應商請求，把這次 run 標成 cancelled
-- （agent_runs.status 的 check 約束原本就已經允許 'cancelled'，只是從來沒有任何
-- 程式碼會寫入這個值）。
-- 對應 brainstorms/2026-09-23-stop-generation.md：「卡在回覆中」修正與停止功能設計紀錄。

alter table public.agent_runs add column if not exists cancel_requested boolean not null default false;
