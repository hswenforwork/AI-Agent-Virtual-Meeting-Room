-- D 階段（17 項修正與升級執行計劃）項目 5 + 11 + 15：檔案儲存生命週期修正。

-- 項目 5：刪房後檔案下載——files 資料表早在 0012_workspace_owner_id.sql 就已經徹底
-- 跟房間解耦（owner_id 才是真正歸屬，room_id 刪房後會被 SET NULL，見該 migration
-- 第 96-99 行），files 這張表本身的 RLS（files_select_own）也早就只看 owner_id，不看
-- room_id 還在不在。但 Storage bucket 本身的 RLS（0002_storage.sql 的
-- room_files_select_member）從來沒有跟著更新，仍然只看「這個檔案路徑第一段的 room_id，
-- 使用者現在還是不是這個房間的成員」——房間一旦被刪除，room_members 連帶被刪光
-- （cascade），is_room_member() 對任何人都回傳 false，導致檔案的擁有者自己也永遠沒辦法
-- 再下載這份已經跟房間解耦、理論上應該還在的檔案：前端 getFileDownloadUrl() 呼叫的
-- createSignedUrl() 本身就會先被這條 RLS 擋下（不是簽出來的網址之後失效，是根本簽不
-- 出網址）。
--
-- 兩條 policy 都需要「這個物件在 files 表裡對應的那一列是不是 active、擁有者是誰」
-- ——但 files 表本身有自己的 RLS（files_select_own：只能看到 owner_id = auth.uid()
-- 的列）。如果直接在 storage.objects 的 policy 裡寫一般的 `exists (select 1 from
-- public.files ...)` 子查詢，這個子查詢一樣會被 files_select_own 過濾：非擁有者
-- 呼叫時，子查詢完全看不到別人的 files 列（即使那一列真的存在、真的是 active），
-- exists 恆為 false，會把「房間成員應該看得到別人上傳的檔案」這個既有行為整個弄壞
-- （已經在本機測試中實際重現這個問題，不是理論推測）。
-- 用 SECURITY DEFINER 函式（跟 is_room_member() 同一種手法）繞過這個問題：函式以
-- 建立 migration 的角色（擁有這些表、不受 files 自己的 RLS 限制）執行。
--
-- PR #49 審閱意見：第一版這裡用一個回傳 (owner_id, status) 的函式，讓兩條 policy
-- 各自判斷。問題是這個函式本身是 PostgREST 會自動掛出來的 RPC 端點
-- （/rpc/room_file_status_for_object），任何登入使用者都能直接呼叫、帶任意猜到的
-- object_path，取得「這個路徑是誰的、還在不在」——等於繞過 files_select_own RLS，
-- 直接把 owner_id 這種跨使用者資訊透過 RPC 洩漏出去，跟這個函式原本只是給 policy
-- 內部用的意圖完全不符。而且 authenticated／anon 一定要有 EXECUTE 權限這個函式才能
-- 正常評估 policy（拿掉權限會讓一般查詢直接噴權限錯誤），沒有辦法只允許「透過 policy
-- 呼叫」而擋掉「直接當 RPC 呼叫」，Postgres 的權限模型沒有這種區分。
--
-- 修正：拆成兩個只回傳 boolean、且不接受任意外部 uid 參數的函式，把「能問到什麼」
-- 限縮到最小：
--   - room_file_is_active_owned_by_caller()：只回答「這個路徑是不是 active 而且
--     owner_id 剛好是呼叫者自己（auth.uid()，函式內部讀，不是外部傳入的參數）」，
--     直接當 RPC 呼叫也只能問到自己的檔案狀態，問不到別人的。
--   - room_file_is_active()：只回答「這個路徑目前是不是還有一筆 active 的 files
--     列，不管是誰的」，回傳純 boolean、不含 owner_id。直接當 RPC 呼叫時仍然是一個
--     極小的存在性 oracle（可以問「這個路徑有沒有效」），但比起洩漏 owner_id／status
--     這種可以連結使用者身分的資訊，風險小得多；而且 object_path 本身包在
--     buildObjectPath()（前端 useFiles.ts）產生的路徑裡帶一段 crypto.randomUUID()，
--     不是可枚舉、可猜測的字串，實務上需要先以其他方式拿到這個路徑才問得出東西，
--     這裡誠實記錄這個殘留風險，不是宣稱完全沒有。
create or replace function public.room_file_is_active_owned_by_caller(p_object_path text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.files f
    where f.bucket = 'room-files' and f.object_path = p_object_path
      and f.owner_id = auth.uid() and f.status = 'active'
  )
$$;

create or replace function public.room_file_is_active(p_object_path text)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.files f
    where f.bucket = 'room-files' and f.object_path = p_object_path and f.status = 'active'
  )
$$;

-- 明確限縮執行權限：只給 authenticated／anon（storage.objects 的 RLS policy 評估
-- 時的查詢角色需要，拿掉會讓一般查詢直接噴權限錯誤），不額外授權給其他角色。
revoke all on function public.room_file_is_active_owned_by_caller(text) from public;
grant execute on function public.room_file_is_active_owned_by_caller(text) to authenticated, anon;
revoke all on function public.room_file_is_active(text) from public;
grant execute on function public.room_file_is_active(text) to authenticated, anon;

-- 新增一條「檔案擁有者」的 SELECT policy，跟既有的「房間成員」policy 並存
-- （Postgres 對同一指令的多個 permissive policy 用 OR 合併，不用動到既有那條
-- policy）——房間還在時，房間成員（含擁有者）都能下載；房間被刪除後，只剩擁有者能
-- 繼續下載，不會因為房間消失就連自己的檔案都拿不回來。已經被 file.delete 軟刪除
-- （status <> 'active'）的檔案不會被這條新 policy 允許存取。
create policy "room_files_select_owner" on storage.objects
  for select using (
    bucket_id = 'room-files'
    and public.room_file_is_active_owned_by_caller(storage.objects.name)
  );

-- PR #48 審閱意見：只加一條新 policy 還不夠——既有的 room_files_select_member 從
-- 0002_storage.sql 建立以來，就只看「使用者現在是不是這個房間的成員」，完全不管
-- files.status。這代表就算檔案已經被 file.delete 軟刪除（DB 層應該已經收回存取
-- 權限），只要房間還在、使用者還是房間成員，這條舊 policy 一樣會放行——如果
-- approval-decide 執行 file.delete 時，DB 軟刪除成功了、但實際刪除 Storage 物件那
-- 一步失敗（見 approval-decide/index.ts 的說明），這個「已經刪除」的物件其實還是能
-- 被任何房間成員簽出新的下載網址，soft delete 沒有真的收回下載權限，只是列表看不到
-- 而已。
--
-- 修正：把既有的 room_files_select_member 也加上跟新 policy 一致的 status='active'
-- 檢查（一樣透過上面的 SECURITY DEFINER 函式，不是直接查 files 表，理由同上）。這樣
-- 不管 Storage 實體清理最後有沒有成功，只要 DB 層的 status 已經不是 active，兩條
-- SELECT policy 都不會再放行任何人（不管是房間成員還是檔案擁有者）簽出新的下載
-- 網址——存取權限的收回只看 DB 的 files.status，不依賴 Storage 清理這個盡力而為的
-- 後續步驟有沒有真的成功。
drop policy if exists "room_files_select_member" on storage.objects;
create policy "room_files_select_member" on storage.objects
  for select using (
    bucket_id = 'room-files'
    and public.is_room_member((storage.foldername(name))[1]::uuid)
    and public.room_file_is_active(storage.objects.name)
  );

-- PR #49 審閱意見：file-register 原本只確認呼叫者是房間成員、Storage 物件真的存在，
-- 就把呼叫者寫成 files.owner_id——完全沒有核對這個物件當初是「誰」上傳的
-- （storage.objects.owner，Storage 在上傳當下依 room_files_insert_member policy 的
-- with check owner = auth.uid() 設定，之後沒有任何前端／後端流程會去改它）。同一個
-- 房間的另一個成員 A，只要知道／猜到房間成員 B 已經上傳的 object_path，就能呼叫
-- file-register 幫同一個物件登記一筆 owner_id=A 的 files 列，實質上把 B 的檔案
-- 「據為己有」——之後 A 甚至可以透過 file.delete 核准流程把 B 上傳的實體物件刪掉，
-- B 完全不知情也沒有核准過。
--
-- 這裡新增一個只給 service_role 呼叫的函式，讀出 storage.objects.owner，讓
-- file-register（本來就是用 service_role 的 admin client 在跑）可以核對「呼叫者
-- 是不是真正的上傳者」。只授權給 service_role：owner 欄位本身雖然只是一個 uuid，
-- 但跨使用者揭露「誰上傳了這個路徑」一樣不該讓一般使用者能直接當 RPC 問到，所以
-- 不比照上面兩個函式授權給 authenticated／anon。
--
-- 本機測試時實際發現（真的用 authenticated／anon 的 JWT 直接呼叫這支函式驗證過，
-- 不是理論推測）：Supabase 專案（以及這裡的測試基礎設施）對 public schema 都設有
-- `alter default privileges ... grant execute on functions to authenticated, anon,
-- service_role`，讓新建立的函式預設就對 authenticated／anon 開放執行權限（這也是
-- is_room_member() 等既有函式不用額外下 grant 就能被 policy／PostgREST 呼叫的
-- 原因）。這代表單純下 `revoke all ... from public` 完全沒用——那只會撤銷
-- PUBLIC 這個虛擬角色本身的權限，撤不掉已經透過 default privileges 直接授與
-- authenticated／anon 這兩個實際角色的權限，這支函式建立後 authenticated／anon
-- 其實還是能直接呼叫成功。必須明確把 authenticated／anon 兩個角色本身也一起
-- revoke 掉，才會真的被 Postgres 權限系統擋下來。
create or replace function public.room_files_storage_object_owner(p_bucket text, p_object_path text)
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select owner from storage.objects where bucket_id = p_bucket and name = p_object_path limit 1
$$;

revoke all on function public.room_files_storage_object_owner(text, text) from public, authenticated, anon;
grant execute on function public.room_files_storage_object_owner(text, text) to service_role;

-- PR #49 審閱意見：files 表對 (bucket, object_path) 沒有唯一約束——如果上面的
-- 上傳者核對萬一被繞過（例如未來有其他呼叫路徑忘記做這個檢查），或單純同一個物件被
-- 登記兩次，會出現兩筆 files 列指向同一個實體物件、owner_id 卻不同的情況。這種情況下
-- 上面 room_file_is_active_owned_by_caller()／room_file_is_active() 兩個函式的
-- `limit 1` 會選到哪一筆完全沒有保證順序（不依賴任何 ORDER BY），代表「刪房後誰還能
-- 下載」這種存取控制判斷會變成不確定、可能因為查詢計畫或資料寫入順序而改變。加一個
-- 唯一約束，讓資料庫本身直接擋下「同一個 object_path 被登記兩次」，不只靠應用層的
-- 上傳者核對這一道防線。
alter table public.files
  add constraint files_bucket_object_path_key unique (bucket, object_path);

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
