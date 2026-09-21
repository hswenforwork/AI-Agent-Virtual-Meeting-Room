-- 「工作型代理」第一階段：任務卡片訊息類型 + worker_tasks 追蹤表
-- 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q4/Q6/Q8/Q9，機制改用 Managed Agents（CMA）

-- ---------------------------------------------------------------------------
-- messages：新增 kind（chat / task_card）與 metadata（任務卡片狀態/產出）
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists kind text not null default 'chat' check (kind in ('chat', 'task_card')),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- worker_tasks：一次「工作型代理」執行的後端追蹤紀錄（前端只讀，寫入一律走 Edge Function）
-- ---------------------------------------------------------------------------
create table if not exists public.worker_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  agent_id uuid not null references public.agents (id),
  origin_message_id uuid not null references public.messages (id),
  task_card_message_id uuid references public.messages (id),
  task_summary text not null default '',
  status text not null default 'pending_confirmation'
    check (status in ('pending_confirmation', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  session_id text,
  error_message text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists worker_tasks_room_status_idx on public.worker_tasks (room_id, status, created_at);

alter table public.worker_tasks enable row level security;

create policy "worker_tasks_select_member" on public.worker_tasks
  for select using (public.is_room_member(room_id));

-- 前端不可直接寫入/更新 worker_tasks（一律由 Edge Function 用 service_role 處理，
-- 「開始執行」按鈕呼叫 worker-task-start 這個 Edge Function，而不是直接 update 這張表）
