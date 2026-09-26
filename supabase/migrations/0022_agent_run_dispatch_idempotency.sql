-- 項目 7 修正：chat-dispatch 對同一則訊息重複呼叫（例如前端網路逾時後重試）時，
-- 原本會對同一個代理再插入一筆新的 agent_runs，變成同一則訊息被同一個代理回答
-- 兩次、也多打一次真的會計費的 LLM 呼叫。這裡替 (trigger_message_id, agent_id)
-- 加唯一索引，讓 chat-dispatch 改用「先嘗試 insert，衝突就視為已經派送過」的方式
-- 保證同一個代理對同一則訊息最多只會有一筆 agent_run。
--
-- 只限定在 is_loop_in = false 的列：loop-in（agentCollaboration.ts 的
-- spawnLoopInRun）也會用同一個 trigger_message_id（原始觸發訊息）建立 agent_run，
-- 但目標代理是由「呼叫 loop_in_agent 工具的代理」自己決定的，同一則訊息裡兩個
-- 不同的被點名代理各自獨立判斷、都想拉進同一個第三方供應商，是合法情境，不是
-- chat-dispatch 那種需要防止的「重複派送」，所以排除在這個限制之外。

-- 加限制之前先清掉舊資料裡可能已經存在的重複列（同一組 trigger_message_id +
-- agent_id、is_loop_in = false），只保留最早建立的一筆，避免 create index 失敗。
delete from public.agent_runs a
using public.agent_runs b
where a.trigger_message_id = b.trigger_message_id
  and a.agent_id = b.agent_id
  and a.is_loop_in = false
  and b.is_loop_in = false
  and (a.created_at, a.id) > (b.created_at, b.id);

create unique index if not exists agent_runs_trigger_message_agent_unique_idx
  on public.agent_runs (trigger_message_id, agent_id)
  where not is_loop_in;
