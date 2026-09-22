-- 使用者自帶 API Key（BYOK）：Vault 加密儲存 + 每位使用者專屬 Managed Agents 資源
-- 對應 brainstorms/2026-09-22-user-api-key-settings.md Q1-Q10

-- ---------------------------------------------------------------------------
-- 啟用 Supabase Vault（多數專案預設已啟用，重複執行安全）
-- ---------------------------------------------------------------------------
create extension if not exists supabase_vault cascade;

-- ---------------------------------------------------------------------------
-- user_provider_keys：每個使用者、每個供應商各自一把金鑰
--   不存明碼，只存指向 vault.secrets 的 id；明碼只能透過下方 SECURITY DEFINER
--   函式讀取，且只授權給 service_role（Edge Function 專用），前端 anon/authenticated
--   角色完全碰不到明碼（對應 Q6）
-- ---------------------------------------------------------------------------
create table if not exists public.user_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  vault_secret_id uuid not null references vault.secrets (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.user_provider_keys enable row level security;

-- 使用者可以看到「自己有沒有設定某供應商的金鑰」（只有 vault_secret_id 這個參照值，
-- 不是明碼，就算被讀到也無法解密——vault schema 不對 PostgREST 開放，且下方解密函式
-- 只授權 service_role 呼叫），前端用這個判斷 @mention 是否可用（對應 Q5）
create policy "user_provider_keys_select_own" on public.user_provider_keys
  for select using (auth.uid() = user_id);

-- 不開放 insert/update/delete policy 給 authenticated：一律透過下方 SECURITY DEFINER
-- 函式（由 Edge Function 用 service_role 呼叫）寫入，前端不可直接改資料表

-- ---------------------------------------------------------------------------
-- user_managed_agents：每個使用者專屬的 Managed Agents agent/environment
--   （對應 Q9/Q10：Managed Agents 的 agent/environment 綁定特定 Anthropic 帳號，
--   換金鑰不夠，每個使用者第一次用工作型代理時要有自己專屬的一份）
--   完全不對前端開放，純粹後端內部使用
-- ---------------------------------------------------------------------------
create table if not exists public.user_managed_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  agent_id text not null,
  environment_id text not null,
  created_at timestamptz not null default now()
);

alter table public.user_managed_agents enable row level security;
-- 不建立任何 policy：RLS 預設全部拒絕，只有 service_role（略過 RLS）能存取

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER 函式：寫入／讀取／刪除金鑰，唯一能碰 vault schema 的入口
-- ---------------------------------------------------------------------------
create or replace function public.set_user_provider_key(p_user_id uuid, p_provider text, p_secret text)
returns void
language plpgsql
security definer set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  select vault_secret_id into v_existing_secret_id
  from public.user_provider_keys
  where user_id = p_user_id and provider = p_provider;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    update public.user_provider_keys
      set updated_at = now()
      where user_id = p_user_id and provider = p_provider;
  else
    insert into public.user_provider_keys (user_id, provider, vault_secret_id)
    values (
      p_user_id,
      p_provider,
      vault.create_secret(p_secret, p_user_id::text || ':' || p_provider, 'BYOK provider API key')
    );
  end if;
end;
$$;

create or replace function public.get_user_provider_key(p_user_id uuid, p_provider text)
returns text
language plpgsql
security definer set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_decrypted text;
begin
  select vault_secret_id into v_secret_id
  from public.user_provider_keys
  where user_id = p_user_id and provider = p_provider;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_decrypted
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_decrypted;
end;
$$;

create or replace function public.delete_user_provider_key(p_user_id uuid, p_provider text)
returns void
language plpgsql
security definer set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select vault_secret_id into v_secret_id
  from public.user_provider_keys
  where user_id = p_user_id and provider = p_provider;

  if v_secret_id is not null then
    delete from public.user_provider_keys where user_id = p_user_id and provider = p_provider;
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;

revoke all on function public.set_user_provider_key(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_user_provider_key(uuid, text) from public, anon, authenticated;
revoke all on function public.delete_user_provider_key(uuid, text) from public, anon, authenticated;

grant execute on function public.set_user_provider_key(uuid, text, text) to service_role;
grant execute on function public.get_user_provider_key(uuid, text) to service_role;
grant execute on function public.delete_user_provider_key(uuid, text) to service_role;
