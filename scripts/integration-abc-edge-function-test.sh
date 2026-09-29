#!/usr/bin/env bash
# 17 項修正計劃 A/B/C 三個 PR 整合回歸測試：需要真的執行 Edge Function TypeScript
# 程式碼（不是重寫的等價邏輯）的部分，沿用 Phase A／Phase C 已驗證過的
# 「standalone PostgREST + 真實 JWT auth.uid() + Deno 直接執行未修改的 Edge Function
# 原始檔」本機測試基礎設施。
#
# 涵蓋：
#   - 項目 2：approval-decide 的 file.delete owner 驗證（真的執行 approval-decide/index.ts）
#   - 項目 7：chat-dispatch 派送冪等、逾時重試、以及「執行途中中斷而遺留的 queued 紀錄」
#     是否有逾時修復機制（這是三個 PR 整合測試才特別要求驗證的問題，Phase C 報告原本
#     只測了 fetch 回傳失敗/逾時會被標成 failed，沒有測「chat-dispatch 那次呼叫本身
#     完全沒有機會執行到 dispatchAgentRuns() 就中斷」這個更早的中斷點）
#
# 用法：POSTGREST_BIN=/path/to/postgrest DENO_BIN=/path/to/deno ./scripts/integration-abc-edge-function-test.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-integration_abc_edge}"
POSTGREST_BIN="${POSTGREST_BIN:?請設定 POSTGREST_BIN 指向 postgrest 執行檔}"
DENO_BIN="${DENO_BIN:-/tmp/deno_bin/deno}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="$(mktemp -d)"

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
create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
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

echo "=== 依整合後的最終順序套用全部 migration（0001~0027） ==="
for f in "$REPO_ROOT"/supabase/migrations/00{01..27}_*.sql; do
  base="$(basename "$f")"
  if [ "$base" = "0006_enable_realtime.sql" ]; then
    grep -v "alter publication supabase_realtime add table" "$f" | $PSQL
  elif [ "$base" = "0009_byok_api_keys.sql" ]; then
    grep -v "create extension if not exists supabase_vault cascade;" "$f" | $PSQL
  else
    $PSQL -f "$f"
  fi
done > /dev/null

echo "=== 建立測試帳號、房間、代理、檔案 ==="
UID_A="00000000-0000-0000-0000-0000000000f1"
UID_B="00000000-0000-0000-0000-0000000000f2"
$PSQL -c "insert into auth.users (id, email) values ('$UID_A','fa@ci.local'), ('$UID_B','fb@ci.local');"
$PSQL -c "insert into profiles (id, display_name) values ('$UID_A','FA'), ('$UID_B','FB') on conflict (id) do nothing;"
ROOM_A="10000000-0000-0000-0000-0000000000f1"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_A','$UID_A','F room', true);"
AGENT_A=$($PSQL -tAc "select id from agents where room_id='$ROOM_A' and provider='anthropic' limit 1;")
$PSQL -c "select set_user_provider_key('$UID_A','anthropic','fake-test-key-not-real');"
$PSQL -c "select set_user_provider_key('$UID_A','openai','fake-test-key-not-real');"

FILE_B="20000000-0000-0000-0000-0000000000f1"
$PSQL -c "insert into files (id, room_id, owner_id, bucket, object_path, name, mime_type, size_bytes, status, created_by) values ('$FILE_B','$ROOM_A','$UID_B','room-files','b/secret.txt','secret.txt','text/plain',10,'active','$UID_B');"

echo "=== 啟動 postgrest ==="
JWT_SECRET="integration-abc-edge-test-secret-not-for-production"
CONF="$(mktemp)"
cat > "$CONF" <<EOF
db-uri = "postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3411
EOF
"$POSTGREST_BIN" "$CONF" > "$WORKDIR/postgrest.log" 2>&1 &
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
JWT_SERVICE=$(sign_jwt service_role)
JWT_ANON=$(sign_jwt anon)

echo "=== 啟動本機閘道（/rest/v1 -> postgrest, /auth/v1/user -> JWT 解碼, /functions/v1/agent-run -> 假端點）==="
mkdir -p "$WORKDIR/gw"
echo "ok" > "$WORKDIR/gw/agent_run_mode.txt"
GATEWAY_TS="$WORKDIR/gw/gateway.ts"
cat > "$GATEWAY_TS" <<DENO
const POSTGREST = "http://localhost:3411";
const MODE_FILE = "$WORKDIR/gw/agent_run_mode.txt";

function decodeJwt(auth) {
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

Deno.serve({ port: 3412 }, async (req) => {
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

  if (url.pathname === "/functions/v1/agent-run") {
    const body = await req.text();
    const mode = (await Deno.readTextFile(MODE_FILE)).trim();
    await Deno.writeTextFile("$WORKDIR/gw/call_log.txt", \`\${Date.now()} \${mode} \${body}\n\`, { append: true });
    if (mode === "ok") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    if (mode === "fail500") return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response("unknown mode", { status: 500 });
  }

  return new Response("not found", { status: 404 });
});
DENO
"$DENO_BIN" run --allow-net --allow-env --allow-read --allow-write "$GATEWAY_TS" > "$WORKDIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
sleep 2

cleanup() {
  kill "$POSTGREST_PID" "$GATEWAY_PID" "${DISPATCH_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "=== [項目 2] approval-decide 的 file.delete：核准者不是檔案 owner 時要失敗，不能默默刪掉別人的檔案 ==="
APR_BAD="30000000-0000-0000-0000-0000000000f1"
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_BAD','$ROOM_A','$UID_A','file.delete','{\"fileId\":\"$FILE_B\"}'::jsonb,'pending', now() + interval '1 hour');"
$PSQL -c "insert into room_members (room_id, user_id, role) values ('$ROOM_A','$UID_A','owner') on conflict do nothing;"

APPROVAL_STUB="$WORKDIR/approval_decide_stub.ts"
cat > "$APPROVAL_STUB" <<DENO
await import("$REPO_ROOT/supabase/functions/approval-decide/index.ts");
DENO
(
  SUPABASE_URL=http://localhost:3412 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$APPROVAL_STUB" \
      > "$WORKDIR/approval_decide.log" 2>&1 &
  echo $! > "$WORKDIR/approval_decide.pid"
)
sleep 2
APPROVAL_PID=$(cat "$WORKDIR/approval_decide.pid")

RESP_BAD=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APR_BAD\",\"decision\":\"approved\"}")
CODE_BAD=$(echo "$RESP_BAD" | tail -1)
echo "  回應（HTTP $CODE_BAD）：$(echo "$RESP_BAD" | head -n -1)"
[ "$CODE_BAD" = "500" ] && pass "核准者不是檔案 owner，執行失敗回 500（executeTool 丟出例外）" || fail "應該執行失敗，實際是 HTTP $CODE_BAD"
FILE_STATUS_BAD=$($PSQL -tAc "select status from files where id='$FILE_B';")
[ "$FILE_STATUS_BAD" = "active" ] && pass "B 的檔案沒有被刪除，狀態仍然是 active" || fail "B 的檔案狀態變成了 $FILE_STATUS_BAD（應該仍是 active）"
APR_STATUS_BAD=$($PSQL -tAc "select status from approval_requests where id='$APR_BAD';")
[ "$APR_STATUS_BAD" = "failed" ] && pass "approval_requests 正確標記為 failed（不是默默回報 executed）" || fail "approval_requests 狀態是 $APR_STATUS_BAD（應該是 failed）"

kill "$APPROVAL_PID" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 2] approval-decide 的 file.delete 合法路徑：核准者是自己檔案的 owner，應該成功 ==="
FILE_A="20000000-0000-0000-0000-0000000000f2"
$PSQL -c "insert into files (id, room_id, owner_id, bucket, object_path, name, mime_type, size_bytes, status, created_by) values ('$FILE_A','$ROOM_A','$UID_A','room-files','a/mine.txt','mine.txt','text/plain',10,'active','$UID_A');"
APR_GOOD="30000000-0000-0000-0000-0000000000f2"
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_GOOD','$ROOM_A','$UID_A','file.delete','{\"fileId\":\"$FILE_A\"}'::jsonb,'pending', now() + interval '1 hour');"

(
  SUPABASE_URL=http://localhost:3412 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$APPROVAL_STUB" \
      > "$WORKDIR/approval_decide2.log" 2>&1 &
  echo $! > "$WORKDIR/approval_decide2.pid"
)
sleep 2
APPROVAL_PID2=$(cat "$WORKDIR/approval_decide2.pid")
RESP_GOOD=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APR_GOOD\",\"decision\":\"approved\"}")
CODE_GOOD=$(echo "$RESP_GOOD" | tail -1)
[ "$CODE_GOOD" = "200" ] && pass "核准者刪除自己的檔案成功（HTTP 200）" || fail "應該成功，實際是 HTTP $CODE_GOOD：$(echo "$RESP_GOOD" | head -n -1)"
FILE_STATUS_GOOD=$($PSQL -tAc "select status from files where id='$FILE_A';")
[ "$FILE_STATUS_GOOD" = "deleted" ] && pass "自己的檔案確實被標記刪除" || fail "檔案狀態是 $FILE_STATUS_GOOD（應該是 deleted）"

kill "$APPROVAL_PID2" 2>/dev/null || true
sleep 1

start_chat_dispatch() {
  local timeout_ms="$1"
  local stub_ts="$WORKDIR/dispatch_stub.ts"
  cat > "$stub_ts" <<DENO
globalThis.EdgeRuntime = { waitUntil: (p) => { p.catch((e) => console.error("waitUntil rejected", e)); } };
await import("$REPO_ROOT/supabase/functions/chat-dispatch/index.ts");
DENO
  (
    SUPABASE_URL=http://localhost:3412 \
    SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
    SUPABASE_ANON_KEY="$JWT_ANON" \
    ALLOWED_ORIGINS=http://localhost:5173 \
    AGENT_RUN_FETCH_TIMEOUT_MS="$timeout_ms" \
      "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env --allow-read "$stub_ts" \
        > "$WORKDIR/dispatch.log" 2>&1 &
    echo $! > "$WORKDIR/dispatch.pid"
  )
  sleep 3
}

echo ""
echo "=== [項目 7] chat-dispatch 派送冪等：重複呼叫同一則訊息不會建立第二筆 agent_run（重新確認整合後行為不變） ==="
rm -f "$WORKDIR/gw/call_log.txt"
echo "ok" > "$WORKDIR/gw/agent_run_mode.txt"
start_chat_dispatch 5000
MSG1="40000000-0000-0000-0000-0000000000f1"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content) values ('$MSG1','$ROOM_A','user','$UID_A','hi');"
$PSQL -c "insert into message_mentions (message_id, agent_id) values ('$MSG1','$AGENT_A');"
curl -s -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"messageId\":\"$MSG1\"}" > /dev/null
sleep 0.3
curl -s -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"messageId\":\"$MSG1\"}" > /dev/null
sleep 1
RUN_COUNT=$($PSQL -tAc "select count(*) from agent_runs where trigger_message_id='$MSG1';")
[ "$RUN_COUNT" = "1" ] && pass "重複呼叫 chat-dispatch，agent_runs 仍然只有 1 筆" || fail "agent_runs 有 $RUN_COUNT 筆（應該是 1）"
kill "$(cat "$WORKDIR/dispatch.pid")" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 7] agent-run 端點一路失敗（mode=fail500），重試用盡後要標成 failed（重新確認"
echo "  整合後這段跟 #45 新增的 room_id 二次過濾邏輯共存時行為不變） ==="
rm -f "$WORKDIR/gw/call_log.txt"
echo "fail500" > "$WORKDIR/gw/agent_run_mode.txt"
start_chat_dispatch 2000
MSG_FAIL="40000000-0000-0000-0000-0000000000f3"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content) values ('$MSG_FAIL','$ROOM_A','user','$UID_A','hi fail');"
$PSQL -c "insert into message_mentions (message_id, agent_id) values ('$MSG_FAIL','$AGENT_A');"
curl -s -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"messageId\":\"$MSG_FAIL\"}" > /dev/null
sleep 5
STATUS_FAIL=$($PSQL -tAc "select status from agent_runs where trigger_message_id='$MSG_FAIL';")
ERRCODE_FAIL=$($PSQL -tAc "select error_code from agent_runs where trigger_message_id='$MSG_FAIL';")
[ "$STATUS_FAIL" = "failed" ] && pass "agent-run 一路失敗，重試用盡後 agent_run 狀態變成 failed" || fail "agent_run 狀態是 $STATUS_FAIL（應該是 failed）"
[ "$ERRCODE_FAIL" = "dispatch_failed" ] && pass "error_code 記錄為 dispatch_failed" || fail "error_code 是 $ERRCODE_FAIL"
kill "$(cat "$WORKDIR/dispatch.pid")" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 7] 孤兒 queued 紀錄中斷復原（真實修正驗證，可重跑兩輪證明不是巧合）==="
echo "  情境：chat-dispatch 執行環境在『insert agent_runs』之後、還沒開始執行"
echo "  dispatchAgentRuns()／進入 waitUntil() 之前就被中止（例如平台強制回收 isolate），"
echo "  原本 triggerAgentRun() 重試用盡才會做的那個條件式 UPDATE 完全沒有機會執行到，"
echo "  這筆紀錄會永遠卡在 queued。修正：_shared/agentRunReaper.ts 的 reapStaleQueuedAgentRuns()"
echo "  現在會在 chat-dispatch 每次被呼叫時（不限同一則訊息/同一個房間）順手清掃一次全域逾時"
echo "  仍是 queued 的紀錄，下面直接呼叫真實的 chat-dispatch/index.ts 驗證這個清掃真的會發生，"
echo "  不是只讀程式碼推論。"

reap_round() {
  local round="$1"
  local orphan_run_id="$2"
  local orphan_msg_id="$3"
  local fresh_run_id="$4"
  local fresh_msg_id="$5"
  local trigger_msg_id="$6"

  $PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$orphan_msg_id','$ROOM_A','user','$UID_A','orphaned round $round', now() - interval '2 hours');"
  $PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$orphan_run_id','$ROOM_A','$AGENT_A','$orphan_msg_id','queued', now() - interval '2 hours', now() - interval '2 hours');"
  echo "  round $round：已插入一筆 2 小時前建立、狀態 queued 的孤兒紀錄 $orphan_run_id"

  # 對照組：剛建立、還在正常逾時重試視窗內的 queued 紀錄，用來確認清掃邏輯不會
  # 「見到 queued 就殺」，而是真的只挑逾時的——避免假陽性把還在跑的請求誤判成孤兒。
  $PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$fresh_msg_id','$ROOM_A','user','$UID_A','fresh round $round', now());"
  $PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$fresh_run_id','$ROOM_A','$AGENT_A','$fresh_msg_id','queued', now(), now());"
  echo "  round $round：已插入一筆剛建立、狀態 queued 的對照組紀錄 $fresh_run_id（不該被清掃）"

  # 觸發一次跟這兩筆孤兒/對照組完全無關的訊息，證明清掃是「chat-dispatch 被呼叫就順手
  # 執行」的全域行為，不是因為剛好處理到同一則訊息或同一個代理。
  $PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content) values ('$trigger_msg_id','$ROOM_A','user','$UID_A','round $round trigger, unrelated');"
  $PSQL -c "insert into message_mentions (message_id, agent_id) values ('$trigger_msg_id','$AGENT_A');"
  curl -s -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"messageId\":\"$trigger_msg_id\"}" > /dev/null
  sleep 1.5

  local orphan_status orphan_errcode fresh_status
  orphan_status=$($PSQL -tAc "select status from agent_runs where id='$orphan_run_id';")
  orphan_errcode=$($PSQL -tAc "select error_code from agent_runs where trigger_message_id='$orphan_msg_id';")
  fresh_status=$($PSQL -tAc "select status from agent_runs where id='$fresh_run_id';")

  [ "$orphan_status" = "failed" ] && pass "round $round：2 小時前的孤兒 queued 紀錄被清掃成 failed" || fail "round $round：孤兒紀錄狀態是 $orphan_status（應該是 failed）"
  [ "$orphan_errcode" = "orphaned_before_dispatch" ] && pass "round $round：error_code 記錄為 orphaned_before_dispatch" || fail "round $round：error_code 是 $orphan_errcode（應該是 orphaned_before_dispatch）"
  [ "$fresh_status" = "queued" ] && pass "round $round：剛建立、還在逾時視窗內的對照組紀錄沒有被誤清掃，仍是 queued" || fail "round $round：對照組紀錄被誤動成 $fresh_status（應該仍是 queued，這是假陽性 bug）"
}

rm -f "$WORKDIR/gw/call_log.txt"
echo "ok" > "$WORKDIR/gw/agent_run_mode.txt"
start_chat_dispatch 5000

reap_round 1 \
  "50000000-0000-0000-0000-0000000000f1" "40000000-0000-0000-0000-0000000000f2" \
  "50000000-0000-0000-0000-0000000000f2" "40000000-0000-0000-0000-0000000000f4" \
  "40000000-0000-0000-0000-0000000000f5"

# 第二輪：獨立、新插入的另一筆孤兒紀錄，用同一個持續執行中的 chat-dispatch process
# 再清掃一次，證明這個機制是「每次呼叫都會做」的常態行為，不是啟動時才跑一次性的
# 初始化邏輯、也不是上一輪剛好把某個全域旗標用掉了才「看起來」成功。
reap_round 2 \
  "50000000-0000-0000-0000-0000000000f6" "40000000-0000-0000-0000-0000000000f7" \
  "50000000-0000-0000-0000-0000000000f8" "40000000-0000-0000-0000-0000000000f9" \
  "40000000-0000-0000-0000-0000000000fa"

kill "$(cat "$WORKDIR/dispatch.pid")" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 7] agent-run-reaper 備援端點：只接受 service_role 呼叫，一般使用者呼叫要被拒絕 ==="
REAPER_STUB="$WORKDIR/agent_run_reaper_stub.ts"
cat > "$REAPER_STUB" <<DENO
await import("$REPO_ROOT/supabase/functions/agent-run-reaper/index.ts");
DENO
(
  SUPABASE_URL=http://localhost:3412 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$REAPER_STUB" \
      > "$WORKDIR/agent_run_reaper.log" 2>&1 &
  echo $! > "$WORKDIR/agent_run_reaper.pid"
)
sleep 2
REAPER_PID=$(cat "$WORKDIR/agent_run_reaper.pid")

CODE_USER=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{}")
[ "$CODE_USER" = "403" ] && pass "一般使用者 JWT 呼叫 agent-run-reaper 被拒（HTTP 403）" || fail "應該回 403，實際是 $CODE_USER"

ORPHAN_RUN_REAPER="50000000-0000-0000-0000-0000000000fb"
ORPHAN_MSG_REAPER="40000000-0000-0000-0000-0000000000fc"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$ORPHAN_MSG_REAPER','$ROOM_A','user','$UID_A','orphaned for reaper endpoint', now() - interval '2 hours');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$ORPHAN_RUN_REAPER','$ROOM_A','$AGENT_A','$ORPHAN_MSG_REAPER','queued', now() - interval '2 hours', now() - interval '2 hours');"

RESP_SERVICE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_SERVICE" -H "Content-Type: application/json" -d "{}")
CODE_SERVICE=$(echo "$RESP_SERVICE" | tail -1)
echo "  service_role 呼叫回應（HTTP $CODE_SERVICE）：$(echo "$RESP_SERVICE" | head -n -1)"
[ "$CODE_SERVICE" = "200" ] && pass "service_role 呼叫 agent-run-reaper 成功（HTTP 200）" || fail "應該成功，實際是 HTTP $CODE_SERVICE"
STATUS_REAPER=$($PSQL -tAc "select status from agent_runs where id='$ORPHAN_RUN_REAPER';")
[ "$STATUS_REAPER" = "failed" ] && pass "獨立 agent-run-reaper 端點也能清掃孤兒 queued 紀錄" || fail "孤兒紀錄狀態是 $STATUS_REAPER（應該是 failed）"

echo ""
echo "=== [項目 7] agent-run-reaper 在資料庫清掃失敗時要回報失敗，不能假裝清掃成功 ==="
echo "  用真實的資料庫層失敗來測（撤銷 service_role 對 agent_runs 的 UPDATE 權限，模擬"
echo "  reapStaleQueuedAgentRuns() 內部的 UPDATE 真的查詢失敗的情境），不是只讀程式碼假設。"
ORPHAN_RUN_REAPER_FAIL="50000000-0000-0000-0000-0000000000fd"
ORPHAN_MSG_REAPER_FAIL="40000000-0000-0000-0000-0000000000fe"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$ORPHAN_MSG_REAPER_FAIL','$ROOM_A','user','$UID_A','orphaned for reaper failure test', now() - interval '2 hours');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$ORPHAN_RUN_REAPER_FAIL','$ROOM_A','$AGENT_A','$ORPHAN_MSG_REAPER_FAIL','queued', now() - interval '2 hours', now() - interval '2 hours');"
$PSQL -c "revoke update on agent_runs from service_role;"

RESP_REAP_FAIL=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_SERVICE" -H "Content-Type: application/json" -d "{}")
CODE_REAP_FAIL=$(echo "$RESP_REAP_FAIL" | tail -1)
BODY_REAP_FAIL=$(echo "$RESP_REAP_FAIL" | head -n -1)
echo "  資料庫沒有 UPDATE 權限時的回應（HTTP $CODE_REAP_FAIL）：$BODY_REAP_FAIL"
[ "$CODE_REAP_FAIL" = "500" ] && pass "清掃查詢失敗時，agent-run-reaper 回報 HTTP 500（不是假裝成功的 200）" || fail "應該回 500，實際是 HTTP $CODE_REAP_FAIL"
echo "$BODY_REAP_FAIL" | grep -q "reap_query_failed" && pass "錯誤內容帶有明確的 reap_query_failed 代碼，排程監控可以分辨這次是真的失敗" || fail "回應內容沒有 reap_query_failed：$BODY_REAP_FAIL"

$PSQL -c "grant update on agent_runs to service_role;"
STATUS_REAPER_FAIL=$($PSQL -tAc "select status from agent_runs where id='$ORPHAN_RUN_REAPER_FAIL';")
[ "$STATUS_REAPER_FAIL" = "queued" ] && pass "清掃查詢失敗時，這筆孤兒紀錄確實沒有被清掃到（狀態仍是 queued，跟回報的失敗一致）" || fail "孤兒紀錄狀態是 $STATUS_REAPER_FAIL（應該仍是 queued，因為 UPDATE 權限被撤銷時不可能成功清掃）"

# 復原權限後，重新呼叫一次確認端點恢復正常（避免這個測項本身把資料庫狀態留在
# 破壞性的中間狀態，影響到後面的測項或人工複查這支腳本時的觀感）。
RESP_REAP_RECOVER=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_SERVICE" -H "Content-Type: application/json" -d "{}")
CODE_REAP_RECOVER=$(echo "$RESP_REAP_RECOVER" | tail -1)
[ "$CODE_REAP_RECOVER" = "200" ] && pass "復原 UPDATE 權限後，agent-run-reaper 恢復正常運作（HTTP 200）" || fail "復原權限後應該恢復 200，實際是 HTTP $CODE_REAP_RECOVER"
STATUS_REAPER_RECOVER=$($PSQL -tAc "select status from agent_runs where id='$ORPHAN_RUN_REAPER_FAIL';")
[ "$STATUS_REAPER_RECOVER" = "failed" ] && pass "恢復正常後，剛才卡住的孤兒紀錄也被正確清掃成 failed" || fail "孤兒紀錄狀態是 $STATUS_REAPER_RECOVER（應該是 failed）"

kill "$REAPER_PID" 2>/dev/null || true
sleep 1

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
