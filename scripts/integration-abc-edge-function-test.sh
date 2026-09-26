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

echo "=== 依整合後的最終順序套用全部 migration（0001~0025） ==="
for f in "$REPO_ROOT"/supabase/migrations/00{01..25}_*.sql; do
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
echo "=== [項目 7] 三 PR 整合特別驗證：queued 紀錄如果不是因為 fetch 失敗，而是整個 chat-dispatch"
echo "  執行環境在『insert agent_runs』之後、還沒開始執行 dispatchAgentRuns()／進入 waitUntil()"
echo "  之前就被中止（例如平台強制回收 isolate），有沒有任何背景機制會偵測、逾時、重試這筆"
echo "  卡住的紀錄？ ==="
echo "  程式碼檢查結果：chat-dispatch/index.ts 裡唯一會把卡住的 agent_run 標成 failed 的地方，"
echo "  是 triggerAgentRun() 重試用盡後的那個條件式 UPDATE（見 index.ts 的 dispatchAgentRuns），"
echo "  這段程式碼只有在『同一次 chat-dispatch 呼叫真的執行到 dispatchAgentRuns()／waitUntil()"
echo "  那一步』才會跑到。如果中斷點更早（insert 完 agent_runs 就中止，例如平台在回應送出"
echo "  之前就直接砍掉整個 isolate），這段程式碼根本沒有機會執行。"
echo "  用一筆『模擬中斷』的 queued 紀錄（不透過 chat-dispatch 自己 insert，直接代表『insert"
echo "  成功但後續沒有任何一段程式碼碰過它』的狀態）確認：沒有任何排程/trigger/其他 Edge"
echo "  Function 會主動偵測、逾時這筆紀錄——"
ORPHAN_MSG="40000000-0000-0000-0000-0000000000f2"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$ORPHAN_MSG','$ROOM_A','user','$UID_A','orphaned', now() - interval '2 hours');"
ORPHAN_RUN="50000000-0000-0000-0000-0000000000f1"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$ORPHAN_RUN','$ROOM_A','$AGENT_A','$ORPHAN_MSG','queued', now() - interval '2 hours', now() - interval '2 hours');"
echo "  （已插入一筆 2 小時前建立、狀態 queued 的孤兒紀錄，模擬『chat-dispatch 在這之後就沒有"
echo "  任何後續執行』）"
sleep 2
ORPHAN_STATUS=$($PSQL -tAc "select status from agent_runs where id='$ORPHAN_RUN';")
if [ "$ORPHAN_STATUS" = "queued" ]; then
  fail_but_documented=1
  echo "  ⚠ 確認結果：這筆紀錄的狀態仍然是 queued，沒有任何背景機制把它標成 failed 或重新"
  echo "  觸發——這是真實的殘留風險，不是這次修正的範圍（見整合測試報告『未達標／後續工作』），"
  echo "  使用者會看到這則訊息永遠停在『OOO 回覆中…』，除非使用者對同一則訊息的 chat-dispatch"
  echo "  再被呼叫一次（目前沒有對應的 UI 動作，例如沒有『重新派送』按鈕）。"
  pass "（如實記錄，非測試失敗）確認目前架構下沒有 queued 孤兒紀錄的逾時修復機制，已列入整合報告的殘留風險"
else
  fail "預期這筆模擬孤兒紀錄應該仍是 queued（沒有背景機制動它），實際變成了 $ORPHAN_STATUS——如果真的有機制在動它，需要回頭確認是什麼機制、找到後更新這裡的測試假設"
fi

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
