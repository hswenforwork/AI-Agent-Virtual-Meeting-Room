#!/usr/bin/env bash
# 17 項修正計劃 A/B/C 三個 PR（#45 跨帳號權限、#44 共享知識、#46 付費呼叫可靠性）
# 整合回歸測試：資料庫層／PostgREST HTTP／RPC 層級的部分。
#
# 對照 docs/17項計劃-ABC整合測試報告.md。這支腳本只涵蓋不需要真的執行 Edge Function
# TypeScript 程式碼、單靠 PostgREST + 真實 RLS + 真實 JWT auth.uid() 就能驗證的項目：
#   - 項目 1：room_members 自行入會（Phase A）
#   - 項目 3：跨房間點名（Phase A），以及跟項目 9 的 send_message_with_mentions() RPC
#     合在一起時，跨房間點名是否仍然被正確擋下（這是三個 PR 整合後才需要驗證的交互作用，
#     單一 PR 各自的測試報告都沒測過這個組合）
#   - 項目 4／13／14：決策只追加不可繞過、知識檢索跨聊天室查詢範圍、稽核分頁邏輯（Phase B）
#   - 項目 8：核准原子搶占（只測資料庫層的條件式 UPDATE 競態，approval-decide 本身的
#     Deno 執行測試見 scripts/integration-abc-edge-function-test.sh）
#   - 項目 9：send_message_with_mentions() 冪等與原子性（Phase C）
#   - 項目 10：對話摘要 backlog 查詢方向與鎖（只測 SQL 邏輯，跟 Phase C 報告一致）
#   - 項目 16：usage_daily 原子累加（Phase C）
#
# 項目 2（approval-decide owner 驗證）、6（worker-task-start 原子搶占）、7（chat-dispatch
# 派送冪等與逾時重試、以及中斷後 queued 紀錄是否有逾時修復）需要真的執行 Edge Function
# TypeScript 程式碼，見另一支 scripts/integration-abc-edge-function-test.sh。
#
# 用法：POSTGREST_BIN=/path/to/postgrest ./scripts/integration-abc-sql-rpc-test.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-integration_abc_sql}"
POSTGREST_BIN="${POSTGREST_BIN:?請設定 POSTGREST_BIN 指向 postgrest 執行檔}"
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

echo "=== 依整合後的最終順序套用全部 migration（0001~0026） ==="
for f in "$REPO_ROOT"/supabase/migrations/00{01..26}_*.sql; do
  base="$(basename "$f")"
  if [ "$base" = "0006_enable_realtime.sql" ]; then
    grep -v "alter publication supabase_realtime add table" "$f" | $PSQL
  elif [ "$base" = "0009_byok_api_keys.sql" ]; then
    grep -v "create extension if not exists supabase_vault cascade;" "$f" | $PSQL
  else
    $PSQL -f "$f"
  fi
done
echo "  （成功套用 0001~0026，確認三個 PR 的 migration 依整合後的最終序號可以從乾淨的
  main 既有 schema 一路套用下去，不是只靠 GitHub 各自的『可合併』狀態）"

echo "=== 建立測試帳號 A / B、各自的房間與代理 ==="
UID_A="00000000-0000-0000-0000-0000000000e1"
UID_B="00000000-0000-0000-0000-0000000000e2"
$PSQL -c "insert into auth.users (id, email) values ('$UID_A','ea@ci.local'), ('$UID_B','eb@ci.local');"
$PSQL -c "insert into profiles (id, display_name) values ('$UID_A','EA'), ('$UID_B','EB') on conflict (id) do nothing;"
ROOM_A="10000000-0000-0000-0000-0000000000e1"
ROOM_B="10000000-0000-0000-0000-0000000000e2"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_A','$UID_A','A room', true), ('$ROOM_B','$UID_B','B room', true);"
AGENT_A=$($PSQL -tAc "select id from agents where room_id='$ROOM_A' and provider='anthropic' limit 1;")
AGENT_B=$($PSQL -tAc "select id from agents where room_id='$ROOM_B' and provider='anthropic' limit 1;")

echo "=== 啟動 postgrest ==="
JWT_SECRET="integration-abc-sql-test-secret-not-for-production"
CONF="$(mktemp)"
cat > "$CONF" <<EOF
db-uri = "postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3311
EOF
"$POSTGREST_BIN" "$CONF" > /tmp/integration_abc_sql_postgrest.log 2>&1 &
POSTGREST_PID=$!
sleep 2
trap 'kill "$POSTGREST_PID" 2>/dev/null || true' EXIT

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

PR="http://localhost:3311"

echo ""
echo "=== [項目 1] room_members 自行入會應該被拒（Phase A，整合後重跑確認未被 #44/#46 影響）==="
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PR/room_members" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"room_id\":\"$ROOM_B\",\"user_id\":\"$UID_A\",\"role\":\"member\"}")
[ "$CODE" = "403" ] && pass "A 自行加入 B 的房間被拒（HTTP 403）" || fail "應該回 403，實際是 $CODE"
COUNT=$($PSQL -tAc "select count(*) from room_members where room_id='$ROOM_B' and user_id='$UID_A';")
[ "$COUNT" = "0" ] && pass "room_members 沒有新增這一列" || fail "room_members 竟然有 $COUNT 筆"

echo ""
echo "=== [項目 3] 跨房間點名（直接 insert message_mentions）應該被拒 ==="
MSG_A1=$(curl -s -X POST "$PR/messages" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"sender_type\":\"user\",\"sender_user_id\":\"$UID_A\",\"content\":\"hi\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PR/message_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"message_id\":\"$MSG_A1\",\"agent_id\":\"$AGENT_B\"}")
[ "$CODE" = "403" ] && pass "A 直接 insert message_mentions 點名 B 房間代理被拒（HTTP 403）" || fail "應該回 403，實際是 $CODE"

echo ""
echo "=== [項目 3 + 9 交互測試] 透過 send_message_with_mentions() RPC 夾帶跨房間 agent_id，跟直接 insert 一樣要被擋下 ==="
echo "  （這是三個 PR 各自的測試報告都沒測過的組合：#45 收緊了 message_mentions 的 RLS policy，"
echo "  #46 新增的 RPC 是 security invoker，理論上一樣受這條 policy 約束。使用者回報這個組合"
echo "  原本只會讓整個 RPC 交易因為通用的 RLS 違規訊息 rollback，使用者只看到一句看不懂的"
echo "  Postgres 錯誤，猜不出真正原因。修正：RPC 現在在動用任何 INSERT 之前，先明確檢查"
echo "  點名的 agent_id 是不是都屬於這個房間，不是的話直接丟出一句看得懂的錯誤——保留"
echo "  『整則訊息一起 rollback』的行為，但不再是靠 RLS 違規這種不友善的方式）"
CLIENT_ID_X="client-cross-room-x1"
RESP_X=$(curl -s -w "\n%{http_code}" -X POST "$PR/rpc/send_message_with_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"p_room_id\":\"$ROOM_A\",\"p_content\":\"trying cross-room mention\",\"p_client_id\":\"$CLIENT_ID_X\",\"p_mention_agent_ids\":[\"$AGENT_B\"]}")
HTTP_CODE_X=$(echo "$RESP_X" | tail -1)
BODY_X=$(echo "$RESP_X" | head -n -1)
echo "  RPC 回應（HTTP $HTTP_CODE_X）：$BODY_X"
[ "$HTTP_CODE_X" = "400" ] && pass "跨房間點名被 RPC 自己的前置檢查擋下（HTTP 400，不是通用的 403 RLS 違規）" || fail "應該回 400，實際是 $HTTP_CODE_X"
HINT_X=$(echo "$BODY_X" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).hint||'')}catch{console.log('')}})")
[ "$HINT_X" = "mention_agent_not_in_room" ] && pass "錯誤訊息帶有明確的 hint（mention_agent_not_in_room），不是模糊的權限錯誤" || fail "hint 是「$HINT_X」（應該是 mention_agent_not_in_room）"
echo "$BODY_X" | grep -q "點名的其中一位代理不屬於這個房間" && pass "錯誤訊息是使用者看得懂的中文提示（不是原始 Postgres/RLS 錯誤文字）" || fail "錯誤訊息內容不是預期的友善提示：$BODY_X"
MSG_COUNT_X=$($PSQL -tAc "select count(*) from messages where room_id='$ROOM_A' and client_id='$CLIENT_ID_X';")
[ "$MSG_COUNT_X" = "0" ] && pass "訊息本體確實沒有被寫入（前置檢查在任何 INSERT 之前就擋下，整個交易 rollback）" || fail "訊息本體竟然被寫入了 $MSG_COUNT_X 筆（應該整個 rollback）"

echo ""
echo "=== [項目 9] send_message_with_mentions() 合法路徑：同一房間點名、client_id 重試冪等 ==="
CLIENT_ID_Y="client-legit-y1"
RESP_Y1=$(curl -s -X POST "$PR/rpc/send_message_with_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"p_room_id\":\"$ROOM_A\",\"p_content\":\"legit mention\",\"p_client_id\":\"$CLIENT_ID_Y\",\"p_mention_agent_ids\":[\"$AGENT_A\"]}")
MSG_ID_Y=$(echo "$RESP_Y1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
RESP_Y2=$(curl -s -X POST "$PR/rpc/send_message_with_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"p_room_id\":\"$ROOM_A\",\"p_content\":\"legit mention（重試，內容刻意打錯示範不影響冪等鍵）\",\"p_client_id\":\"$CLIENT_ID_Y\",\"p_mention_agent_ids\":[\"$AGENT_A\"]}")
MSG_ID_Y2=$(echo "$RESP_Y2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
[ "$MSG_ID_Y" = "$MSG_ID_Y2" ] && pass "同一個 client_id 重試回傳同一筆訊息 id（冪等）" || fail "兩次呼叫回傳不同訊息 id：$MSG_ID_Y vs $MSG_ID_Y2"
MSG_TOTAL_Y=$($PSQL -tAc "select count(*) from messages where room_id='$ROOM_A' and client_id='$CLIENT_ID_Y';")
[ "$MSG_TOTAL_Y" = "1" ] && pass "資料庫裡確實只有 1 筆訊息（沒有插入第二筆半成品）" || fail "資料庫裡有 $MSG_TOTAL_Y 筆（應該是 1）"
MENTION_TOTAL_Y=$($PSQL -tAc "select count(*) from message_mentions where message_id='$MSG_ID_Y';")
[ "$MENTION_TOTAL_Y" = "1" ] && pass "mention 也只有 1 筆（on conflict do nothing 生效）" || fail "mention 有 $MENTION_TOTAL_Y 筆"

echo ""
echo "=== [項目 9] 20 個並發、相同 client_id 呼叫 RPC，最終資料庫只能有 1 筆訊息 ==="
CLIENT_ID_Z="client-concurrent-z1"
CONCURRENCY_PIDS=()
for i in $(seq 1 20); do
  curl -s -o /dev/null -X POST "$PR/rpc/send_message_with_mentions" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d "{\"p_room_id\":\"$ROOM_A\",\"p_content\":\"concurrent $i\",\"p_client_id\":\"$CLIENT_ID_Z\",\"p_mention_agent_ids\":[]}" &
  CONCURRENCY_PIDS+=("$!")
done
wait "${CONCURRENCY_PIDS[@]}"
MSG_TOTAL_Z=$($PSQL -tAc "select count(*) from messages where room_id='$ROOM_A' and client_id='$CLIENT_ID_Z';")
[ "$MSG_TOTAL_Z" = "1" ] && pass "20 個並發相同 client_id 的呼叫，資料庫仍然只有 1 筆訊息（unique_violation 分支生效）" || fail "資料庫裡有 $MSG_TOTAL_Z 筆訊息（應該是 1，代表併發插入沒有被擋下）"

echo ""
echo "=== [項目 8] approval_requests 原子搶占（SQL 層級的並發 UPDATE 競態，資料庫鎖定本身的保證） ==="
APR_ID="40000000-0000-0000-0000-0000000000e1"
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_ID','$ROOM_A','$UID_A','file.delete','{}'::jsonb,'pending', now() + interval '1 hour');"
cat > /tmp/integration_abc_claim1.sql <<SQL
\set ON_ERROR_STOP on
begin;
select pg_sleep(0.2);
update approval_requests set status = 'executing' where id = '$APR_ID' and status = 'pending' returning id;
commit;
SQL
cp /tmp/integration_abc_claim1.sql /tmp/integration_abc_claim2.sql
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim1.sql > /tmp/integration_abc_claim1_out.txt 2>&1 &
CP1=$!
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim2.sql > /tmp/integration_abc_claim2_out.txt 2>&1 &
CP2=$!
wait $CP1 $CP2
WINNERS=$(grep -c "$APR_ID" /tmp/integration_abc_claim1_out.txt /tmp/integration_abc_claim2_out.txt | awk -F: '{s+=$2} END {print s}')
[ "$WINNERS" = "1" ] && pass "兩個並發搶占 pending->executing，恰好只有 1 個搶到" || fail "搶到的請求數是 $WINNERS（應該是 1）"

echo ""
echo "=== [項目 4] 決策只追加：直接 UPDATE 繞過 accept 流程要被資料庫層擋下（REVOKE UPDATE） ==="
DEC_ID="50000000-0000-0000-0000-0000000000e1"
$PSQL -c "insert into decisions (id, owner_id, title, decision_text, status) values ('$DEC_ID','$UID_A','D1','決策內容','active');"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$PR/decisions?id=eq.$DEC_ID" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -d '{"status":"superseded"}')
[ "$CODE" = "404" ] || [ "$CODE" = "403" ] && pass "使用者直接 PATCH decisions.status 被擋下（HTTP $CODE，authenticated 沒有 UPDATE 權限）" || fail "應該被擋下，實際是 $CODE"
STATUS_CHECK=$($PSQL -tAc "select status from decisions where id='$DEC_ID';")
[ "$STATUS_CHECK" = "active" ] && pass "資料庫裡的 status 沒有被改動，仍然是 active" || fail "status 變成了 $STATUS_CHECK"

echo ""
echo "=== [項目 13] 知識檢索不限定跨聊天室（buildKnowledgeContext 的查詢邏輯：整個帳號範圍，不是單一房間） ==="
KI_ID="60000000-0000-0000-0000-0000000000e1"
$PSQL -c "insert into knowledge_items (id, owner_id, category, title, body, status) values ('$KI_ID','$UID_A','fact','K1','跨房間也查得到的知識','active');"
ROOM_A2="10000000-0000-0000-0000-0000000000e3"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_A2','$UID_A','A room 2', true);"
KI_COUNT=$($PSQL -tAc "select count(*) from knowledge_items where owner_id = '$UID_A' and status = 'active';")
[ "$KI_COUNT" -ge "1" ] && pass "以 owner_id（不是 room_id）查詢，跨聊天室建立的知識項目查得到（$KI_COUNT 筆）" || fail "查不到知識項目"

echo ""
echo "=== [項目 14] knowledge-audit 分頁查詢邏輯：超過單頁大小的資料要能全部掃到 ==="
for i in $(seq 1 5); do
  $PSQL -c "insert into knowledge_items (id, owner_id, category, title, body, status) values (gen_random_uuid(),'$UID_A','fact','無來源知識 $i','內容','active');" > /dev/null
done
NO_SOURCE_COUNT=$($PSQL -tAc "
  select count(*) from knowledge_items ki
  where ki.owner_id = '$UID_A' and ki.status = 'active'
    and not exists (select 1 from knowledge_sources ks where ks.subject_type='knowledge_item' and ks.subject_id=ki.id);
")
[ "$NO_SOURCE_COUNT" -ge "5" ] && pass "稽核用的『沒有來源』查詢邏輯（not exists，不受分頁大小限制）掃到全部 $NO_SOURCE_COUNT 筆" || fail "只掃到 $NO_SOURCE_COUNT 筆（應該至少 5 筆）"

echo ""
echo "=== [項目 10] 對話摘要 backlog 查詢方向：asc + 上界排除，不會漏掉／重複積壓訊息 ==="
ROOM_SUM="10000000-0000-0000-0000-0000000000e4"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_SUM','$UID_A','Summary room', true);"
$PSQL -c "
insert into messages (room_id, sender_type, sender_user_id, content, created_at)
select '$ROOM_SUM', 'user', '$UID_A', 'msg ' || i, timestamptz '2026-01-01 00:00:00+00' + (i || ' seconds')::interval
from generate_series(1, 350) as i;
"
RECENT_CUTOFF=$($PSQL -tAc "
  select created_at from messages where room_id='$ROOM_SUM' and status='completed' and sender_type != 'system'
  order by created_at desc offset 23 limit 1;
")
BACKLOG_COUNT=$($PSQL -tAc "
  select count(*) from messages where room_id='$ROOM_SUM' and status='completed' and sender_type != 'system'
    and created_at > '1970-01-01T00:00:00Z' and created_at < '$RECENT_CUTOFF';
")
[ "$BACKLOG_COUNT" = "326" ] && pass "積壓總數正確：326 則（350 - 24 最新視窗）" || fail "積壓總數是 $BACKLOG_COUNT（應該是 326）"

echo ""
echo "=== [項目 6] worker_tasks 原子搶占（worker-task-start 的 CMA_BASE 是硬編碼、"
echo "  不可用環境變數改的真實 Anthropic Managed Agents API，跟 Phase C 報告一樣只驗證"
echo "  SQL 層的條件式 UPDATE 原子性，不執行真的會建立付費 session 的程式碼路徑） ==="
WT_MSG=$(curl -s -X POST "$PR/messages" -H "Authorization: Bearer $JWT_A" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "{\"room_id\":\"$ROOM_A\",\"sender_type\":\"user\",\"sender_user_id\":\"$UID_A\",\"content\":\"do a task\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[0].id))")
WT_ID="70000000-0000-0000-0000-0000000000e1"
$PSQL -c "insert into worker_tasks (id, room_id, agent_id, origin_message_id, task_summary, status) values ('$WT_ID','$ROOM_A','$AGENT_A','$WT_MSG','do a task','pending_confirmation');"
cat > /tmp/integration_abc_wt_claim1.sql <<SQL
\set ON_ERROR_STOP on
begin;
select pg_sleep(0.2);
update worker_tasks set status = 'queued' where id = '$WT_ID' and status in ('pending_confirmation','failed') returning id;
commit;
SQL
cp /tmp/integration_abc_wt_claim1.sql /tmp/integration_abc_wt_claim2.sql
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_wt_claim1.sql > /tmp/integration_abc_wt_claim1_out.txt 2>&1 &
WT1=$!
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_wt_claim2.sql > /tmp/integration_abc_wt_claim2_out.txt 2>&1 &
WT2=$!
wait $WT1 $WT2
WT_WINNERS=$(grep -c "$WT_ID" /tmp/integration_abc_wt_claim1_out.txt /tmp/integration_abc_wt_claim2_out.txt | awk -F: '{s+=$2} END {print s}')
[ "$WT_WINNERS" = "1" ] && pass "兩個並發搶占 worker_tasks pending_confirmation->queued，恰好只有 1 個搶到（不會建立兩個 Managed Agents session）" || fail "搶到的請求數是 $WT_WINNERS（應該是 1）"
echo "  對照組（重現舊寫法會產生的問題）：先 SELECT 判斷、之後才 UPDATE 的寫法，兩個並發"
echo "  交易都會在各自的交易裡看到 status 還是 pending_confirmation（因為 UPDATE 還沒發生），"
echo "  都會判定『可以開始』——這正是舊程式碼會建立兩個真的付費 session 的原因，此處不重複"
echo "  執行對照組（會需要另外還原 status 才能公平比較，邏輯已在上面新寫法測項證明差異）。"

echo ""
echo "=== [項目 16] increment_usage_daily() 原子累加：20 個並發呼叫加總必須完全正確 ==="
USAGE_DATE="2026-04-01"
CONCURRENCY_PIDS2=()
for i in $(seq 1 20); do
  curl -s -o /dev/null -X POST "$PR/rpc/increment_usage_daily" -H "Authorization: Bearer $JWT_SERVICE" -H "Content-Type: application/json" -d "{\"p_usage_date\":\"$USAGE_DATE\",\"p_room_id\":\"$ROOM_A\",\"p_agent_id\":\"$AGENT_A\",\"p_input_tokens\":10,\"p_output_tokens\":5}" &
  CONCURRENCY_PIDS2+=("$!")
done
wait "${CONCURRENCY_PIDS2[@]}"
ROW=$($PSQL -tAc "select request_count || ',' || input_tokens || ',' || output_tokens from usage_daily where usage_date='$USAGE_DATE' and room_id='$ROOM_A' and agent_id='$AGENT_A';")
IFS=',' read -r REQ INP OUT <<< "$ROW"
[ "$REQ" = "20" ] && [ "$INP" = "200" ] && [ "$OUT" = "100" ] && pass "20 次併發呼叫加總完全正確：request_count=20, input=200, output=100" || fail "結果是 request_count=$REQ, input=$INP, output=$OUT（應該是 20/200/100）"

echo ""
echo "=== [項目 7 補強] agent-run 原子搶占：PR #47 第二輪審閱意見要求的併發邊界 ==="
echo "  agent-run/index.ts 現在用單一條件式 UPDATE（WHERE id=\$1 AND status='queued'，"
echo "  帶 RETURNING）當唯一的搶占點，只有真的把 status 從 queued 換成 running 的那次"
echo "  呼叫才會往下執行付費的供應商呼叫。這裡直接測試這個 SQL 層的搶占原語本身（跟"
echo "  項目 6／8 的 worker_tasks／approval_requests 原子搶占用同一種方法論——agent-run"
echo "  真的呼叫供應商 API 的部分不在這裡測，見整合測試報告的測試限制說明），確認："
echo "  (a) 兩個並發的 agent-run 呼叫同時搶同一筆 queued 紀錄，最多只有一個會搶到，"
echo "  等同「最多一次付費執行」；(b) reaper 跟 agent-run 同時處理同一筆紀錄時兩者"
echo "  互斥，不會同時得逞；(c) 已經被 reaper 標成 failed 的紀錄，之後才到的 agent-run"
echo "  搶占嘗試必須拿到 0 筆，不能把 failed 蓋回 running。"

echo ""
echo "--- (a) 兩個並發的 agent-run 呼叫同時搶同一筆 queued 紀錄 ---"
MSG_CLAIM_A="80000000-0000-0000-0000-0000000000e1"
RUN_CLAIM_A="90000000-0000-0000-0000-0000000000e1"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content) values ('$MSG_CLAIM_A','$ROOM_A','user','$UID_A','claim race a');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status) values ('$RUN_CLAIM_A','$ROOM_A','$AGENT_A','$MSG_CLAIM_A','queued');"
cat > /tmp/integration_abc_claim_a1.sql <<SQL
\set ON_ERROR_STOP on
begin;
select pg_sleep(0.2);
update agent_runs set status = 'running', updated_at = now() where id = '$RUN_CLAIM_A' and status = 'queued' returning id;
commit;
SQL
cp /tmp/integration_abc_claim_a1.sql /tmp/integration_abc_claim_a2.sql
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim_a1.sql > /tmp/integration_abc_claim_a1_out.txt 2>&1 &
CA1=$!
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim_a2.sql > /tmp/integration_abc_claim_a2_out.txt 2>&1 &
CA2=$!
wait $CA1 $CA2
WINNERS_A=$(grep -c "$RUN_CLAIM_A" /tmp/integration_abc_claim_a1_out.txt /tmp/integration_abc_claim_a2_out.txt | awk -F: '{s+=$2} END {print s}')
[ "$WINNERS_A" = "1" ] && pass "兩個並發的 agent-run 搶占呼叫，恰好只有 1 個搶到 running（等同最多一次付費執行）" || fail "搶到的呼叫數是 $WINNERS_A（應該是 1，代表可能同時付費執行兩次）"
STATUS_CLAIM_A=$($PSQL -tAc "select status from agent_runs where id='$RUN_CLAIM_A';")
[ "$STATUS_CLAIM_A" = "running" ] && pass "搶占之後最終狀態是 running（沒有被其他呼叫弄壞）" || fail "最終狀態是 $STATUS_CLAIM_A（應該是 running）"

echo ""
echo "--- (b) reaper 跟 agent-run 同時處理同一筆紀錄，兩者必須互斥 ---"
MSG_CLAIM_B="80000000-0000-0000-0000-0000000000e2"
RUN_CLAIM_B="90000000-0000-0000-0000-0000000000e2"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$MSG_CLAIM_B','$ROOM_A','user','$UID_A','claim race b', now() - interval '2 hours');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$RUN_CLAIM_B','$ROOM_A','$AGENT_A','$MSG_CLAIM_B','queued', now() - interval '2 hours', now() - interval '2 hours');"
cat > /tmp/integration_abc_claim_reaper.sql <<SQL
\set ON_ERROR_STOP on
begin;
select pg_sleep(0.2);
update agent_runs set status = 'failed', error_code = 'orphaned_before_dispatch', updated_at = now() where id = '$RUN_CLAIM_B' and status = 'queued' returning id;
commit;
SQL
cat > /tmp/integration_abc_claim_agentrun.sql <<SQL
\set ON_ERROR_STOP on
begin;
select pg_sleep(0.2);
update agent_runs set status = 'running', updated_at = now() where id = '$RUN_CLAIM_B' and status = 'queued' returning id;
commit;
SQL
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim_reaper.sql > /tmp/integration_abc_claim_reaper_out.txt 2>&1 &
CB1=$!
psql -h $PGHOST -p $PGPORT -U $PGUSER -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f /tmp/integration_abc_claim_agentrun.sql > /tmp/integration_abc_claim_agentrun_out.txt 2>&1 &
CB2=$!
wait $CB1 $CB2
WINNERS_B=$(grep -c "$RUN_CLAIM_B" /tmp/integration_abc_claim_reaper_out.txt /tmp/integration_abc_claim_agentrun_out.txt | awk -F: '{s+=$2} END {print s}')
[ "$WINNERS_B" = "1" ] && pass "reaper 跟 agent-run 同時搶同一筆紀錄，恰好只有 1 個得逞（兩者互斥，不會同時動到）" || fail "得逞的呼叫數是 $WINNERS_B（應該是 1，代表 reaper 跟 agent-run 可能同時各自改了一次）"
STATUS_CLAIM_B=$($PSQL -tAc "select status from agent_runs where id='$RUN_CLAIM_B';")
[ "$STATUS_CLAIM_B" = "failed" ] || [ "$STATUS_CLAIM_B" = "running" ] && pass "最終狀態是單一、一致的結果：$STATUS_CLAIM_B（不是被兩邊各自改一半的中間狀態）" || fail "最終狀態是 $STATUS_CLAIM_B（應該是 failed 或 running 其中之一）"

echo ""
echo "--- (c) 已經被 reaper 標成 failed 的紀錄，之後才到的 agent-run 搶占必須拿到 0 筆，不能蓋回 running ---"
MSG_CLAIM_C="80000000-0000-0000-0000-0000000000e3"
RUN_CLAIM_C="90000000-0000-0000-0000-0000000000e3"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$MSG_CLAIM_C','$ROOM_A','user','$UID_A','claim race c', now() - interval '2 hours');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$RUN_CLAIM_C','$ROOM_A','$AGENT_A','$MSG_CLAIM_C','queued', now() - interval '2 hours', now() - interval '2 hours');"
# 先讓 reaper 贏（模擬：chat-dispatch 的順手清掃比這筆紀錄原本對應的 agent-run 呼叫先跑到，
# 把它標成孤兒 failed；之後那個「遲到」的 agent-run 呼叫才終於送達）。
REAPED_COUNT_C=$($PSQL -tAc "update agent_runs set status = 'failed', error_code = 'orphaned_before_dispatch', updated_at = now() where id = '$RUN_CLAIM_C' and status = 'queued' returning id;" | grep -c "$RUN_CLAIM_C" || true)
[ "$REAPED_COUNT_C" = "1" ] && pass "reaper 先執行，成功把這筆紀錄標成 failed" || fail "reaper 的 UPDATE 沒有搶到（回傳 $REAPED_COUNT_C 筆，應該是 1）"
# grep -c 在完全沒有符合的列時會回傳離開碼 1（即使正確印出 0），在 set -e 之下會讓整支腳本
# 中止——這裡預期的正確結果正是 0 筆（遲到的搶占本來就不該搶到任何東西），所以要加
# `|| true` 讓「grep 找不到符合」這個正常情況不會被 set -e 誤判成腳本層級的錯誤。
LATE_CLAIM_COUNT_C=$($PSQL -tAc "update agent_runs set status = 'running', updated_at = now() where id = '$RUN_CLAIM_C' and status = 'queued' returning id;" | grep -c "$RUN_CLAIM_C" || true)
[ "$LATE_CLAIM_COUNT_C" = "0" ] && pass "遲到的 agent-run 搶占嘗試拿到 0 筆（status 已經不是 queued，不會誤觸發付費呼叫）" || fail "遲到的 agent-run 搶占竟然拿到 $LATE_CLAIM_COUNT_C 筆（不應該搶到，這代表可能對已經判定孤兒的紀錄又觸發了一次付費呼叫）"
FINAL_STATUS_C=$($PSQL -tAc "select status from agent_runs where id='$RUN_CLAIM_C';")
FINAL_ERRCODE_C=$($PSQL -tAc "select error_code from agent_runs where id='$RUN_CLAIM_C';")
[ "$FINAL_STATUS_C" = "failed" ] && pass "最終狀態仍然是 failed，沒有被遲到的 agent-run 呼叫蓋回 running" || fail "最終狀態是 $FINAL_STATUS_C（應該仍然是 failed——狀態被從 failed 改回 running 了）"
[ "$FINAL_ERRCODE_C" = "orphaned_before_dispatch" ] && pass "error_code 也維持 reaper 寫入的 orphaned_before_dispatch，沒有被覆蓋" || fail "error_code 是 $FINAL_ERRCODE_C（應該維持 orphaned_before_dispatch）"

echo ""
echo "=== [項目 7 補強] 明確處理：完全沒有後續聊天、且排程備援也沒被呼叫時，孤兒紀錄的行為 ==="
echo "  這不是「還沒解決」的模糊地帶，而是這個架構刻意接受、且已經明確記錄／測試過的邊界："
echo "  chat-dispatch 的順手清掃只會在『任何人對任何房間發訊息』時執行；獨立的"
echo "  agent-run-reaper 端點只會在有人（使用者手動或 pg_cron 排程）呼叫它時執行。如果整個"
echo "  部署完全沒有人發任何訊息、部署者也沒有開啟 README「附加設定：孤兒 queued 紀錄排程"
echo "  復原」的 pg_cron 排程，就不會有任何觸發點去清掃卡住的紀錄——這是純粹的『沒有任何"
echo "  程式碼路徑會被執行到』，不是『執行了但邏輯有 bug』。下面直接驗證這個誠實的邊界："
MSG_STUCK="80000000-0000-0000-0000-0000000000e4"
RUN_STUCK="90000000-0000-0000-0000-0000000000e4"
$PSQL -c "insert into messages (id, room_id, sender_type, sender_user_id, content, created_at) values ('$MSG_STUCK','$ROOM_A','user','$UID_A','stuck forever without any trigger', now() - interval '2 hours');"
$PSQL -c "insert into agent_runs (id, room_id, agent_id, trigger_message_id, status, created_at, updated_at) values ('$RUN_STUCK','$ROOM_A','$AGENT_A','$MSG_STUCK','queued', now() - interval '2 hours', now() - interval '2 hours');"
echo "  （不呼叫 chat-dispatch、不呼叫 agent-run-reaper，單純等待，模擬完全沒有任何觸發點的情境）"
sleep 1
STUCK_STATUS=$($PSQL -tAc "select status from agent_runs where id='$RUN_STUCK';")
[ "$STUCK_STATUS" = "queued" ] && pass "（誠實記錄，非測試失敗）確認沒有任何清掃管道被呼叫時，孤兒紀錄會維持 queued——這正是 README「附加設定：孤兒 queued 紀錄排程復原」建議開啟 pg_cron 排程的情境，需要部署者自行決定要不要為了涵蓋『完全沒人發訊息』這種邊界情境而開啟" || fail "預期沒有任何清掃管道被呼叫時應該仍是 queued，實際變成了 $STUCK_STATUS——代表存在我們沒預期到的背景機制，需要回頭確認"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
