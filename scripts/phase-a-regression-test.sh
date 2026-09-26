#!/usr/bin/env bash
# Phase A（17 項修正計劃之 A．權限隔離）回歸測試：項目 1、2、3、8。
# 對照 docs/Phase-A-跨帳號權限修正-測試報告.md 的手動實測，這裡是可重跑、可放進 CI 的版本。
#
# 需要：postgres（PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE，預設對應 GitHub Actions 的
# postgres service container）、postgrest 與 deno 的 standalone 執行檔（不需要 Docker，
# 兩者都是單一靜態執行檔，CI 直接下載）。
#
# 用法：POSTGREST_BIN=/path/to/postgrest DENO_BIN=/path/to/deno ./scripts/phase-a-regression-test.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-phase_a_ci}"
POSTGREST_BIN="${POSTGREST_BIN:?請設定 POSTGREST_BIN 指向 postgrest 執行檔}"
DENO_BIN="${DENO_BIN:?請設定 DENO_BIN 指向 deno 執行檔}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGPASSWORD
PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -v ON_ERROR_STOP=1 -q"
PSQL_MAINT="psql -h $PGHOST -p $PGPORT -U $PGUSER -d postgres -v ON_ERROR_STOP=1 -q"

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

echo "=== 套用 main 既有 migration（0001-0018，逐字不改） ==="
for f in "$REPO_ROOT"/supabase/migrations/00{01..18}_*.sql; do
  base="$(basename "$f")"
  if [ "$base" = "0006_enable_realtime.sql" ]; then
    # 0001 已經把 messages/agent_runs 加進 publication，0006 重複加會噴 error——
    # 這是 repo 既有 migration 序列本身的小瑕疵（不在 Phase A 範圍內），
    # 這裡只在測試腳本套用時跳過那兩行，不修改實際的 migration 檔案。
    grep -v "alter publication supabase_realtime add table" "$f" | $PSQL
  elif [ "$base" = "0009_byok_api_keys.sql" ]; then
    grep -v "create extension if not exists supabase_vault cascade;" "$f" | $PSQL
  else
    $PSQL -f "$f"
  fi
done

echo "=== 套用本次 Phase A 修正 migration ==="
$PSQL -f "$REPO_ROOT/supabase/migrations/0019_cross_account_security_fixes.sql"

echo "=== 建立測試帳號 ==="
UID_A="00000000-0000-0000-0000-0000000000a1"
UID_B="00000000-0000-0000-0000-0000000000b1"
$PSQL -c "insert into auth.users (id, email) values ('$UID_A','a@ci.local'), ('$UID_B','b@ci.local');"

echo "=== 啟動 postgrest ==="
JWT_SECRET="phase-a-ci-test-secret-not-for-production"
CONF="$(mktemp)"
cat > "$CONF" <<EOF
db-uri = "postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3111
EOF
"$POSTGREST_BIN" "$CONF" > /tmp/phase_a_ci_postgrest.log 2>&1 &
POSTGREST_PID=$!
sleep 2

sign_jwt() {
  node -e "
    const crypto=require('crypto');
    const secret='$JWT_SECRET';
    const b64=s=>Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'}));
    const payload={role:process.argv[1],exp:Math.floor(Date.now()/1000)+3600};
    if(process.argv[2]) payload.sub=process.argv[2];
    const p=b64(JSON.stringify(payload));
    const sig=crypto.createHmac('sha256',secret).update(h+'.'+p).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    console.log(h+'.'+p+'.'+sig);
  " "$1" "${2:-}"
}
JWT_A=$(sign_jwt authenticated "$UID_A")
JWT_B=$(sign_jwt authenticated "$UID_B")
JWT_SERVICE=$(sign_jwt service_role)
JWT_ANON=$(sign_jwt anon)

echo "=== 啟動本機閘道（/rest/v1 -> postgrest, /auth/v1/user -> JWT 解碼）==="
GATEWAY_TS="$(mktemp --suffix=.ts)"
cat > "$GATEWAY_TS" <<'DENO'
const POSTGREST = "http://localhost:3111";
function decodeJwt(auth) {
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}
Deno.serve({ port: 3112 }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/auth/v1/user") {
    const claims = decodeJwt(req.headers.get("authorization"));
    if (!claims || !claims.sub) return new Response(JSON.stringify({ error: "invalid token" }), { status: 401 });
    return new Response(JSON.stringify({ id: claims.sub, email: null, aud: "authenticated", role: claims.role }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname.startsWith("/rest/v1")) {
    const target = POSTGREST + url.pathname.replace(/^\/rest\/v1/, "") + url.search;
    const resp = await fetch(target, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text() });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
  return new Response("not found", { status: 404 });
});
DENO
"$DENO_BIN" run --allow-net --allow-env "$GATEWAY_TS" > /tmp/phase_a_ci_gateway.log 2>&1 &
GATEWAY_PID=$!
sleep 2

cleanup() {
  kill "$POSTGREST_PID" "$GATEWAY_PID" "${APPROVAL_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "=== 項目 1：room_members 自行入會應該被拒 ==="
ROOM_B=$(curl -s -X POST "http://localhost:3111/rooms" -H "Authorization: Bearer $JWT_B" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"name":"B room"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3111/room_members" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"room_id\":\"$ROOM_B\",\"user_id\":\"$UID_A\",\"role\":\"member\"}")
[ "$CODE" = "403" ] && pass "A 自行加入 B 的房間被拒（HTTP 403）" || fail "A 自行加入 B 的房間應該回 403，實際是 $CODE"
COUNT=$($PSQL -tAc "select count(*) from room_members where room_id='$ROOM_B' and user_id='$UID_A';")
[ "$COUNT" = "0" ] && pass "room_members 沒有新增這一列" || fail "room_members 竟然有 $COUNT 筆（應該是 0）"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3111/rooms" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d '{"name":"legit room"}')
[ "$CODE" = "201" ] && pass "A 建立自己的房間仍然成功（handle_new_room 沒被破壞）" || fail "A 建立房間應該成功，實際是 $CODE"

echo ""
echo "=== 項目 3：跨房間點名應該被拒 ==="
ROOM_A=$(curl -s -X POST "http://localhost:3111/rooms" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d '{"name":"A room2"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
MSG_A=$(curl -s -X POST "http://localhost:3111/messages" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"sender_type\":\"user\",\"sender_user_id\":\"$UID_A\",\"content\":\"hi\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
AGENT_B=$($PSQL -tAc "select id from agents where room_id='$ROOM_B' limit 1;")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3111/message_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"message_id\":\"$MSG_A\",\"agent_id\":\"$AGENT_B\"}")
[ "$CODE" = "403" ] && pass "A 點名 B 房間代理被拒（HTTP 403）" || fail "跨房間點名應該回 403，實際是 $CODE"

AGENT_A=$($PSQL -tAc "select id from agents where room_id='$ROOM_A' limit 1;")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3111/message_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"message_id\":\"$MSG_A\",\"agent_id\":\"$AGENT_A\"}")
[ "$CODE" = "201" ] && pass "A 點名自己房間的代理仍然成功" || fail "同房間點名應該成功，實際是 $CODE"

echo ""
echo "=== 啟動 approval-decide（真實 Deno 執行）==="
(
  cd "$REPO_ROOT/supabase/functions/approval-decide"
  SUPABASE_URL=http://localhost:3112 SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" SUPABASE_ANON_KEY="$JWT_ANON" ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env --allow-read index.ts > /tmp/phase_a_ci_approval.log 2>&1 &
  echo $! > /tmp/phase_a_ci_approval.pid
)
sleep 4
APPROVAL_PID=$(cat /tmp/phase_a_ci_approval.pid)

echo ""
echo "=== 項目 2：approval-decide 的 file.delete 不能刪別人的檔案 ==="
FILE_B="f0000000-0000-0000-0000-000000000001"
$PSQL -c "insert into files (id, room_id, bucket, object_path, name, mime_type, size_bytes, owner_id, created_by, status) values ('$FILE_B','$ROOM_B','room-files','p/x','b.txt','text/plain',1,'$UID_B','$UID_B','active');"
APPROVAL_ID=$(curl -s -X POST "http://localhost:3111/approval_requests" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"requested_by\":\"$UID_A\",\"tool_name\":\"file.delete\",\"arguments_json\":{\"fileId\":\"$FILE_B\"},\"risk_level\":\"high\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APPROVAL_ID\",\"decision\":\"approved\"}")
[ "$CODE" = "500" ] && pass "A 核准指向 B 檔案的請求失敗（HTTP 500 execution_failed）" || fail "應該執行失敗，實際是 $CODE"
STATUS=$($PSQL -tAc "select status from files where id='$FILE_B';")
[ "$STATUS" = "active" ] && pass "B 的檔案仍然是 active" || fail "B 的檔案狀態變成了 $STATUS（不應該被刪）"

FILE_A="f0000000-0000-0000-0000-00000000000a"
$PSQL -c "insert into files (id, room_id, bucket, object_path, name, mime_type, size_bytes, owner_id, created_by, status) values ('$FILE_A','$ROOM_A','room-files','p/y','a.txt','text/plain',1,'$UID_A','$UID_A','active');"
APPROVAL_ID2=$(curl -s -X POST "http://localhost:3111/approval_requests" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"requested_by\":\"$UID_A\",\"tool_name\":\"file.delete\",\"arguments_json\":{\"fileId\":\"$FILE_A\"},\"risk_level\":\"high\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APPROVAL_ID2\",\"decision\":\"approved\"}")
[ "$CODE" = "200" ] && pass "A 核准刪除自己的檔案成功" || fail "刪自己的檔案應該成功，實際是 $CODE"

echo ""
echo "=== 項目 8：核准原子化與過期 ==="
FILE_C="f0000000-0000-0000-0000-00000000000c"
$PSQL -c "insert into files (id, room_id, bucket, object_path, name, mime_type, size_bytes, owner_id, created_by, status) values ('$FILE_C','$ROOM_A','room-files','p/z','c.txt','text/plain',1,'$UID_A','$UID_A','active');"
APPROVAL_ID3=$(curl -s -X POST "http://localhost:3111/approval_requests" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"requested_by\":\"$UID_A\",\"tool_name\":\"file.delete\",\"arguments_json\":{\"fileId\":\"$FILE_C\",\"tag\":\"race\"},\"risk_level\":\"high\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
curl -s -o /tmp/r1.json -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APPROVAL_ID3\",\"decision\":\"approved\"}" > /tmp/r1.code &
P1=$!
curl -s -o /tmp/r2.json -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APPROVAL_ID3\",\"decision\":\"approved\"}" > /tmp/r2.code &
P2=$!
wait $P1 $P2
CODES="$(cat /tmp/r1.code) $(cat /tmp/r2.code)"
if echo "$CODES" | grep -q "200" && echo "$CODES" | grep -q "409"; then
  pass "兩個同時核准：一個 200 一個 409（$CODES）"
else
  fail "兩個同時核准的結果不是預期的 200+409：$CODES"
fi
EXEC_COUNT=$($PSQL -tAc "select count(*) from audit_logs where metadata->>'tag'='race' and action='file.delete.executed';")
[ "$EXEC_COUNT" = "1" ] && pass "audit_logs 只有 1 筆 executed（實際執行 1 次）" || fail "audit_logs 有 $EXEC_COUNT 筆 executed（應該是 1）"

FILE_D="f0000000-0000-0000-0000-00000000000d"
$PSQL -c "insert into files (id, room_id, bucket, object_path, name, mime_type, size_bytes, owner_id, created_by, status) values ('$FILE_D','$ROOM_A','room-files','p/w','d.txt','text/plain',1,'$UID_A','$UID_A','active');"
APPROVAL_ID4=$(curl -s -X POST "http://localhost:3111/approval_requests" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"requested_by\":\"$UID_A\",\"tool_name\":\"file.delete\",\"arguments_json\":{\"fileId\":\"$FILE_D\"},\"risk_level\":\"high\",\"expires_at\":\"2020-01-01T00:00:00Z\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APPROVAL_ID4\",\"decision\":\"approved\"}")
[ "$CODE" = "410" ] && pass "已過期的核准請求回 410" || fail "過期核准應該回 410，實際是 $CODE"
STATUS=$($PSQL -tAc "select status from files where id='$FILE_D';")
[ "$STATUS" = "active" ] && pass "過期請求執行 0 次，檔案仍是 active" || fail "過期請求不應該執行，但檔案狀態是 $STATUS"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
