-- AI 協作室 MVP v2 — 初始 schema
-- 對應 docs/MVP規劃-v2.md 第 5 章「資料庫調整重點」
-- 設計原則：單一使用者為主、結構上預留多人擴充，不做完整 4 級角色權限矩陣

-- ---------------------------------------------------------------------------
-- profiles：使用者公開資料，註冊時由 trigger 自動建立
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- rooms / room_members：協作室與成員
-- ---------------------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.room_members
    where room_id = target_room_id and user_id = auth.uid()
  );
$$;

create policy "rooms_select_member" on public.rooms
  for select using (public.is_room_member(id));

create policy "rooms_insert_own" on public.rooms
  for insert with check (owner_id = auth.uid());

create policy "rooms_update_owner" on public.rooms
  for update using (owner_id = auth.uid());

create policy "rooms_delete_owner" on public.rooms
  for delete using (owner_id = auth.uid());

create policy "room_members_select_member" on public.room_members
  for select using (public.is_room_member(room_id));

create policy "room_members_insert_owner" on public.room_members
  for insert with check (
    exists (select 1 from public.rooms where id = room_id and owner_id = auth.uid())
    or user_id = auth.uid()
  );

create policy "room_members_delete_owner" on public.room_members
  for delete using (
    exists (select 1 from public.rooms where id = room_id and owner_id = auth.uid())
  );

-- 建立房間時，owner 自動加入 room_members
create or replace function public.handle_new_room()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.room_members (room_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

drop trigger if exists on_room_created on public.rooms;
create trigger on_room_created
  after insert on public.rooms
  for each row execute procedure public.handle_new_room();

-- ---------------------------------------------------------------------------
-- agents：MVP 階段代表「供應商」而非角色（Q2, Q6）
--   slug: supervisor（未點名時預設回覆，v2 綁定 claude）/ claude / gpt / gemini
-- ---------------------------------------------------------------------------
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  slug text not null,
  name text not null,
  provider text not null check (provider in ('anthropic', 'openai', 'google')),
  status text not null default 'inactive' check (status in ('active', 'inactive')),
  is_supervisor boolean not null default false,
  system_prompt text not null default '',
  model_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, slug)
);

alter table public.agents enable row level security;

create policy "agents_select_member" on public.agents
  for select using (public.is_room_member(room_id));

-- agents 由後端（service_role，透過建立房間時的 seed 邏輯）寫入，前端不可直接新增/修改
-- 不建立 insert/update/delete policy for authenticated role → 一律被拒絕

-- 建立房間時，自動建立三個供應商代理（Claude 啟用，GPT/Gemini 先 inactive）
create or replace function public.seed_room_agents()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.agents (room_id, slug, name, provider, status, is_supervisor, system_prompt)
  values
    (new.id, 'claude', 'Claude', 'anthropic', 'active', true,
     '你是這個協作室的預設值班助理。請直接、務實地回答使用者的問題。'),
    (new.id, 'gpt', 'GPT', 'openai', 'inactive', false,
     '你是被使用者額外點名請益的專家，針對使用者的問題提供你的觀點。'),
    (new.id, 'gemini', 'Gemini', 'google', 'inactive', false,
     '你是被使用者額外點名請益的專家，針對使用者的問題提供你的觀點。');
  return new;
end;
$$;

drop trigger if exists on_room_created_seed_agents on public.rooms;
create trigger on_room_created_seed_agents
  after insert on public.rooms
  for each row execute procedure public.seed_room_agents();

-- ---------------------------------------------------------------------------
-- messages / message_mentions：共用時間軸與結構化點名
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  sender_type text not null check (sender_type in ('user', 'agent', 'system')),
  sender_user_id uuid references public.profiles (id),
  sender_agent_id uuid references public.agents (id),
  content text not null,
  status text not null default 'completed' check (status in ('pending', 'streaming', 'completed', 'failed')),
  reply_to_id uuid references public.messages (id),
  client_id text,
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create unique index if not exists messages_room_client_id_idx on public.messages (room_id, client_id) where client_id is not null;

create table if not exists public.message_mentions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;
alter table public.message_mentions enable row level security;

create policy "messages_select_member" on public.messages
  for select using (public.is_room_member(room_id));

-- 使用者只能以自己的身分寫入 user 訊息；agent/system 訊息只能由後端（service_role）寫入
create policy "messages_insert_own" on public.messages
  for insert with check (
    public.is_room_member(room_id)
    and sender_type = 'user'
    and sender_user_id = auth.uid()
  );

create policy "message_mentions_select_member" on public.message_mentions
  for select using (
    exists (select 1 from public.messages m where m.id = message_id and public.is_room_member(m.room_id))
  );

create policy "message_mentions_insert_own" on public.message_mentions
  for insert with check (
    exists (
      select 1 from public.messages m
      where m.id = message_id and m.sender_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- agent_runs：每次代理執行（只能由後端寫入/更新）
-- ---------------------------------------------------------------------------
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  agent_id uuid not null references public.agents (id),
  trigger_message_id uuid not null references public.messages (id),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'rate_limited', 'cancelled')),
  error_code text,
  usage_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_runs_room_status_idx on public.agent_runs (room_id, status, created_at);

alter table public.agent_runs enable row level security;

create policy "agent_runs_select_member" on public.agent_runs
  for select using (public.is_room_member(room_id));

-- 前端不可直接寫入/更新 agent_runs（一律由 Edge Function 用 service_role 處理）

-- ---------------------------------------------------------------------------
-- notes：低風險寫入，Q12 → 直接透過前端 SDK CRUD，不需確認卡
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null default '未命名記事',
  content text not null default '',
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "notes_select_member" on public.notes
  for select using (public.is_room_member(room_id));

create policy "notes_insert_member" on public.notes
  for insert with check (public.is_room_member(room_id));

create policy "notes_update_member" on public.notes
  for update using (public.is_room_member(room_id));

create policy "notes_delete_member" on public.notes
  for delete using (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- tasks：低風險寫入，同 notes
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'done')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_room_status_created_idx on public.tasks (room_id, status, created_at);

alter table public.tasks enable row level security;

create policy "tasks_select_member" on public.tasks
  for select using (public.is_room_member(room_id));

create policy "tasks_insert_member" on public.tasks
  for insert with check (public.is_room_member(room_id));

create policy "tasks_update_member" on public.tasks
  for update using (public.is_room_member(room_id));

create policy "tasks_delete_member" on public.tasks
  for delete using (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- files / file_text_chunks：Q9/Q10 → MVP 必要，共享上下文優先
--   刪除屬於高風險操作（Q12），前端不可直接刪除，需經 approval_requests → tool-execute
-- ---------------------------------------------------------------------------
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  bucket text not null default 'room-files',
  object_path text not null,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  status text not null default 'active' check (status in ('active', 'deleted')),
  deleted_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists files_room_created_idx on public.files (room_id, created_at desc);

create table if not exists public.file_text_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.files (id) on delete cascade,
  chunk_no int not null,
  content text not null,
  token_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (file_id, chunk_no)
);

alter table public.files enable row level security;
alter table public.file_text_chunks enable row level security;

create policy "files_select_member" on public.files
  for select using (public.is_room_member(room_id));

-- 上傳（新增中繼資料）屬低風險，允許前端直接寫入；刪除/修改狀態則不開放，一律走 Edge Function
create policy "files_insert_member" on public.files
  for insert with check (public.is_room_member(room_id) and created_by = auth.uid());

create policy "file_text_chunks_select_member" on public.file_text_chunks
  for select using (
    exists (select 1 from public.files f where f.id = file_id and public.is_room_member(f.room_id))
  );

-- ---------------------------------------------------------------------------
-- approval_requests / tool_calls：只用於高風險操作（Q12：刪除、批次修改）
-- ---------------------------------------------------------------------------
create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  run_id uuid references public.agent_runs (id),
  requested_by uuid references public.profiles (id),
  tool_name text not null,
  arguments_json jsonb not null default '{}'::jsonb,
  risk_level text not null default 'high' check (risk_level in ('medium', 'high')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists approval_requests_room_status_idx on public.approval_requests (room_id, status, created_at);

alter table public.approval_requests enable row level security;

create policy "approval_requests_select_member" on public.approval_requests
  for select using (public.is_room_member(room_id));

create policy "approval_requests_insert_member" on public.approval_requests
  for insert with check (public.is_room_member(room_id) and requested_by = auth.uid());

-- 核准/拒絕只能透過 Edge Function（service_role）更新，避免前端直接把 status 改成 approved 後繞過稽核

-- ---------------------------------------------------------------------------
-- audit_logs：所有由後端執行的動作都留痕，供使用者事後查看（Q12）
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_room_created_idx on public.audit_logs (room_id, created_at desc);

alter table public.audit_logs enable row level security;

create policy "audit_logs_select_member" on public.audit_logs
  for select using (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- usage_daily：預算追蹤（Q4/Q11：US$30/月基準）
-- ---------------------------------------------------------------------------
create table if not exists public.usage_daily (
  usage_date date not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  request_count int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  errors int not null default 0,
  primary key (usage_date, room_id, agent_id)
);

alter table public.usage_daily enable row level security;

create policy "usage_daily_select_member" on public.usage_daily
  for select using (public.is_room_member(room_id));
