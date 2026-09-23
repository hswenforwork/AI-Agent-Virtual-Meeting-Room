-- 工作型代理寫進記事本/待辦事項：對應 brainstorms/2026-09-23-worker-agent-notebook-write.md
--
-- 只有使用者在原始訊息裡明確要求（例如提到「記進記事本」）時，才附帶新的
-- write_to_notebook 自訂工具給工作型代理（訪談 Q1）。分類階段（agent-run）判斷出
-- 這個意圖後存在這個欄位，worker-task-start 建立 session 時讀取，決定要不要用
-- agent_with_overrides 多附帶這個工具。

alter table public.worker_tasks add column if not exists needs_notebook_tool boolean not null default false;
