-- 記事本／待辦事項／檔案夾改成跨聊天室共用
-- 對應 brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1-Q3
--
-- 設計：不搬動既有資料、不改欄位（notes/tasks/files 的 room_id 保持不變，
-- 上傳檔案的 Storage 路徑、approval_requests 稽核流程也完全不受影響）——
-- 純粹把「可以看到哪些資料」的 RLS 判斷，從「這個房間的成員」放寬成
-- 「這個使用者自己名下所有房間」，達到「完全共用」的效果（Q1），
-- 同時因為 room_id 沒被改掉，前端可以直接 join rooms.name 當作「來源房間名稱」
-- 顯示小標籤用（Q3），不需要額外欄位、也不需要搬移既有資料（Q2）。

create or replace function public.is_workspace_owner(target_room_id uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.rooms
    where id = target_room_id and owner_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
drop policy if exists "notes_select_member" on public.notes;
drop policy if exists "notes_insert_member" on public.notes;
drop policy if exists "notes_update_member" on public.notes;
drop policy if exists "notes_delete_member" on public.notes;

create policy "notes_select_owner" on public.notes
  for select using (public.is_workspace_owner(room_id));

create policy "notes_insert_owner" on public.notes
  for insert with check (public.is_workspace_owner(room_id));

create policy "notes_update_owner" on public.notes
  for update using (public.is_workspace_owner(room_id));

create policy "notes_delete_owner" on public.notes
  for delete using (public.is_workspace_owner(room_id));

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
drop policy if exists "tasks_select_member" on public.tasks;
drop policy if exists "tasks_insert_member" on public.tasks;
drop policy if exists "tasks_update_member" on public.tasks;
drop policy if exists "tasks_delete_member" on public.tasks;

create policy "tasks_select_owner" on public.tasks
  for select using (public.is_workspace_owner(room_id));

create policy "tasks_insert_owner" on public.tasks
  for insert with check (public.is_workspace_owner(room_id));

create policy "tasks_update_owner" on public.tasks
  for update using (public.is_workspace_owner(room_id));

create policy "tasks_delete_owner" on public.tasks
  for delete using (public.is_workspace_owner(room_id));

-- ---------------------------------------------------------------------------
-- files / file_text_chunks（Storage bucket 的路徑與 RLS 不變：上傳者一定是
-- 該房間成員，換到別的房間檢視同一份共用清單時，該使用者仍然是原房間成員，
-- 產生 signed URL 下載連結不受影響）
-- ---------------------------------------------------------------------------
drop policy if exists "files_select_member" on public.files;
drop policy if exists "files_insert_member" on public.files;
drop policy if exists "file_text_chunks_select_member" on public.file_text_chunks;

create policy "files_select_owner" on public.files
  for select using (public.is_workspace_owner(room_id));

create policy "files_insert_owner" on public.files
  for insert with check (public.is_workspace_owner(room_id) and created_by = auth.uid());

create policy "file_text_chunks_select_owner" on public.file_text_chunks
  for select using (
    exists (select 1 from public.files f where f.id = file_id and public.is_workspace_owner(f.room_id))
  );
