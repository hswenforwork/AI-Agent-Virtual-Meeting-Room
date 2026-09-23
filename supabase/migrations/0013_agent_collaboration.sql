-- 代理互相協作（loop-in）：agent_runs 補上「是否為被接力拉入」與「拉入理由」欄位
-- 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q3-Q8
--
-- 設計：同一則使用者觸發訊息最多允許一次接力（Q6）——第一輪回覆的代理（A）可以用
-- tool use 拉入另一位（B），B 的 agent_runs 列會標記 is_loop_in = true，agent-run
-- 看到這個標記就不會再附帶 loop-in 工具定義給 B，也不會再往下接力。

alter table public.agent_runs add column if not exists is_loop_in boolean not null default false;
alter table public.agent_runs add column if not exists loop_in_reason text;
