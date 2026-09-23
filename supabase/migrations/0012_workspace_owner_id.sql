-- 記事本／待辦事項／檔案夾徹底跟房間解耦：新增 owner_id 當真正的歸屬
-- 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q1
--
-- 問題：0011 只是放寬 RLS 讓同一使用者的所有房間互相看得到彼此的 notes/tasks/files，
-- 但資料本身仍然掛在 room_id 上、room_id 是 on delete cascade，所以刪除任何一個房間
--還是會把「看似共用」的資料一起刪掉。這個 migration 徹底解決：owner_id 才是真正的歸屬，
-- room_id 降級成「來源房間」的參考欄位（on delete set null，不再 cascade）。

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
-- default auth.uid() 比照 rooms.owner_id 的既有慣例：前端用使用者自己的 client 新增記事時
-- 不用額外帶 owner_id，RLS insert policy 自然會通過；service_role（workspaceWrite.ts 這種
-- AI 代寫的情境）沒有 auth.uid() context，一定要自己明確帶 owner_id。
alter table public.notes add column if not exists owner_id uuid default auth.uid() references public.profiles (id) on delete cascade;

update public.notes n
set owner_id = r.owner_id
from public.rooms r
where n.room_id = r.id and n.owner_id is null;

alter table public.notes alter column owner_id set not null;

alter table public.notes drop constraint if exists notes_room_id_fkey;
alter table public.notes
  add constraint notes_room_id_fkey foreign key (room_id) references public.rooms (id) on delete set null;
alter table public.notes alter column room_id drop not null;

create index if not exists notes_owner_idx on public.notes (owner_id, updated_at desc);

drop policy if exists "notes_select_owner" on public.notes;
drop policy if exists "notes_insert_owner" on public.notes;
drop policy if exists "notes_update_owner" on public.notes;
drop policy if exists "notes_delete_owner" on public.notes;

create policy "notes_select_own" on public.notes
  for select using (owner_id = auth.uid());

create policy "notes_insert_own" on public.notes
  for insert with check (owner_id = auth.uid());

create policy "notes_update_own" on public.notes
  for update using (owner_id = auth.uid());

create policy "notes_delete_own" on public.notes
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
alter table public.tasks add column if not exists owner_id uuid default auth.uid() references public.profiles (id) on delete cascade;

update public.tasks t
set owner_id = r.owner_id
from public.rooms r
where t.room_id = r.id and t.owner_id is null;

alter table public.tasks alter column owner_id set not null;

alter table public.tasks drop constraint if exists tasks_room_id_fkey;
alter table public.tasks
  add constraint tasks_room_id_fkey foreign key (room_id) references public.rooms (id) on delete set null;
alter table public.tasks alter column room_id drop not null;

create index if not exists tasks_owner_status_idx on public.tasks (owner_id, status, created_at);

drop policy if exists "tasks_select_owner" on public.tasks;
drop policy if exists "tasks_insert_owner" on public.tasks;
drop policy if exists "tasks_update_owner" on public.tasks;
drop policy if exists "tasks_delete_owner" on public.tasks;

create policy "tasks_select_own" on public.tasks
  for select using (owner_id = auth.uid());

create policy "tasks_insert_own" on public.tasks
  for insert with check (owner_id = auth.uid());

create policy "tasks_update_own" on public.tasks
  for update using (owner_id = auth.uid());

create policy "tasks_delete_own" on public.tasks
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- files / file_text_chunks（Storage bucket 路徑與 RLS 不變，見 0011 說明）
-- ---------------------------------------------------------------------------
alter table public.files add column if not exists owner_id uuid default auth.uid() references public.profiles (id) on delete cascade;

update public.files f
set owner_id = r.owner_id
from public.rooms r
where f.room_id = r.id and f.owner_id is null;

alter table public.files alter column owner_id set not null;

alter table public.files drop constraint if exists files_room_id_fkey;
alter table public.files
  add constraint files_room_id_fkey foreign key (room_id) references public.rooms (id) on delete set null;
alter table public.files alter column room_id drop not null;

create index if not exists files_owner_created_idx on public.files (owner_id, created_at desc);

drop policy if exists "files_select_owner" on public.files;
drop policy if exists "files_insert_owner" on public.files;
drop policy if exists "file_text_chunks_select_owner" on public.file_text_chunks;

create policy "files_select_own" on public.files
  for select using (owner_id = auth.uid());

create policy "files_insert_own" on public.files
  for insert with check (owner_id = auth.uid() and created_by = auth.uid());

create policy "file_text_chunks_select_own" on public.file_text_chunks
  for select using (
    exists (select 1 from public.files f where f.id = file_id and f.owner_id = auth.uid())
  );
