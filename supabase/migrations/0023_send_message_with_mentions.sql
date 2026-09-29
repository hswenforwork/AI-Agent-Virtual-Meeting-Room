-- 項目 9 修正：使用者送出訊息時，前端原本分成「insert messages」「insert
-- message_mentions」「呼叫 chat-dispatch」三個獨立步驟。第一步成功、第二步失敗
-- （例如網路中斷、RLS 檢查沒過）就會留下一則「使用者看得到、但沒有 mention、
-- 也永遠不會有任何代理回覆」的半成品訊息；使用者只能重新輸入同樣的內容再送一次，
-- 變成兩則重複訊息，其中一則永遠孤立。
--
-- 這裡把「寫訊息本體」跟「寫 mentions」合併成一個 SECURITY INVOKER 函式，在同一個
-- 交易內完成，並用 (room_id, client_id) 當冪等鍵：同一個 client_id 重複呼叫（例如
-- 上一次呼叫因為網路問題失敗，前端拿同一個 client_id 重試）會直接回傳既有那筆訊息、
-- 只補齊還沒寫進去的 mentions，不會插入第二筆訊息。
--
-- 用 SECURITY INVOKER（不是 DEFINER）：函式以呼叫者的身分執行，messages/
-- message_mentions 既有的 RLS policy（messages_insert_own／message_mentions_insert_own／
-- messages_select_member）照樣生效，這裡不重新實作一份權限檢查、只補上原本三步驟
-- 缺少的原子性。

alter table public.message_mentions
  add constraint message_mentions_message_agent_unique unique (message_id, agent_id);

create or replace function public.send_message_with_mentions(
  p_room_id uuid,
  p_content text,
  p_client_id text,
  p_mention_agent_ids uuid[] default '{}'::uuid[]
)
returns public.messages
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_message public.messages;
  v_agent_id uuid;
  v_requested_count int;
  v_valid_count int;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'client_id is required' using errcode = '22023';
  end if;

  -- 整合測試回報（docs/17項計劃-ABC整合測試報告.md 項目 3+9 交互測試）：跨房間點名
  -- 原本完全交給 message_mentions 既有的 RLS policy 擋下，那個 policy 一違反就是整個
  -- 函式的交易 rollback（含訊息本體），使用者只會看到一句通用的 Postgres RLS 違規
  -- 訊息，看不出真正原因、也不知道訊息其實整則都沒送出。這裡保留「整則訊息一起
  -- rollback」的行為（不拆成部分成功），但在動用 RLS 之前先明確檢查：point 名的每個
  -- agent_id 是不是都屬於這個房間，不是的話直接丟出使用者看得懂的錯誤，不必等
  -- RLS 違規才知道。
  if p_mention_agent_ids is not null and array_length(p_mention_agent_ids, 1) > 0 then
    select count(distinct x) into v_requested_count from unnest(p_mention_agent_ids) as x;
    select count(distinct id) into v_valid_count
    from public.agents
    where id = any(p_mention_agent_ids) and room_id = p_room_id;
    if v_valid_count <> v_requested_count then
      raise exception '點名的其中一位代理不屬於這個房間，訊息未送出，請重新整理頁面後再試一次。'
        using errcode = 'P0001', hint = 'mention_agent_not_in_room';
    end if;
  end if;

  select * into v_message
  from public.messages
  where room_id = p_room_id and client_id = p_client_id;

  if not found then
    begin
      insert into public.messages (room_id, sender_type, sender_user_id, content, status, client_id)
      values (p_room_id, 'user', auth.uid(), p_content, 'completed', p_client_id)
      returning * into v_message;
    exception when unique_violation then
      -- 兩個幾乎同時帶著同一個 client_id 的請求（例如使用者連點兩下送出）都通過了
      -- 上面「還沒有這筆」的檢查，其中一個搶到唯一索引，另一個在這裡改成讀出
      -- 那筆贏的訊息，而不是報錯或插入第二筆。
      select * into v_message
      from public.messages
      where room_id = p_room_id and client_id = p_client_id;
    end;
  end if;

  if p_mention_agent_ids is not null and array_length(p_mention_agent_ids, 1) > 0 then
    foreach v_agent_id in array p_mention_agent_ids loop
      insert into public.message_mentions (message_id, agent_id)
      values (v_message.id, v_agent_id)
      on conflict (message_id, agent_id) do nothing;
    end loop;
  end if;

  return v_message;
end;
$$;

grant execute on function public.send_message_with_mentions(uuid, text, text, uuid[]) to authenticated;
