#!/usr/bin/env bash
# 驗證 README 對 0020/0021（跨聊天室共享知識系統）migration 的說明：這兩個 migration
# 曾經被列為「選用附加設定」，但 agent-run/index.ts 跟 worker-task-start/index.ts 都是
# 「只要 rooms.owner_id 存在（幾乎每個房間都有）就無條件呼叫 buildKnowledgeContext()」，
# 沒有任何 if/try-catch 判斷 0020/0021 有沒有套用——一旦跳過這兩個 migration，這兩個
# Edge Function 在真實使用情境下的每一次呼叫都會直接因為資料表不存在而整個失敗，不是
# 「少一個附加功能」而已。
#
# 這支腳本只驗證 SQL 層（不需要真的執行 Edge Function TypeScript），直接對 Postgres
# 執行 supabase/functions/_shared/knowledgeContext.ts 的 fetchRelevantKnowledgeItems()／
# fetchRelevantDecisions() 在完全沒有關鍵字時使用的「fallback」查詢（select ... where
# owner_id = ? and status = 'active' order by ... desc limit ?，見該檔案 161-165、
# 202-205 行），比對套用 0020/0021 前後的行為：
#   - 前：套用到 0019 為止，執行這個查詢應該直接失敗（relation does not exist）
#   - 後：套用 0020／0021，同一個查詢應該成功執行（回傳 0 筆，沒有任何錯誤）
#
# 用法：./scripts/integration-abc-knowledge-required-test.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-integration_abc_knowledge}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGPASSWORD
PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -v ON_ERROR_STOP=1 -q"
PSQL_MAINT="psql -h $PGHOST -p $PGPORT -U $PGUSER -d postgres -v ON_ERROR_STOP=1 -q"
# 故意不加 ON_ERROR_STOP：這裡就是要確認查詢「會失敗」，失敗是預期行為的一部分。
PSQL_NOSTOP="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -q"

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

echo "=== 建立測試資料庫 $PGDATABASE ==="
$PSQL_MAINT -c "drop database if exists $PGDATABASE;"
$PSQL_MAINT -c "create database $PGDATABASE owner $PGUSER;"

echo "=== 建立 authenticated/anon/service_role（若不存在）==="
$PSQL_MAINT -c "select 1 from pg_roles where rolname='authenticated'" | grep -q 1 || \
  $PSQL_MAINT -c "create role authenticated login nosuperuser nobypassrls password 'ci_test';"
$PSQL_MAINT -c "select 1 from pg_roles where rolname='anon'" | grep -q 1 || \
  $PSQL_MAINT -c "create role anon nosuperuser nobypassrls;"
$PSQL_MAINT -c "select 1 from pg_roles where rolname='service_role'" | grep -q 1 || \
  $PSQL_MAINT -c "create role service_role nosuperuser bypassrls;"

echo "=== auth/storage/vault 平台 schema 最小樁 + 角色權限 ==="
$PSQL <<'SQL'
create extension if not exists pgcrypto;

create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$f$;

create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text, owner uuid, created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$
  select string_to_array(name, '/');
$f$;

create schema if not exists vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null, name text, description text, created_at timestamptz not null default now());
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name, description, created_at from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text default null, p_description text default null) returns uuid language sql as $f$
  insert into vault.secrets (secret, name, description) values (p_secret, p_name, p_description) returning id;
$f$;
create or replace function vault.update_secret(p_id uuid, p_secret text) returns void language sql as $f$
  update vault.secrets set secret = p_secret where id = p_id;
$f$;

create publication supabase_realtime;

grant usage on schema public, auth, storage, vault to authenticated, anon, service_role;
grant select, insert, update, delete on auth.users to authenticated, anon, service_role;
grant select, insert, update, delete on storage.buckets, storage.objects to authenticated, anon, service_role;
grant select, insert, update, delete on vault.secrets to authenticated, anon, service_role;
alter default privileges for role current_user in schema public grant all on tables to authenticated, anon, service_role;
alter default privileges for role current_user in schema public grant all on sequences to authenticated, anon, service_role;
alter default privileges for role current_user in schema public grant execute on functions to authenticated, anon, service_role;
SQL

echo "=== 套用 0001~0019（刻意先跳過 0020/0021，模擬照舊版 README 建議『選用附加設定就不套用』的部署）==="
for f in "$REPO_ROOT"/supabase/migrations/00{01..19}_*.sql; do
  base="$(basename "$f")"
  if [ "$base" = "0006_enable_realtime.sql" ]; then
    grep -v "alter publication supabase_realtime add table" "$f" | $PSQL
  elif [ "$base" = "0009_byok_api_keys.sql" ]; then
    grep -v "create extension if not exists supabase_vault cascade;" "$f" | $PSQL
  else
    $PSQL -f "$f"
  fi
done > /dev/null

echo "=== 建立測試帳號、房間 ==="
UID_A="00000000-0000-0000-0000-00000000000a"
$PSQL -c "insert into auth.users (id, email) values ('$UID_A','ga@ci.local');"
$PSQL -c "insert into profiles (id, display_name) values ('$UID_A','GA') on conflict (id) do nothing;"
ROOM_A="10000000-0000-0000-0000-00000000000a"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_A','$UID_A','G room', true);"

# 跟 supabase/functions/_shared/knowledgeContext.ts 的 fetchRelevantKnowledgeItems()／
# fetchRelevantDecisions() 在沒有關鍵字可比對時使用的 fallback 查詢完全一致的 SQL 形狀
# （161-165、202-205 行）：agent-run/worker-task-start 每一次無關鍵字比對（例如訊息很短、
# 全是停用詞）就會落到這個分支，是最常被踩到的路徑。
KNOWLEDGE_ITEMS_QUERY="select id, title, body, category, updated_at, expires_at from knowledge_items where owner_id = '$UID_A' and status = 'active' order by updated_at desc limit 30;"
DECISIONS_QUERY="select id, title, decision_text, decided_at, updated_at, supersedes_id from decisions where owner_id = '$UID_A' and status = 'active' order by decided_at desc limit 30;"

echo ""
echo "=== [README 0020/0021 修正] 套用到 0019 為止時，agent-run/worker-task-start 無條件會執行的知識查詢應該直接失敗 ==="
OUT_ITEMS_BEFORE=$($PSQL_NOSTOP -c "$KNOWLEDGE_ITEMS_QUERY" 2>&1) && ITEMS_BEFORE_FAILED=0 || ITEMS_BEFORE_FAILED=1
echo "  knowledge_items 查詢結果：$OUT_ITEMS_BEFORE"
if [ "$ITEMS_BEFORE_FAILED" = "1" ] && echo "$OUT_ITEMS_BEFORE" | grep -qi "relation .*knowledge_items.* does not exist"; then
  pass "跳過 0020 時，buildKnowledgeContext() 一定會執行到的 knowledge_items 查詢直接失敗（relation does not exist），證實不是選用功能"
else
  fail "預期查詢應該因為資料表不存在而失敗，實際結果：$OUT_ITEMS_BEFORE"
fi

OUT_DECISIONS_BEFORE=$($PSQL_NOSTOP -c "$DECISIONS_QUERY" 2>&1) && DECISIONS_BEFORE_FAILED=0 || DECISIONS_BEFORE_FAILED=1
if [ "$DECISIONS_BEFORE_FAILED" = "1" ] && echo "$OUT_DECISIONS_BEFORE" | grep -qi "relation .*decisions.* does not exist"; then
  pass "跳過 0020 時，decisions 查詢同樣直接失敗（relation does not exist）"
else
  fail "預期 decisions 查詢應該失敗，實際結果：$OUT_DECISIONS_BEFORE"
fi

echo ""
echo "=== 補套用 0020／0021 ==="
for base in 0020_shared_knowledge.sql 0021_knowledge_retrieval_indexes.sql; do
  $PSQL -f "$REPO_ROOT/supabase/migrations/$base"
done > /dev/null

echo ""
echo "=== [README 0020/0021 修正] 套用 0020／0021 之後，同一組查詢應該成功執行 ==="
OUT_ITEMS_AFTER=$($PSQL_NOSTOP -tAc "$KNOWLEDGE_ITEMS_QUERY" 2>&1) && ITEMS_AFTER_OK=1 || ITEMS_AFTER_OK=0
[ "$ITEMS_AFTER_OK" = "1" ] && pass "套用 0020／0021 後，knowledge_items 查詢成功執行（$( [ -z "$OUT_ITEMS_AFTER" ] && echo "0 筆" || echo "回傳資料")）" || fail "套用之後查詢仍然失敗：$OUT_ITEMS_AFTER"

OUT_DECISIONS_AFTER=$($PSQL_NOSTOP -tAc "$DECISIONS_QUERY" 2>&1) && DECISIONS_AFTER_OK=1 || DECISIONS_AFTER_OK=0
[ "$DECISIONS_AFTER_OK" = "1" ] && pass "套用 0020／0021 後，decisions 查詢成功執行" || fail "套用之後 decisions 查詢仍然失敗：$OUT_DECISIONS_AFTER"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
