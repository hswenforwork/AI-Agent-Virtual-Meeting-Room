-- D 階段（17 項修正與升級執行計劃）項目 5 + 11：檔案儲存生命週期修正。

-- 項目 5：刪房後檔案下載——notes/tasks/files 早在 0012_workspace_owner_id.sql 就已經
-- 徹底跟房間解耦（owner_id 才是真正歸屬，room_id 刪房後會被 SET NULL，見該 migration
-- 第 96-99 行），files 這張表本身的 RLS（files_select_own）也早就只看 owner_id，不看
-- room_id 還在不在。但 Storage bucket 本身的 RLS（0002_storage.sql 的
-- room_files_select_member）從來沒有跟著更新，仍然只看「這個檔案路徑第一段的 room_id，
-- 使用者現在還是不是這個房間的成員」——房間一旦被刪除，room_members 連帶被刪光
-- （cascade），is_room_member() 對任何人都回傳 false，導致檔案的擁有者自己也永遠沒辦法
-- 再下載這份已經跟房間解耦、理論上應該還在的檔案：前端 getFileDownloadUrl() 呼叫的
-- createSignedUrl() 本身就會先被這條 RLS 擋下（不是簽出來的網址之後失效，是根本簽不
-- 出網址）。
--
-- 修正：新增一條「檔案擁有者」的 SELECT policy，跟既有的「房間成員」policy 並存
-- （Postgres 對同一個指令的多個 permissive policy 是用 OR 合併，不會互相取代、也不用
-- 動到既有那條 policy）——房間還在時，房間成員（含擁有者）都能下載；房間被刪除後，
-- 只剩擁有者能繼續下載，不會因為房間消失就連自己的檔案都拿不回來。已經被 file.delete
-- 軟刪除（status <> 'active'）的檔案不會被這條新 policy 允許存取。
create policy "room_files_select_owner" on storage.objects
  for select using (
    bucket_id = 'room-files'
    and exists (
      select 1 from public.files f
      where f.bucket = 'room-files'
        and f.object_path = storage.objects.name
        and f.owner_id = auth.uid()
        and f.status = 'active'
    )
  );

-- 項目 11：檔案登記核對——file-register Edge Function 原本的 10MB／MIME 類型限制只
-- 驗證請求 body 裡使用者「自己宣稱」的 sizeBytes／mimeType，從來沒有跟 Storage 裡真正
-- 上傳的物件核對過；bucket 本身也完全沒有設定任何限制，前端可以直接呼叫 Storage API
-- 上傳任意大小、任意類型的檔案，file-register 只是照抄一份使用者自己填的中繼資料存進
-- files 表，兩個獨立的資料來源（真正上傳的物件 vs. 使用者宣稱的中繼資料）從未互相核對。
--
-- 這裡先在 Storage 層加上原生限制（同時也是任何直接呼叫 Storage API、繞過前端 UI 的
-- 請求都會被擋下的第一道防線，不只靠 file-register 自己的應用層檢查）；file-register
-- 本身改成讀取 Storage 真正記錄的物件中繼資料做二次核對，見該檔案的修正說明。
update storage.buckets
set
  file_size_limit = 10485760, -- 10MB，跟 file-register/index.ts 的 MAX_SIZE_BYTES 保持一致
  allowed_mime_types = array[
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'text/plain', 'text/markdown', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
where id = 'room-files';
