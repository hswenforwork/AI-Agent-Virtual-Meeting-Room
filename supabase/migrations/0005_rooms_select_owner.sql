-- 修正「new row violates row-level security policy for table "rooms"」：
-- INSERT ... RETURNING 會立刻用 SELECT 政策檢查剛寫入的那筆房間，但把建立者加進
-- room_members 的 handle_new_room() 觸發器這時候還沒跑完，只靠 is_room_member()
-- 會讓「建立房間」這個動作本身失敗（PostgreSQL 官方文件：RETURNING 的新資料列
-- 不滿足 SELECT 政策時會直接報錯，不會靜默略過）。
-- 加上 owner_id = auth.uid()，讓建立者一律能立刻讀到自己剛建立的房間；
-- 其他使用者仍然必須是 room_members 的成員才能讀取，不影響既有的權限邊界。

drop policy if exists "rooms_select_member" on public.rooms;

create policy "rooms_select_member" on public.rooms
  for select using (owner_id = auth.uid() or public.is_room_member(id));
