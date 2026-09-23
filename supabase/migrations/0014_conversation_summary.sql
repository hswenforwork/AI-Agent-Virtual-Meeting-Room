-- 對話自動摘要：房間層級的長期記憶，解決 agent-run 只抓最近 24 則訊息、
-- 更舊的對話 AI 完全不知道的問題
-- 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q11-Q13
--
-- summary_covered_until 記錄「摘要已經涵蓋到哪一則訊息的 created_at 為止」，
-- agent-run 組歷史時用這個時間點判斷「已摘要範圍」跟「最新 24 則」之間累積了多少
-- 尚未摘要的訊息，超過門檻（20 則）就先折進摘要再繼續正常回覆。

alter table public.rooms add column if not exists conversation_summary text not null default '';
alter table public.rooms add column if not exists summary_covered_until timestamptz;
