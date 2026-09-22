-- 左側聊天室歷史清單：封存/刪除、AI 自動標題、依最新活動排序
-- 對應 brainstorms/2026-09-22-room-sidebar-history.md Q1/Q2/Q4/Q5

-- ---------------------------------------------------------------------------
-- rooms：新增封存狀態、最新活動時間、標題是否已由 AI 產生過
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column if not exists archived_at timestamptz,
  add column if not exists last_message_at timestamptz not null default now(),
  add column if not exists title_generated boolean not null default false;

-- 新增欄位時，既有房間也會套用同一個 default（title_generated = false）。
-- 如果不回填，這些房間已經有的自訂名稱，會在使用者下一次在裡面發言時
-- 被 chat-dispatch 誤判成「還沒產生過標題」，自動用那則訊息內容覆蓋掉原本的名稱。
-- 自動標題功能只該套用在這個 migration 之後才建立的全新房間上。
update public.rooms set title_generated = true where title_generated = false;

-- 回填既有房間真正的最後活動時間（用實際的最新一則訊息時間，沒有訊息就用房間建立時間），
-- 不然新欄位的 default now() 會讓所有既有房間在這次搬移後的排序全部擠在「現在」，
-- 要等之後陸續有新訊息才會慢慢排回正確順序。
update public.rooms r
set last_message_at = coalesce(
  (select max(m.created_at) from public.messages m where m.room_id = r.id),
  r.created_at
);

create index if not exists rooms_owner_last_message_idx
  on public.rooms (owner_id, last_message_at desc);

-- 新訊息一進來就更新該房間的 last_message_at，左側清單靠這個欄位排序，
-- 不用每次都查 messages 表算最大值。
create or replace function public.touch_room_last_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.rooms set last_message_at = new.created_at where id = new.room_id;
  return new;
end;
$$;

drop trigger if exists on_message_touch_room on public.messages;
create trigger on_message_touch_room
  after insert on public.messages
  for each row execute procedure public.touch_room_last_message();

-- ---------------------------------------------------------------------------
-- Realtime：左側清單要能即時反映新房間、AI 標題產生完成、封存/刪除狀態變化，
-- 不加這段的話這些變化只能等重新整理才會出現（跟 messages/agent_runs 同樣的坑）。
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.rooms;
