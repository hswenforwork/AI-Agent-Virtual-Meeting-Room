-- 前端 useMessages/useAgentRunStatus 靠 postgres_changes 訂閱 messages 跟 agent_runs，
-- 但 Supabase 預設不會把任何表加進 supabase_realtime publication，導致新訊息／
-- 代理狀態變化不會即時推送到前端，只能等下次重新整理（重新 SELECT）才看得到。

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.agent_runs;
