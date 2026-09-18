-- 檔案儲存：private bucket + 依 room_id 路徑限制存取
-- 對應 docs/MVP規劃-v2.md 第 5 章、原始規劃文件 8.2 節 Storage Policy

insert into storage.buckets (id, name, public)
values ('room-files', 'room-files', false)
on conflict (id) do nothing;

-- 路徑格式：{room_id}/{year}/{month}/{uuid}-{safe_filename}
-- 第一段路徑必須是使用者有權存取的 room_id

create policy "room_files_select_member"
  on storage.objects for select
  using (
    bucket_id = 'room-files'
    and public.is_room_member((storage.foldername(name))[1]::uuid)
  );

create policy "room_files_insert_member"
  on storage.objects for insert
  with check (
    bucket_id = 'room-files'
    and public.is_room_member((storage.foldername(name))[1]::uuid)
    and owner = auth.uid()
  );

-- 刪除物件本身不開放給前端（高風險操作，Q12），只能由 Edge Function 用 service_role 執行
