-- 修正 handle_new_user()：訪客（匿名）登入沒有 email，
-- 原本的 coalesce 在沒有 email 也沒有 display_name 時會算出 NULL，
-- 違反 profiles.display_name 的 not null 限制，導致 Supabase 回報
-- "Database error creating anonymous user"。

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), '訪客')
  );
  return new;
end;
$$;
