-- Phase A（17 項修正計劃）：跨帳號權限隔離修正。
-- 對應項目 1（自行加入別人房間）、3（跨房間點名）、8（核准原子化與過期）。
-- 項目 2（approval-decide 的 file.delete 缺 owner 驗證）純粹是 Edge Function 程式碼修正，
-- 不需要 schema 變更，見 supabase/functions/approval-decide/index.ts。
--
-- 這個檔案原本從最新 main（fa126b5）獨立分支出來，跟尚未合併的 PR #44
-- （原本也叫 0019_shared_knowledge.sql）並存在同一個序號；整合分支（PR #45/#44/#46
-- 三個 PR 合併，見 docs/17項計劃-ABC整合測試報告.md）把這個檔案保留為 0019（最先合併的
-- 基礎安全修正），PR #44 的 migration 依實際依賴改編號成 0020/0021，PR #46 改編號成
-- 0022~0025，不再各自獨立編號。

-- ---------------------------------------------------------------------------
-- 項目 1：room_members_insert_owner 移除自行入會分支
-- ---------------------------------------------------------------------------
-- 原本的 policy 除了「房主可以幫房間加成員」，還多一條「user_id = auth.uid()」——
-- 任何登入使用者都能自己組一筆 {room_id: 別人的房間, user_id: 自己} 送出 insert，
-- 不需要對方邀請或同意，就能取得該房間的成員資格（連帶取得訊息/代理/approval_requests/
-- Storage 物件的讀取權限，因為這些幾乎全部經由 is_room_member() 判斷）。
-- 這個分支原本可能是為了讓 handle_new_room() 之外還有別的自行加入情境，
-- 但目前這個專案是單人／房主邀請制，沒有任何自助加入他人房間的合法用途；
-- 房間建立時的「owner 自動加入」完全由 handle_new_room()（security definer，
-- 不受這條 RLS policy 限制）處理，拿掉這個分支不影響建房流程。
-- 未來如果要做邀請制，應該另外設計一次性邀請 token 流程，不是在這裡恢復這個分支。
drop policy if exists "room_members_insert_owner" on public.room_members;
create policy "room_members_insert_owner" on public.room_members
  for insert with check (
    exists (select 1 from public.rooms where id = room_id and owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 項目 3：跨房間點名——message_mentions 的 INSERT policy 補上房間一致性驗證
-- ---------------------------------------------------------------------------
-- 原本只檢查「這則訊息是不是我發的」，沒有檢查「被點名的 agent_id 是否屬於這則訊息
-- 所在的房間」——使用者可以在自己房間發的訊息底下，插入一筆指向別人房間代理 id 的
-- message_mentions，讓 chat-dispatch 把那個不屬於這個房間的代理也拉進來執行
-- （見下面 chat-dispatch 那份程式碼修正，兩層一起擋）。
drop policy if exists "message_mentions_insert_own" on public.message_mentions;
create policy "message_mentions_insert_own" on public.message_mentions
  for insert with check (
    exists (
      select 1 from public.messages m
      join public.agents a on a.id = agent_id
      where m.id = message_id
        and m.sender_user_id = auth.uid()
        and a.room_id = m.room_id
    )
  );

-- ---------------------------------------------------------------------------
-- 項目 8：核准原子化與期限——approval_requests 新增 executing 中繼狀態
-- ---------------------------------------------------------------------------
-- 原本的流程是「SELECT 讀一次 status，程式碼判斷完再分開 UPDATE」，兩個同時送出的
-- 核准請求都可能在對方還沒寫回之前讀到同一個 pending，兩個都通過檢查、各自執行一次
-- 高風險操作（實測：兩個同時核准同一筆 approval，file.delete 被執行兩次，
-- audit_logs 也留下兩筆 executed 紀錄，見 PR 說明的重現紀錄）。
-- 新增 executing 這個中繼狀態，讓 approval-decide 用「UPDATE ... WHERE status='pending'」
-- 這種條件式更新去原子搶占 pending -> executing，PostgreSQL 保證同一筆列的並發 UPDATE
-- 只有一個交易能搶到、另一個會等鎖、甦醒後看到 status 已經不是 pending 而拿到 0 筆——
-- 這是資料庫層的鎖定機制本身提供的保證，不是應用層自己判斷。
alter table public.approval_requests drop constraint if exists approval_requests_status_check;
alter table public.approval_requests add constraint approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'executing', 'executed', 'failed'));
