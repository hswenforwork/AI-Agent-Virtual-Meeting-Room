-- 跨聊天室共享知識系統：正式背景／決策紀錄／來源索引／代理提案／知識關聯／稽核報告
-- 對應 docs/AI-Partner借鏡對照.md（借鏡 Jaycheng1103/AI-Partner 的 context/、decisions/log.md、
-- connections.md、/grill-me、/audit、/3d-brain，但落地成這個專案真正會讀寫的資料表）。
--
-- 設計原則（跟 notes/tasks/files 在 0012 之後的做法一致）：
--   - 每張表都有自己的 owner_id，直接對 auth.uid() 做 RLS，不透過房間成員關係間接判斷。
--   - 跟聊天室相關的欄位一律叫 xxx_room_id／xxx_message_id，用 on delete set null（軟參照，
--     不是 on delete cascade）——刪除來源聊天室或訊息，知識本身要留著，只是「來源」變成失效。
--   - 代理（service_role）不能直接寫 knowledge_items/decisions/knowledge_links，只能寫
--     knowledge_proposals；要變成正式知識，一定要經過使用者呼叫 accept_knowledge_proposal()。

-- ---------------------------------------------------------------------------
-- knowledge_items：由使用者確認的長期背景（目標／專案／用語／工作規則／事實）
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  category text not null default 'other' check (category in ('goal', 'project', 'term', 'rule', 'fact', 'other')),
  title text not null,
  body text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  -- 過期檢查：expires_at 是使用者自己填的明確到期日；review_interval_days 是複查週期，
  -- 沒填的話 knowledge-audit 用預設 180 天當「太久沒複查」的門檻（見該 Edge Function）。
  expires_at timestamptz,
  review_interval_days int,
  source_room_id uuid references public.rooms (id) on delete set null,
  confirmed_by uuid references public.profiles (id),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_items_owner_status_idx on public.knowledge_items (owner_id, status, updated_at desc);
create index if not exists knowledge_items_owner_expires_idx on public.knowledge_items (owner_id, expires_at);

alter table public.knowledge_items enable row level security;

create policy "knowledge_items_select_own" on public.knowledge_items
  for select using (owner_id = auth.uid());
create policy "knowledge_items_insert_own" on public.knowledge_items
  for insert with check (owner_id = auth.uid());
create policy "knowledge_items_update_own" on public.knowledge_items
  for update using (owner_id = auth.uid());
create policy "knowledge_items_delete_own" on public.knowledge_items
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- decisions：只追加的決策紀錄，取代舊版時用 supersedes_id 明確指向，不悄悄覆蓋
-- ---------------------------------------------------------------------------
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null,
  decision_text text not null,
  reasoning text not null default '',
  alternatives text,
  status text not null default 'active' check (status in ('active', 'superseded')),
  supersedes_id uuid references public.decisions (id),
  superseded_by_id uuid references public.decisions (id),
  decided_at timestamptz not null default now(),
  source_room_id uuid references public.rooms (id) on delete set null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists decisions_owner_status_idx on public.decisions (owner_id, status, decided_at desc);

alter table public.decisions enable row level security;

create policy "decisions_select_own" on public.decisions
  for select using (owner_id = auth.uid());
create policy "decisions_insert_own" on public.decisions
  for insert with check (owner_id = auth.uid());
create policy "decisions_update_own" on public.decisions
  for update using (owner_id = auth.uid());

-- 「只追加」（docs/AI-Partner借鏡對照.md 第 2 項）：決策不能被直接刪除，所以刻意不建立
-- decisions_delete_own policy——沒有 delete policy，RLS 一律拒絕任何刪除請求。下面另外加
-- enforce_decision_append_only() trigger 當最後一道防線（見該函式註解，連 service_role 都擋）。

-- 取代前先驗證：目標決策要存在、屬於同一個帳號、而且目前還是 active，否則整筆新增決策的
-- 操作直接失敗（PR #44 review：不能因為目標決策不符合條件就默默跳過取代，讓兩筆決策同時
-- 都是 active）。用 for update 鎖住目標那一列，避免「同時對同一筆舊決策送出兩個取代」時
-- 兩筆新決策都通過檢查、都宣稱自己取代了它（見 docs/共享知識系統-測試報告.md 的重複取代測試）。
-- PR #44 第四輪 review 修正（revoke update 之後才發現的連帶問題）：PostgreSQL 的
-- `for update` 列鎖，除了 SELECT 權限以外還額外要求呼叫者對目標表有 UPDATE 權限
-- （`for share` 也一樣，已經實測驗證過），跟這一列鎖最終會不會真的執行 UPDATE 無關，
-- 純粹是鎖定子句本身的權限規則。revoke 掉 authenticated 對 decisions 的 UPDATE 之後，
-- 這個函式原本（非 security definer）的寫法會讓一般使用者連合法的新增取代決策都做不到
-- （insert 觸發這個 before insert trigger 就直接 permission denied）。所以跟
-- handle_decision_supersede() 一樣改成 security definer：用函式擁有者的權限做這個
-- for update 鎖定與讀取。附帶影響：如果 supersedes_id 指向別人的決策，RLS 本來會讓這裡
-- 的 select 直接看不到那一列（回報「找不到要取代的決策」），security definer 繞過 RLS 後
-- 這裡看得到那一列、能判斷 owner_id 不符，回報更精確的「不能取代不屬於自己的決策」——
-- 這只是錯誤訊息的差異（洩漏「這個 id 存在」，不洩漏內容），操作本身一樣會被擋下、
-- 不會建立任何新決策，攻擊者要利用這點得先猜中別人一筆決策的 uuid。
create or replace function public.validate_decision_supersede()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  target public.decisions%rowtype;
begin
  if new.supersedes_id is not null then
    if new.supersedes_id = new.id then
      raise exception '決策不能取代自己';
    end if;

    select * into target from public.decisions where id = new.supersedes_id for update;
    if target is null then
      raise exception '找不到要取代的決策（id=%）', new.supersedes_id;
    end if;
    if target.owner_id <> new.owner_id then
      raise exception '不能取代不屬於自己的決策';
    end if;
    if target.status <> 'active' then
      raise exception '要取代的決策目前不是有效狀態（可能已經被其他決策取代，或本身就不是 active），請重新整理後選擇目前有效的版本';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_decision_validate_supersede on public.decisions;
create trigger on_decision_validate_supersede
  before insert on public.decisions
  for each row execute procedure public.validate_decision_supersede();

-- 新決策帶 supersedes_id 時（已經通過上面的驗證），自動把「被取代的舊決策」標成 superseded
-- 並回填 superseded_by_id；舊決策整列都還在（不是刪除、不是覆寫內容），只是狀態換了，
-- 之後檢索（buildKnowledgeContext）只會把 active 的決策餵給模型。
--
-- PR #44 第四輪 review 修正（真正的重點）：這個函式標成 security definer，用函式擁有者
-- （執行這份 migration 的角色，正常情況下是 postgres／專案的 owner，權限足夠）的身分執行
-- 底下這個 UPDATE，不是用呼叫它的使用者身分——因為 authenticated／service_role 已經被
-- revoke 掉對 decisions 的 UPDATE 權限（見下面 enforce_decision_append_only() 之後的
-- revoke 陳述式，那才是真正擋住使用者直接改 status／superseded_by_id 的防線），一般使用者
-- 執行 insert 觸發這個 trigger 時，如果這個函式不是 security definer，底下的 UPDATE 會直接
-- 因為權限不足失敗。search_path 明確釘死 public，避免 security definer 函式被 search_path
-- 劫持的常見風險。
create or replace function public.handle_decision_supersede()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.supersedes_id is not null then
    update public.decisions
    set status = 'superseded', superseded_by_id = new.id, updated_at = now()
    where id = new.supersedes_id and owner_id = new.owner_id and status = 'active';
  end if;
  return new;
end;
$$;

drop trigger if exists on_decision_supersede on public.decisions;
create trigger on_decision_supersede
  after insert on public.decisions
  for each row execute procedure public.handle_decision_supersede();

-- 「只追加」真正的防線是資料庫權限，不是 trigger（PR #44 第四輪 review 修正）：
-- 第三輪版本用一個交易層級的自訂 GUC（`app.decisions_supersede_update`）當「這是系統自己
-- 的合法操作」的旗標，但 reviewer 指出、也實測證實了：PostgreSQL 的 `app.*` 這種自訂參數
-- 不是任何形式的祕密或特權標記，任何一般登入角色都能在自己的交易裡直接
-- `select set_config('app.decisions_supersede_update', 'true', true)` 把它設成
-- true，接著照樣直接 UPDATE status／superseded_by_id，整套判斷形同虛設。
--
-- 真正的修法：下面這段 migration 最後會 `revoke update on public.decisions from
-- authenticated, anon, service_role`——之後任何身分想對 decisions 執行 UPDATE 陳述式，
-- 都會在陳述式本身被資料庫直接拒絕（permission denied for table decisions），連行都不會
-- 被處理到，trigger 根本沒有機會執行。這是資料庫權限系統本身的邊界，不是任何可以被
-- session/交易變數繞過的邏輯判斷。唯一還能合法改變 status／superseded_by_id 的路徑，是
-- 上面 handle_decision_supersede()——它現在是 security definer，用函式擁有者的權限執行，
-- 不受這個 revoke 影響。已經實測確認：即使 revoke 掉 UPDATE，房間刪除造成的
-- `source_room_id` 軟參照 `on delete set null` 級聯仍然正常運作（PostgreSQL 的外鍵參照
-- 動作是系統層級操作，不受呼叫端自己在該表上的權限限制，這點也已經用真實測試驗證過，
-- 不是只看官方文件推論，見測試報告）。
--
-- 下面這個 trigger 保留下來當**第二層、非權威性**的防禦（belt-and-suspenders）：如果未來
-- 有人不小心把 UPDATE 權限重新 grant 回去，這裡還能擋下大部分不知情的誤用；但它本身
-- 不是、也不該被當成安全邊界——真正的邊界是上面的 revoke。DELETE 分支的判斷條件
-- （`pg_trigger_depth() > 1` 且擁有者的 profiles 列在交易當下已經不存在）維持第三輪的
-- 設計不變，這個條件已經用真實的 raise notice 證據驗證過（見測試報告），這裡不重複。
create or replace function public.enforce_decision_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 and not exists (select 1 from public.profiles where id = old.owner_id) then
      return old;
    end if;
    raise exception '決策紀錄只能新增，不能刪除；要調整請新增一筆決策並用 supersedes_id 指向這一筆';
  end if;

  -- 第二層防禦：即使有一天 UPDATE 權限被不小心重新 grant 回一般角色，這裡也不是看
  -- 一個任何角色都能自己設定的旗標，而是要求「這個 status/superseded_by_id 的變化，
  -- 剛好對應一筆真實存在、指回這一列的取代決策」——也就是 handle_decision_supersede()
  -- 唯一會做的那種變化（active -> superseded，且 superseded_by_id 指向一筆
  -- supersedes_id = old.id、owner_id 相同的決策）。單靠一次 UPDATE 陳述式偽造不出這個
  -- 前提：要先合法新增一筆取代決策，而那筆新增本身就已經觸發 handle_decision_supersede()
  -- 把舊決策更新好了，不需要、也不能再另外手動 UPDATE 一次。
  if (old.status is distinct from new.status or old.superseded_by_id is distinct from new.superseded_by_id) then
    if not (
      old.status = 'active'
      and new.status = 'superseded'
      and new.superseded_by_id is not null
      and exists (
        select 1 from public.decisions d
        where d.id = new.superseded_by_id
          and d.supersedes_id = old.id
          and d.owner_id = old.owner_id
      )
    ) then
      raise exception '決策的狀態只能透過新增一筆帶 supersedes_id 的決策來改變，不能直接修改';
    end if;
  end if;

  if old.title is distinct from new.title
    or old.decision_text is distinct from new.decision_text
    or old.reasoning is distinct from new.reasoning
    or old.alternatives is distinct from new.alternatives
    or old.decided_at is distinct from new.decided_at
    or old.supersedes_id is distinct from new.supersedes_id
    or old.created_by is distinct from new.created_by
    or old.owner_id is distinct from new.owner_id
    or old.origin_proposal_id is distinct from new.origin_proposal_id
  then
    raise exception '決策內容不能修改；要調整請新增一筆決策並用 supersedes_id 指向這一筆';
  end if;

  return new;
end;
$$;

drop trigger if exists on_decision_append_only on public.decisions;
create trigger on_decision_append_only
  before update or delete on public.decisions
  for each row execute procedure public.enforce_decision_append_only();

-- 真正的「只追加」邊界（PR #44 第四輪 review 修正）：直接在資料庫權限層擋掉 UPDATE。
-- 上面 decisions_update_own 這條 RLS policy 因此變成不會再放行任何一般使用者的 UPDATE
-- 陳述式（因為陳述式本身就先被 revoke 擋下，RLS 根本輪不到），但仍然保留在 migration 裡，
-- 當作萬一未來這個 revoke 被誤還原時的次一層防線——它並不是現在真正生效的邊界。
-- 目前程式碼（src/、supabase/functions/）都不曾對 decisions 執行 update（已確認過），
-- 只有 insert/select，所以這個 revoke 不影響任何既有功能；唯一合法能繞過它的路徑是
-- 上面 security definer 的 handle_decision_supersede()。
revoke update on public.decisions from authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- knowledge_sources：來源索引，每則知識／決策連回聊天室訊息、記事、待辦、檔案或外部來源
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  subject_type text not null check (subject_type in ('knowledge_item', 'decision')),
  subject_id uuid not null,
  source_type text not null check (source_type in ('message', 'note', 'task', 'file', 'external_url')),
  room_id uuid references public.rooms (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  note_id uuid references public.notes (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  file_id uuid references public.files (id) on delete set null,
  external_url text,
  -- 區分「知道存在」跟「已實際取得並驗證內容」：verified=false 時 content_snapshot 通常是空的。
  verified boolean not null default false,
  content_snapshot text,
  status text not null default 'valid' check (status in ('valid', 'stale', 'invalid')),
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  checked_by uuid references public.profiles (id)
);

create index if not exists knowledge_sources_subject_idx on public.knowledge_sources (subject_type, subject_id);
create index if not exists knowledge_sources_owner_status_idx on public.knowledge_sources (owner_id, status);

alter table public.knowledge_sources enable row level security;

create policy "knowledge_sources_select_own" on public.knowledge_sources
  for select using (owner_id = auth.uid());
create policy "knowledge_sources_insert_own" on public.knowledge_sources
  for insert with check (owner_id = auth.uid());
create policy "knowledge_sources_update_own" on public.knowledge_sources
  for update using (owner_id = auth.uid());
create policy "knowledge_sources_delete_own" on public.knowledge_sources
  for delete using (owner_id = auth.uid());

-- 確認來源指向的知識/決策確實屬於同一個帳號（PR #44 第二輪 review 修正）：RLS 的
-- knowledge_sources_insert_own 只檢查「這一列的 owner_id 是不是自己」，不會檢查
-- subject_id 指到的知識/決策是不是也屬於自己——沒有這個檢查的話，任何使用者只要知道
-- （或猜到）別人一筆知識/決策的 id，就可以替它塞一筆自己捏造、甚至標成 verified=true
-- 的「來源」，讓對方的代理檢索到偽造資料。跟 validate_knowledge_link() 同一種寫法。
create or replace function public.validate_knowledge_source_subject()
returns trigger
language plpgsql
as $$
declare
  subject_owner uuid;
begin
  if new.subject_type = 'knowledge_item' then
    select owner_id into subject_owner from public.knowledge_items where id = new.subject_id;
  else
    select owner_id into subject_owner from public.decisions where id = new.subject_id;
  end if;

  if subject_owner is null then
    raise exception '找不到這則來源指向的知識或決策';
  end if;
  if subject_owner <> new.owner_id then
    raise exception '只能替自己名下的知識或決策新增來源';
  end if;

  return new;
end;
$$;

drop trigger if exists on_knowledge_source_validate_subject on public.knowledge_sources;
create trigger on_knowledge_source_validate_subject
  before insert or update on public.knowledge_sources
  for each row execute procedure public.validate_knowledge_source_subject();

-- 來源指向的訊息/記事/待辦/檔案被刪除時（on delete set null），對應欄位會從有值被沖成
-- null——用 BEFORE UPDATE trigger 偵測到這個轉變就自動把 status 改成 invalid，但
-- content_snapshot（若曾經驗證過）不清空，保留必要的來源摘要（借鏡 /link「目標無法開啟時
-- 標示存取未驗證，不編造」的精神，這裡是「來源消失了，摘要還留著，但標示失效」）。
create or replace function public.mark_knowledge_source_invalid()
returns trigger
language plpgsql
as $$
begin
  if (new.source_type = 'message' and old.message_id is not null and new.message_id is null)
    or (new.source_type = 'note' and old.note_id is not null and new.note_id is null)
    or (new.source_type = 'task' and old.task_id is not null and new.task_id is null)
    or (new.source_type = 'file' and old.file_id is not null and new.file_id is null)
  then
    new.status := 'invalid';
  end if;
  return new;
end;
$$;

drop trigger if exists on_knowledge_source_invalidate on public.knowledge_sources;
create trigger on_knowledge_source_invalidate
  before update on public.knowledge_sources
  for each row execute procedure public.mark_knowledge_source_invalid();

-- ---------------------------------------------------------------------------
-- knowledge_links：知識關聯圖（相關／支持／依賴／矛盾／取代）
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  from_type text not null check (from_type in ('knowledge_item', 'decision')),
  from_id uuid not null,
  to_type text not null check (to_type in ('knowledge_item', 'decision')),
  to_id uuid not null,
  relation text not null check (relation in ('related', 'supports', 'depends_on', 'contradicts', 'supersedes')),
  -- 使用者自己建立的關聯直接是 confirmed；代理透過 propose_knowledge 提出的一律是
  -- proposed，要先經過 accept_knowledge_proposal() 才會有 confirmed 的一列。
  status text not null default 'confirmed' check (status in ('confirmed', 'proposed')),
  reasoning text,
  created_by uuid references public.profiles (id),
  proposed_by_agent_id uuid references public.agents (id) on delete set null,
  confirmed_by uuid references public.profiles (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_links_owner_idx on public.knowledge_links (owner_id, status);
create index if not exists knowledge_links_from_idx on public.knowledge_links (from_type, from_id);
create index if not exists knowledge_links_to_idx on public.knowledge_links (to_type, to_id);

alter table public.knowledge_links enable row level security;

create policy "knowledge_links_select_own" on public.knowledge_links
  for select using (owner_id = auth.uid());
create policy "knowledge_links_insert_own" on public.knowledge_links
  for insert with check (owner_id = auth.uid());
create policy "knowledge_links_update_own" on public.knowledge_links
  for update using (owner_id = auth.uid());
create policy "knowledge_links_delete_own" on public.knowledge_links
  for delete using (owner_id = auth.uid());

-- 確認關聯兩端都真的屬於同一個使用者、且不是自我關聯，避免亂填 id 連到別人的知識
-- （即使 RLS 會擋掉查詢結果，插入當下還是要主動擋，不要留一筆連到不存在關係的髒資料）。
create or replace function public.validate_knowledge_link()
returns trigger
language plpgsql
as $$
declare
  from_owner uuid;
  to_owner uuid;
begin
  if new.from_type = new.to_type and new.from_id = new.to_id then
    raise exception '不能建立自我關聯';
  end if;

  if new.from_type = 'knowledge_item' then
    select owner_id into from_owner from public.knowledge_items where id = new.from_id;
  else
    select owner_id into from_owner from public.decisions where id = new.from_id;
  end if;

  if new.to_type = 'knowledge_item' then
    select owner_id into to_owner from public.knowledge_items where id = new.to_id;
  else
    select owner_id into to_owner from public.decisions where id = new.to_id;
  end if;

  if from_owner is null or to_owner is null then
    raise exception '找不到關聯的知識或決策項目';
  end if;
  if from_owner <> new.owner_id or to_owner <> new.owner_id then
    raise exception '只能建立自己名下的知識關聯';
  end if;

  return new;
end;
$$;

drop trigger if exists on_knowledge_link_validate on public.knowledge_links;
create trigger on_knowledge_link_validate
  before insert or update on public.knowledge_links
  for each row execute procedure public.validate_knowledge_link();

-- ---------------------------------------------------------------------------
-- knowledge_proposals：代理（或使用者自己）提出的「新知識／修正／待確認問題／決策／關聯」草稿
-- 一定要經過 accept_knowledge_proposal()／reject_knowledge_proposal() 才會變成或不會變成正式資料。
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  proposal_type text not null check (proposal_type in ('knowledge', 'decision', 'correction', 'question', 'link')),
  payload jsonb not null default '{}'::jsonb,
  reasoning text not null default '',
  source_message_id uuid references public.messages (id) on delete set null,
  source_room_id uuid references public.rooms (id) on delete set null,
  proposed_by_agent_id uuid references public.agents (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'edited', 'rejected')),
  resolved_knowledge_item_id uuid references public.knowledge_items (id) on delete set null,
  resolved_decision_id uuid references public.decisions (id) on delete set null,
  resolved_link_id uuid references public.knowledge_links (id) on delete set null,
  resolution_note text,
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_proposals_owner_status_idx on public.knowledge_proposals (owner_id, status, created_at desc);

alter table public.knowledge_proposals enable row level security;

create policy "knowledge_proposals_select_own" on public.knowledge_proposals
  for select using (owner_id = auth.uid());
create policy "knowledge_proposals_insert_own" on public.knowledge_proposals
  for insert with check (owner_id = auth.uid());
create policy "knowledge_proposals_update_own" on public.knowledge_proposals
  for update using (owner_id = auth.uid());
create policy "knowledge_proposals_delete_own" on public.knowledge_proposals
  for delete using (owner_id = auth.uid());

-- 正式知識／決策／關聯回指「自己是哪個提案被接受後產生的」，可追溯（借鏡 /grill-me
-- 「已確認事實加入對應頁面，並連回訪談」）。knowledge_proposals 這張表要先存在才能被參照，
-- 所以這三個欄位用 alter table 補在後面。
alter table public.knowledge_items add column if not exists origin_proposal_id uuid references public.knowledge_proposals (id) on delete set null;
alter table public.decisions add column if not exists origin_proposal_id uuid references public.knowledge_proposals (id) on delete set null;
alter table public.knowledge_links add column if not exists origin_proposal_id uuid references public.knowledge_proposals (id) on delete set null;

-- ---------------------------------------------------------------------------
-- knowledge_revisions：knowledge_items／decisions 每次被修改前的快照，修正歷程可追溯
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_revisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  subject_type text not null check (subject_type in ('knowledge_item', 'decision')),
  subject_id uuid not null,
  revision_no int not null,
  title text,
  body text,
  changed_by uuid references public.profiles (id),
  change_reason text,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_revisions_subject_idx on public.knowledge_revisions (subject_type, subject_id, revision_no desc);

alter table public.knowledge_revisions enable row level security;

create policy "knowledge_revisions_select_own" on public.knowledge_revisions
  for select using (owner_id = auth.uid());
create policy "knowledge_revisions_insert_own" on public.knowledge_revisions
  for insert with check (owner_id = auth.uid());

create or replace function public.record_knowledge_revision()
returns trigger
language plpgsql
as $$
declare
  next_no int;
  subject text;
  old_title text;
  old_body text;
begin
  subject := case tg_table_name when 'knowledge_items' then 'knowledge_item' else 'decision' end;
  old_title := old.title;
  old_body := case tg_table_name when 'knowledge_items' then old.body else old.decision_text end;

  select coalesce(max(revision_no), 0) + 1 into next_no
  from public.knowledge_revisions
  where subject_type = subject and subject_id = old.id;

  insert into public.knowledge_revisions (owner_id, subject_type, subject_id, revision_no, title, body, changed_by)
  values (old.owner_id, subject, old.id, next_no, old_title, old_body, auth.uid());

  return new;
end;
$$;

drop trigger if exists on_knowledge_item_revision on public.knowledge_items;
create trigger on_knowledge_item_revision
  before update on public.knowledge_items
  for each row
  when (old.title is distinct from new.title or old.body is distinct from new.body)
  execute procedure public.record_knowledge_revision();

drop trigger if exists on_decision_revision on public.decisions;
create trigger on_decision_revision
  before update on public.decisions
  for each row
  when (old.title is distinct from new.title or old.decision_text is distinct from new.decision_text)
  execute procedure public.record_knowledge_revision();

-- ---------------------------------------------------------------------------
-- knowledge_audit_reports：/audit 借鏡——手動或排程觸發的稽核報告，帶證據、不看數量
-- ---------------------------------------------------------------------------
create table if not exists public.knowledge_audit_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  run_at timestamptz not null default now(),
  triggered_by text not null default 'manual' check (triggered_by in ('manual', 'schedule')),
  summary text not null default '',
  findings jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_audit_reports_owner_idx on public.knowledge_audit_reports (owner_id, run_at desc);

alter table public.knowledge_audit_reports enable row level security;

create policy "knowledge_audit_reports_select_own" on public.knowledge_audit_reports
  for select using (owner_id = auth.uid());
create policy "knowledge_audit_reports_insert_own" on public.knowledge_audit_reports
  for insert with check (owner_id = auth.uid());
create policy "knowledge_audit_reports_delete_own" on public.knowledge_audit_reports
  for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 來源訊息安全寫入：accept_knowledge_proposal() 的 'knowledge'／'decision' 分支共用。
-- PR #44 第二輪 review 修正：第一版仍然會把呼叫端傳進來的 p_source_excerpt／
-- p_source_room_id 當內容存起來——但 accept_knowledge_proposal() 是把
-- `proposal.payload || edits` 之後的值傳進來，edits 是呼叫這個 RPC 的使用者自己可以
-- 任意指定的參數，等於使用者可以自己捏造一段文字、蓋掉提案原本的內容，讓系統標成
-- verified=true。這裡改成完全不信任任何呼叫端傳進來的內容／房間 id，只留
-- p_source_message_id 當「查哪一則訊息」的依據，摘要（content_snapshot）跟房間
-- （room_id）都直接從資料庫當下讀到的 messages／rooms 這兩張表取值，同時確認這則訊息
-- 所在房間的 owner_id 等於這個提案本身的 owner_id（防止 source_message_id 被改成別人
-- 帳號的訊息 id）。訊息已經不存在（例如來源聊天室在提案還沒確認前就被刪除）或不屬於
-- 這個帳號，就完全不附來源，不留一筆驗證不了、甚至可能外洩別人訊息內容的資料。
-- ---------------------------------------------------------------------------
create or replace function public.insert_message_source_if_owned(
  p_owner_id uuid,
  p_subject_type text,
  p_subject_id uuid,
  p_source_message_id uuid
)
returns void
language plpgsql
as $$
declare
  msg record;
  excerpt text;
  is_verified boolean;
begin
  if p_source_message_id is null then
    return;
  end if;

  select m.content as content, m.room_id as room_id, r.owner_id as room_owner_id
    into msg
  from public.messages m
  join public.rooms r on r.id = m.room_id
  where m.id = p_source_message_id;

  if not found or msg.room_owner_id <> p_owner_id then
    return;
  end if;

  excerpt := nullif(left(coalesce(msg.content, ''), 500), '');
  is_verified := excerpt is not null;

  insert into public.knowledge_sources (
    owner_id, subject_type, subject_id, source_type, room_id, message_id, verified, content_snapshot, status
  ) values (
    p_owner_id, p_subject_type, p_subject_id, 'message', msg.room_id, p_source_message_id,
    is_verified, case when is_verified then excerpt else null end, 'valid'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC：accept_knowledge_proposal / reject_knowledge_proposal
-- 用 security invoker（預設）刻意執行，讓底下每一步 insert/update 都照樣經過 RLS，
-- 不需要額外的權限檢查邏輯——proposal 本來就已經被 owner_id=auth.uid() 的 RLS 限制在
-- 自己名下，這裡再加一層明確檢查只是防禦性寫法。
-- ---------------------------------------------------------------------------
create or replace function public.accept_knowledge_proposal(proposal_id uuid, edits jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
as $$
declare
  proposal record;
  merged jsonb;
  new_id uuid;
  result jsonb;
begin
  select * into proposal from public.knowledge_proposals where id = proposal_id;
  if proposal is null then
    raise exception '找不到這個提案';
  end if;
  if proposal.owner_id <> auth.uid() then
    raise exception '不能確認不屬於自己的提案';
  end if;
  if proposal.status <> 'pending' then
    raise exception '這個提案已經處理過了';
  end if;

  merged := proposal.payload || coalesce(edits, '{}'::jsonb);

  if proposal.proposal_type = 'knowledge' then
    insert into public.knowledge_items (
      owner_id, category, title, body, expires_at, review_interval_days,
      source_room_id, confirmed_by, origin_proposal_id
    ) values (
      proposal.owner_id,
      coalesce(merged ->> 'category', 'other'),
      merged ->> 'title',
      coalesce(merged ->> 'body', ''),
      nullif(merged ->> 'expires_at', '')::timestamptz,
      nullif(merged ->> 'review_interval_days', '')::int,
      proposal.source_room_id,
      auth.uid(),
      proposal.id
    )
    returning id into new_id;

    perform public.insert_message_source_if_owned(proposal.owner_id, 'knowledge_item', new_id, proposal.source_message_id);

    update public.knowledge_proposals
      set status = 'accepted', resolved_knowledge_item_id = new_id, resolved_by = auth.uid(), resolved_at = now()
      where id = proposal.id;

    result := jsonb_build_object('table', 'knowledge_items', 'id', new_id);

  elsif proposal.proposal_type = 'decision' then
    insert into public.decisions (
      owner_id, title, decision_text, reasoning, alternatives, supersedes_id,
      source_room_id, created_by, origin_proposal_id
    ) values (
      proposal.owner_id,
      merged ->> 'title',
      merged ->> 'decision_text',
      coalesce(merged ->> 'reasoning', proposal.reasoning, ''),
      merged ->> 'alternatives',
      nullif(merged ->> 'supersedes_decision_id', '')::uuid,
      proposal.source_room_id,
      auth.uid(),
      proposal.id
    )
    returning id into new_id;

    perform public.insert_message_source_if_owned(proposal.owner_id, 'decision', new_id, proposal.source_message_id);

    update public.knowledge_proposals
      set status = 'accepted', resolved_decision_id = new_id, resolved_by = auth.uid(), resolved_at = now()
      where id = proposal.id;

    result := jsonb_build_object('table', 'decisions', 'id', new_id);

  elsif proposal.proposal_type = 'link' then
    insert into public.knowledge_links (
      owner_id, from_type, from_id, to_type, to_id, relation, status, reasoning,
      proposed_by_agent_id, confirmed_by, confirmed_at, origin_proposal_id
    ) values (
      proposal.owner_id,
      merged ->> 'from_type', (merged ->> 'from_id')::uuid,
      merged ->> 'to_type', (merged ->> 'to_id')::uuid,
      coalesce(merged ->> 'relation', 'related'),
      'confirmed',
      coalesce(merged ->> 'reasoning', proposal.reasoning),
      proposal.proposed_by_agent_id, auth.uid(), now(), proposal.id
    )
    returning id into new_id;

    update public.knowledge_proposals
      set status = 'accepted', resolved_link_id = new_id, resolved_by = auth.uid(), resolved_at = now()
      where id = proposal.id;

    result := jsonb_build_object('table', 'knowledge_links', 'id', new_id);

  elsif proposal.proposal_type = 'correction' then
    -- 修正既有知識／決策的內容；edits 至少要帶 title 或 body/decision_text 其中之一。
    if merged ->> 'target_type' = 'knowledge_item' then
      update public.knowledge_items
        set title = coalesce(merged ->> 'title', title),
            body = coalesce(merged ->> 'body', body),
            updated_at = now()
        where id = (merged ->> 'target_id')::uuid and owner_id = auth.uid();
      new_id := (merged ->> 'target_id')::uuid;
      update public.knowledge_proposals
        set status = 'accepted', resolved_knowledge_item_id = new_id, resolved_by = auth.uid(), resolved_at = now()
        where id = proposal.id;
      result := jsonb_build_object('table', 'knowledge_items', 'id', new_id);
    else
      update public.decisions
        set title = coalesce(merged ->> 'title', title),
            decision_text = coalesce(merged ->> 'body', decision_text),
            updated_at = now()
        where id = (merged ->> 'target_id')::uuid and owner_id = auth.uid();
      new_id := (merged ->> 'target_id')::uuid;
      update public.knowledge_proposals
        set status = 'accepted', resolved_decision_id = new_id, resolved_by = auth.uid(), resolved_at = now()
        where id = proposal.id;
      result := jsonb_build_object('table', 'decisions', 'id', new_id);
    end if;

  else
    -- question：沒有對應的正式資料表要 insert，只記錄使用者的回答／處置。
    update public.knowledge_proposals
      set status = 'accepted', resolution_note = merged ->> 'answer', resolved_by = auth.uid(), resolved_at = now()
      where id = proposal.id;
    result := jsonb_build_object('table', 'knowledge_proposals', 'id', proposal.id);
  end if;

  return result;
end;
$$;

create or replace function public.reject_knowledge_proposal(proposal_id uuid, note text default null)
returns void
language plpgsql
as $$
begin
  update public.knowledge_proposals
    set status = 'rejected', resolution_note = note, resolved_by = auth.uid(), resolved_at = now()
    where id = proposal_id and owner_id = auth.uid() and status = 'pending';

  if not found then
    raise exception '找不到這個待確認的提案，或不屬於自己';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime：讓「確認提案」「知識關聯圖」在多個分頁/聊天室之間即時同步，不用手動重整
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.knowledge_items;
alter publication supabase_realtime add table public.decisions;
alter publication supabase_realtime add table public.knowledge_links;
alter publication supabase_realtime add table public.knowledge_proposals;
