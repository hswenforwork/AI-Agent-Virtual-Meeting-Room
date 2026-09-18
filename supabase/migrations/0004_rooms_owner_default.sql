-- rooms.owner_id 改由資料庫用目前登入者的 auth.uid() 帶入，不再信任前端傳來的值。
-- 修正「new row violates row-level security policy for table "rooms"」：
-- 前端傳入的 owner_id 若跟伺服器端評估 auth.uid() 當下的值有任何落差（例如 session 剛切換的瞬間），
-- INSERT 的 with check (owner_id = auth.uid()) 就會被擋下來；改用 DEFAULT 後這個值一律由伺服器端
-- 在同一個請求內求值，不會再有落差。

alter table public.rooms
  alter column owner_id set default auth.uid();
