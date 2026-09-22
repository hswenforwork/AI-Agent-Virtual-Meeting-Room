-- 使用者自選模型：對應 brainstorms/2026-09-22-provider-model-selection.md
-- 在 user_provider_keys 加兩個欄位：使用者選的模型、快取的模型清單（連同抓取時間）。
-- 都不是機密資料（不是 API key 本身），不需要 Vault，直接存在這張表就好；
-- 既有的 "user_provider_keys_select_own" policy 已經涵蓋這兩個新欄位。

alter table public.user_provider_keys
  add column if not exists selected_model text,
  add column if not exists cached_models jsonb not null default '[]'::jsonb,
  add column if not exists models_fetched_at timestamptz;
