-- 項目 7 修正（孤兒 queued 紀錄）：agentRunReaper.ts 的清掃查詢是
-- `status = 'queued' and created_at < cutoff`，不帶 room_id（全站範圍），既有的
-- agent_runs_room_status_idx (room_id, status, created_at) 對這種跨房間掃描沒有幫助。
-- 用 partial index 只索引 status='queued' 的列（queued 在整張表裡只會是極少數，
-- 大多數列最終是 completed/failed），掃描/清掃效率不受表本身成長影響。

create index if not exists agent_runs_queued_created_idx
  on public.agent_runs (created_at)
  where status = 'queued';
