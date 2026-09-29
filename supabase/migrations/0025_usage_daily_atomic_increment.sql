-- 項目 16 修正：usage_daily 原子計數。
--
-- 原本 agent-run/index.ts 的 upsertUsage() 是「先 select 現有值、在應用程式層加 1、
-- 再 upsert 寫回去」，中間沒有任何鎖。同一個代理在同一天有兩個 agent_run 幾乎同時
-- 完成時（例如同一個代理被兩則不同訊息分別點名、平行派送剛好前後腳完成；或
-- loop-in 把同一個代理拉進不同對話），兩次呼叫都可能讀到同一個舊值、各自加 1 後
-- 寫回去，後寫入的覆蓋掉先寫入的，等於少算了一次請求跟那次的 token 用量——用量
-- 統計會比實際偏低，之後如果要做真的預算上限判斷，判斷基準本身就是不準的。
--
-- 改成資料庫端一個原子的 INSERT ... ON CONFLICT ... DO UPDATE SET x = x + excluded.x，
-- 靠 PostgreSQL 對同一列的寫入鎖保證多個並發呼叫的加總結果一定正確，不會有任何一次
-- 加總被覆蓋掉。
--
-- 註記（殘留風險，不在這次修正範圍內）：這張表目前只有「累計計數」，資料庫或
-- Edge Function 完全沒有讀取這些數字、跟任何金額上限比對後擋下後續請求的邏輯
-- （沒有真的「預算上限」執行機制，也沒有各家供應商/模型的單價換算表）。這裡只
-- 修正「計數本身要原子、不能漏算」，還沒有實作「達到預算上限就擋下」——後者需要
-- 額外定義每個供應商/模型的單價，屬於新功能而不是併發 bug 修正，超出這次的範圍，
-- 列在測試報告的殘留風險裡。

create or replace function public.increment_usage_daily(
  p_usage_date date,
  p_room_id uuid,
  p_agent_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint
)
returns public.usage_daily
language sql
security invoker
set search_path = public
as $$
  insert into public.usage_daily (usage_date, room_id, agent_id, request_count, input_tokens, output_tokens)
  values (p_usage_date, p_room_id, p_agent_id, 1, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0))
  on conflict (usage_date, room_id, agent_id) do update set
    request_count = public.usage_daily.request_count + 1,
    input_tokens = public.usage_daily.input_tokens + coalesce(p_input_tokens, 0),
    output_tokens = public.usage_daily.output_tokens + coalesce(p_output_tokens, 0)
  returning public.usage_daily.*;
$$;

grant execute on function public.increment_usage_daily(date, uuid, uuid, bigint, bigint) to service_role;
