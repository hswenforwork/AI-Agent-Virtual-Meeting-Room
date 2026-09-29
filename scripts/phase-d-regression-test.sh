#!/usr/bin/env bash
# 17 項修正計劃 D 階段（檔案儲存生命週期）：項目 5、11、12、15。
# 這支腳本以 PR #47（claude/integration-abc-17plan，含 A/B/C 三階段已整合的修正）
# 為基底，不是獨立以 main 為基底——沿用 PR #47 已經整合過的 approval-decide 原子
# 核准流程（pending -> executing -> executed/failed，見該檔案）跟 owner_id/status
# 驗證，這支腳本只補測 D 階段新增的部分，不重複驗證 PR #47 已經測過的核准原子性。
#
# 沿用 Phase A/B/C 已驗證過的「standalone PostgREST + 真實 Deno 執行未修改的 Edge
# Function 原始檔」本機測試基礎設施；Storage 沒有本機可用的服務，這裡額外加一個
# Storage HTTP API 的最小 stub（list／remove），讓 file-register／approval-decide
# 真的執行到會呼叫 Storage 的那段程式碼，不是只讀程式碼假設行為。
#
# 涵蓋：
#   - 項目 5：刪房後檔案下載（storage.objects 新增的 owner-based SELECT policy，
#     以及修改過、現在也會檢查 files.status='active' 的既有 room_files_select_member
#     policy）——直接用 psql 切換到 authenticated 角色＋設定 JWT claim 測試真正的
#     RLS 判斷式。
#   - 項目 11：檔案登記核對——真的執行 file-register/index.ts，Storage list() 回傳
#     可控制的假中繼資料。
#   - 項目 12：PDF 僅按需送出——純函式 isFileNameReferencedInText() 的單元測試，
#     額外驗證「只看觸發訊息、不看歷史對話」這個語意差異。
#   - 項目 15：Storage 清理——真的執行 approval-decide/index.ts 的 file.delete，
#     含「跨帳號刪檔不得移除 Storage 物件」的新測項（PR #48 審閱意見）。
#
# 用法：POSTGREST_BIN=/path/to/postgrest DENO_BIN=/path/to/deno ./scripts/phase-d-regression-test.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
PGDATABASE="${PGDATABASE:-phase_d_on_integration}"
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

echo "=== [項目 12] isFileNameReferencedInText() 純函式單元測試（不需要資料庫）==="
UNIT_TEST_TS="$WORKDIR/pdf_reference_unit_test.ts"
cat > "$UNIT_TEST_TS" <<DENO
import { isFileNameReferencedInText } from "$REPO_ROOT/supabase/functions/_shared/workspaceContext.ts";

function check(desc: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    console.log("PASS: " + desc);
  } else {
    console.log("FAIL: " + desc + "（預期 " + expected + "，實際 " + actual + "）");
    Deno.exit(1);
  }
}

check("觸發訊息直接提到完整檔名（含副檔名）", isFileNameReferencedInText("幫我看一下 季報.pdf 裡寫了什麼", "季報.pdf"), true);
check("觸發訊息只提到檔名本體、沒打副檔名", isFileNameReferencedInText("那份季報裡的數字對嗎", "季報.pdf"), true);
check("觸發訊息完全沒提到這份檔案", isFileNameReferencedInText("今天天氣如何", "季報.pdf"), false);
check("大小寫不敏感（英文檔名）", isFileNameReferencedInText("看一下 REPORT.PDF 這份文件", "report.pdf"), true);
check("檔名去掉副檔名後只剩 1 個字元，不納入比對避免誤判", isFileNameReferencedInText("這裡有個 a 字", "a.pdf"), false);

// PR #48 審閱意見：只依這次觸發訊息本身比對，不是整段對話歷史——這裡直接示範同一份
// 「歷史」文字如果被整段拿來比對會命中，但只傳入「這次的觸發訊息」就不會命中，
// 呼叫端（agent-run/index.ts）就是靠只傳入 triggerMessage.content 做到這件事。
const HISTORY_TEXT_WOULD_HAVE_MATCHED = "使用者上週提過 季報.pdf\\n使用者這次問：今天天氣如何";
const TRIGGER_MESSAGE_ONLY = "今天天氣如何";
check(
  "示範：整段歷史文字比對『會』命中（反例，agent-run 不會這樣呼叫）",
  isFileNameReferencedInText(HISTORY_TEXT_WOULD_HAVE_MATCHED, "季報.pdf"),
  true,
);
check(
  "只傳入這次觸發訊息本身時，同一份檔名『不會』命中——不會因為歷史上出現過就卡住重送",
  isFileNameReferencedInText(TRIGGER_MESSAGE_ONLY, "季報.pdf"),
  false,
);

console.log("=== 全部通過 ===");
DENO
"$DENO_BIN" run --node-modules-dir=none --allow-env "$UNIT_TEST_TS" > "$WORKDIR/unit_test.log" 2>&1 && UNIT_OK=1 || UNIT_OK=0
cat "$WORKDIR/unit_test.log"
[ "$UNIT_OK" = "1" ] && pass "isFileNameReferencedInText() 全部案例通過（見上方逐項輸出）" || fail "isFileNameReferencedInText() 單元測試失敗，見上方輸出"

echo ""
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
echo "  （storage.buckets 這次額外加上 file_size_limit／allowed_mime_types 兩個欄位，"
echo "  跟真實 Supabase Storage 的 schema 一致，讓 migrations/0027 的 update 語句能套用）"
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
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text, owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
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

echo "=== 依整合後的最終順序套用全部 migration（0001~0027，含 D 階段這次新增的 0027） ==="
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
echo "  （成功套用 0001~0027，確認 D 階段的 migration 能接在 PR #47 整合後的序列最後套用）"

echo ""
echo "=== [項目 11 前置] 確認 migrations/0027 真的把 bucket 限制寫進去了 ==="
BUCKET_LIMIT=$($PSQL -tAc "select file_size_limit from storage.buckets where id='room-files';")
BUCKET_MIMES=$($PSQL -tAc "select array_length(allowed_mime_types, 1) from storage.buckets where id='room-files';")
[ "$BUCKET_LIMIT" = "10485760" ] && pass "room-files bucket 的 file_size_limit 設定為 10485760（10MB）" || fail "file_size_limit 是 $BUCKET_LIMIT（應該是 10485760）"
[ "$BUCKET_MIMES" = "9" ] && pass "room-files bucket 的 allowed_mime_types 設定了 9 種類型" || fail "allowed_mime_types 筆數是 $BUCKET_MIMES（應該是 9）"

echo ""
echo "=== 建立測試帳號、房間、代理、檔案 ==="
UID_OWNER="00000000-0000-0000-0000-0000000000d1"
UID_OTHER="00000000-0000-0000-0000-0000000000d2"
$PSQL -c "insert into auth.users (id, email) values ('$UID_OWNER','owner@ci.local'), ('$UID_OTHER','other@ci.local');"
$PSQL -c "insert into profiles (id, display_name) values ('$UID_OWNER','Owner'), ('$UID_OTHER','Other') on conflict (id) do nothing;"
ROOM_D="10000000-0000-0000-0000-0000000000d1"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_D','$UID_OWNER','D room', true);"
$PSQL -c "insert into room_members (room_id, user_id, role) values ('$ROOM_D','$UID_OWNER','owner'), ('$ROOM_D','$UID_OTHER','member') on conflict (room_id, user_id) do nothing;"

OBJECT_PATH="$ROOM_D/2026/09/test-file.png"
$PSQL -c "insert into storage.objects (bucket_id, name, owner) values ('room-files','$OBJECT_PATH','$UID_OWNER');"
FILE_D="20000000-0000-0000-0000-0000000000d1"
$PSQL -c "insert into files (id, room_id, owner_id, bucket, object_path, name, mime_type, size_bytes, status, created_by) values ('$FILE_D','$ROOM_D','$UID_OWNER','room-files','$OBJECT_PATH','test-file.png','image/png',1000,'active','$UID_OWNER');"

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

echo ""
echo "=== [項目 5] 房間還在時，房間成員（含非擁有者）都能透過既有 policy 看到這個物件 ==="
STILL_MEMBER_VISIBLE=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OTHER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH';
")
[ "$STILL_MEMBER_VISIBLE" = "1" ] && pass "房間還在、非擁有者的房間成員可以看到這個物件（既有 room_files_select_member policy 沒有被破壞）" || fail "房間成員看到 $STILL_MEMBER_VISIBLE 筆（應該是 1）"

echo ""
echo "=== [項目 5，PR #48 審閱意見] 檔案軟刪除後，就算房間還在、使用者還是房間成員，"
echo "  修改過的 room_files_select_member 也不會再放行——soft delete 沒有真的清掉"
echo "  Storage 物件時，也不能讓任何人（不只是非擁有者，房間成員也一樣）繼續簽出新"
echo "  的下載網址 ==="
$PSQL -c "update files set status='deleted', deleted_at=now() where id='$FILE_D';"
MEMBER_VISIBLE_AFTER_SOFT_DELETE=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OTHER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH';
")
[ "$MEMBER_VISIBLE_AFTER_SOFT_DELETE" = "0" ] && pass "【修正生效】檔案軟刪除後，房間成員透過既有 room_files_select_member 也看不到了（修正前這裡會是 1，因為舊 policy 完全不看 files.status）" || fail "房間成員軟刪除後仍然看到 $MEMBER_VISIBLE_AFTER_SOFT_DELETE 筆（應該是 0，代表舊 policy 的 status 檢查沒有生效）"
OWNER_VISIBLE_AFTER_SOFT_DELETE=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OWNER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH';
")
[ "$OWNER_VISIBLE_AFTER_SOFT_DELETE" = "0" ] && pass "檔案軟刪除後，就算是擁有者，新 policy 也不再放行" || fail "擁有者軟刪除後仍然看到 $OWNER_VISIBLE_AFTER_SOFT_DELETE 筆（應該是 0）"
$PSQL -c "update files set status='active', deleted_at=null where id='$FILE_D';"

echo ""
echo "=== [項目 5] 房間被刪除後（room_members 連帶被刪光），檔案擁有者仍然能看到自己的物件 ==="
$PSQL -c "delete from rooms where id='$ROOM_D';"
MEMBERS_LEFT=$($PSQL -tAc "select count(*) from room_members where room_id='$ROOM_D';")
[ "$MEMBERS_LEFT" = "0" ] && pass "確認房間刪除後 room_members 真的被 cascade 刪光（模擬前提成立）" || fail "room_members 還有 $MEMBERS_LEFT 筆，測試前提不成立"
FILE_SURVIVED=$($PSQL -tAc "select room_id is null and status='active' from files where id='$FILE_D';")
[ "$FILE_SURVIVED" = "t" ] && pass "files 這一列如預期存活（room_id 被 SET NULL，status 仍是 active，0012 migration 的既有行為）" || fail "files 這一列的狀態不是預期的『room_id=null 且 active』"

OWNER_VISIBLE_AFTER_DELETE=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OWNER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH';
")
[ "$OWNER_VISIBLE_AFTER_DELETE" = "1" ] && pass "【修正生效】房間刪除後，檔案擁有者仍然能看到（進而能 createSignedUrl 下載）自己的物件——修正前這裡會是 0" || fail "擁有者看到 $OWNER_VISIBLE_AFTER_DELETE 筆（應該是 1，修正沒有生效）"

FORMER_MEMBER_VISIBLE_AFTER_DELETE=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OTHER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH';
")
[ "$FORMER_MEMBER_VISIBLE_AFTER_DELETE" = "0" ] && pass "非擁有者（前房間成員、不是這個檔案的 owner_id）房間刪除後看不到——新 policy 只保留給檔案擁有者，沒有過度放寬" || fail "非擁有者竟然看到 $FORMER_MEMBER_VISIBLE_AFTER_DELETE 筆（應該是 0，新 policy 不該對非擁有者放行）"

echo ""
echo "=== 啟動 postgrest（給下面的 Edge Function Deno 測試用）==="
JWT_SECRET="phase-d-test-secret-not-for-production"
CONF="$(mktemp)"
cat > "$CONF" <<EOF
db-uri = "postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 3611
EOF
"$POSTGREST_BIN" "$CONF" > "$WORKDIR/postgrest.log" 2>&1 &
POSTGREST_PID=$!
sleep 2

JWT_OWNER=$(sign_jwt authenticated "$UID_OWNER")
JWT_OTHER=$(sign_jwt authenticated "$UID_OTHER")
JWT_SERVICE=$(sign_jwt service_role)
JWT_ANON=$(sign_jwt anon)

echo "=== 啟動本機閘道（/rest/v1 -> postgrest, /auth/v1/user -> JWT 解碼, /storage/v1/object/* -> 假 Storage）==="
mkdir -p "$WORKDIR/gw"
STORAGE_LIST_RESPONSE_FILE="$WORKDIR/gw/storage_list_response.json"
STORAGE_REMOVE_MODE_FILE="$WORKDIR/gw/storage_remove_mode.txt"
echo "[]" > "$STORAGE_LIST_RESPONSE_FILE"
echo "ok" > "$STORAGE_REMOVE_MODE_FILE"
GATEWAY_TS="$WORKDIR/gw/gateway.ts"
cat > "$GATEWAY_TS" <<DENO
const POSTGREST = "http://localhost:3611";
const LIST_RESPONSE_FILE = "$STORAGE_LIST_RESPONSE_FILE";
const REMOVE_MODE_FILE = "$STORAGE_REMOVE_MODE_FILE";
const CALL_LOG_FILE = "$WORKDIR/gw/storage_call_log.txt";

function decodeJwt(auth) {
  if (!auth) return null;
  const token = auth.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

Deno.serve({ port: 3612 }, async (req) => {
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

  // 真實 Supabase storage-js 的 list()：POST /storage/v1/object/list/{bucketId}
  if (url.pathname.startsWith("/storage/v1/object/list/")) {
    const body = await req.text();
    await Deno.writeTextFile(CALL_LOG_FILE, \`LIST \${body}\n\`, { append: true });
    const responseBody = await Deno.readTextFile(LIST_RESPONSE_FILE);
    return new Response(responseBody, { headers: { "content-type": "application/json" } });
  }

  // 真實 Supabase storage-js 的 remove()：DELETE /storage/v1/object/{bucketId}，
  // body 是 { prefixes: [...] }
  if (url.pathname.startsWith("/storage/v1/object/") && req.method === "DELETE") {
    const body = await req.text();
    const mode = (await Deno.readTextFile(REMOVE_MODE_FILE)).trim();
    await Deno.writeTextFile(CALL_LOG_FILE, \`REMOVE \${url.pathname} \${body}\n\`, { append: true });
    if (mode === "ok") return new Response(JSON.stringify([{ name: "removed" }]), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "storage unavailable" }), { status: 500, headers: { "content-type": "application/json" } });
  }

  return new Response("not found", { status: 404 });
});
DENO
"$DENO_BIN" run --allow-net --allow-env --allow-read --allow-write "$GATEWAY_TS" > "$WORKDIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
sleep 2

cleanup() {
  kill "$POSTGREST_PID" "$GATEWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "=== [項目 11] file-register：Storage 真正記錄的物件不存在時，直接拒絕（不能登記一筆查無實體的檔案）==="
echo "[]" > "$STORAGE_LIST_RESPONSE_FILE"
FR_STUB="$WORKDIR/file_register_stub.ts"
cat > "$FR_STUB" <<DENO
await import("$REPO_ROOT/supabase/functions/file-register/index.ts");
DENO
(
  SUPABASE_URL=http://localhost:3612 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$FR_STUB" \
      > "$WORKDIR/file_register.log" 2>&1 &
  echo $! > "$WORKDIR/file_register.pid"
)
sleep 2
FR_PID=$(cat "$WORKDIR/file_register.pid")

ROOM_D2="10000000-0000-0000-0000-0000000000d2"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_D2','$UID_OWNER','D room 2', true);"
$PSQL -c "insert into room_members (room_id, user_id, role) values ('$ROOM_D2','$UID_OWNER','owner'), ('$ROOM_D2','$UID_OTHER','member') on conflict (room_id, user_id) do nothing;"

RESP_MISSING=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$ROOM_D2/2026/09/ghost.png\",\"name\":\"ghost.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1000}")
CODE_MISSING=$(echo "$RESP_MISSING" | tail -1)
echo "  回應（HTTP $CODE_MISSING）：$(echo "$RESP_MISSING" | head -n -1)"
[ "$CODE_MISSING" = "400" ] && pass "Storage 裡真的找不到這個物件時，file-register 拒絕登記（HTTP 400）" || fail "應該回 400，實際是 HTTP $CODE_MISSING"
GHOST_COUNT=$($PSQL -tAc "select count(*) from files where object_path='$ROOM_D2/2026/09/ghost.png';")
[ "$GHOST_COUNT" = "0" ] && pass "沒有留下任何『查無實體』的 files 紀錄" || fail "files 表裡竟然有 $GHOST_COUNT 筆查無實體的紀錄"

echo ""
echo "=== [項目 11] file-register：使用者宣稱的中繼資料跟 Storage 真正記錄的不一致時，以 Storage 真正記錄的為準 ==="
echo "  （PR #49 補強：這裡額外插入一筆 storage.objects，owner=呼叫者本人——上傳者驗證"
echo "  這一步現在會真的查 storage.objects.owner，這個測項本來就假設呼叫者是真正的"
echo "  上傳者，只是宣稱的中繼資料造假，不是在測上傳者核對本身）"
$PSQL -c "insert into storage.objects (bucket_id, name, owner) values ('room-files','$ROOM_D2/2026/09/real.png','$UID_OWNER');"
cat > "$STORAGE_LIST_RESPONSE_FILE" <<JSON
[{"name":"real.png","id":"$(node -e 'console.log(require("crypto").randomUUID())')","updated_at":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z","last_accessed_at":"2026-01-01T00:00:00Z","metadata":{"size":2048,"mimetype":"image/png"}}]
JSON
RESP_MISMATCH=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$ROOM_D2/2026/09/real.png\",\"name\":\"real.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1}")
CODE_MISMATCH=$(echo "$RESP_MISMATCH" | tail -1)
BODY_MISMATCH=$(echo "$RESP_MISMATCH" | head -n -1)
echo "  使用者宣稱 sizeBytes=1（明顯是謊報），Storage 真正記錄 size=2048，回應（HTTP $CODE_MISMATCH）：$BODY_MISMATCH"
[ "$CODE_MISMATCH" = "200" ] && pass "登記成功（謊報的欄位不會直接被當成拒絕理由，而是被真實值取代）" || fail "應該成功登記，實際是 HTTP $CODE_MISMATCH"
REGISTERED_SIZE=$($PSQL -tAc "select size_bytes from files where object_path='$ROOM_D2/2026/09/real.png';")
[ "$REGISTERED_SIZE" = "2048" ] && pass "資料庫裡實際存的 size_bytes 是 Storage 真正記錄的 2048，不是使用者謊報的 1" || fail "資料庫存的 size_bytes 是 $REGISTERED_SIZE（應該是 2048）"

echo ""
echo "=== [項目 11] file-register：Storage 真正記錄的物件超過 10MB 時要被拒絕，即使使用者宣稱的 sizeBytes 沒有超過 ==="
cat > "$STORAGE_LIST_RESPONSE_FILE" <<JSON
[{"name":"huge.png","id":"$(node -e 'console.log(require("crypto").randomUUID())')","updated_at":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z","last_accessed_at":"2026-01-01T00:00:00Z","metadata":{"size":99999999,"mimetype":"image/png"}}]
JSON
RESP_HUGE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$ROOM_D2/2026/09/huge.png\",\"name\":\"huge.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1000}")
CODE_HUGE=$(echo "$RESP_HUGE" | tail -1)
echo "  使用者宣稱 sizeBytes=1000，Storage 真正記錄 size=99999999，回應（HTTP $CODE_HUGE）：$(echo "$RESP_HUGE" | head -n -1)"
[ "$CODE_HUGE" = "400" ] && pass "Storage 真正記錄的物件超過 10MB，就算使用者宣稱的值沒超過，還是被拒絕（HTTP 400）——關住了『謊報小 size 繞過上限』的漏洞" || fail "應該回 400，實際是 HTTP $CODE_HUGE"
HUGE_COUNT=$($PSQL -tAc "select count(*) from files where object_path='$ROOM_D2/2026/09/huge.png';")
[ "$HUGE_COUNT" = "0" ] && pass "超過上限的物件沒有被登記進 files 表" || fail "files 表裡竟然有 $HUGE_COUNT 筆超過上限的紀錄"

echo ""
echo "=== [PR #49 審閱意見] file-register：同房間成員 A 不得把 B 已上傳的物件登記為自己的 ==="
echo "  （UID_OWNER=A，UID_OTHER=B，兩人都是 ROOM_D2 成員；storage.objects.owner 真正記錄"
echo "  的是 B——模擬 A 知道／猜到 B 已上傳的 object_path，呼叫 file-register 想登記成自己"
echo "  的檔案）"
STOLEN_PATH="$ROOM_D2/2026/09/stolen.png"
$PSQL -c "insert into storage.objects (bucket_id, name, owner) values ('room-files','$STOLEN_PATH','$UID_OTHER');"
cat > "$STORAGE_LIST_RESPONSE_FILE" <<JSON
[{"name":"stolen.png","id":"$(node -e 'console.log(require("crypto").randomUUID())')","updated_at":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z","last_accessed_at":"2026-01-01T00:00:00Z","metadata":{"size":1500,"mimetype":"image/png"}}]
JSON
RESP_STEAL=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$STOLEN_PATH\",\"name\":\"stolen.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1500}")
CODE_STEAL=$(echo "$RESP_STEAL" | tail -1)
echo "  A（房間成員，不是上傳者）嘗試登記 B 的物件，回應（HTTP $CODE_STEAL）：$(echo "$RESP_STEAL" | head -n -1)"
[ "$CODE_STEAL" = "403" ] && pass "【修正生效】A 不是真正的上傳者，file-register 拒絕登記（HTTP 403 not_uploader）——修正前這裡會是 200，B 的檔案會被 A 偷走" || fail "應該回 403 not_uploader，實際是 HTTP $CODE_STEAL"
STOLEN_COUNT=$($PSQL -tAc "select count(*) from files where object_path='$STOLEN_PATH';")
[ "$STOLEN_COUNT" = "0" ] && pass "沒有留下任何 owner_id=A 的冒名檔案紀錄" || fail "files 表裡竟然有 $STOLEN_COUNT 筆冒名登記的紀錄"

echo ""
echo "=== [PR #49 審閱意見] file-register：真正的上傳者 B 自己登記同一個物件要能成功 ==="
RESP_TRUE_OWNER=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OTHER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$STOLEN_PATH\",\"name\":\"stolen.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1500}")
CODE_TRUE_OWNER=$(echo "$RESP_TRUE_OWNER" | tail -1)
BODY_TRUE_OWNER=$(echo "$RESP_TRUE_OWNER" | head -n -1)
echo "  B（真正的上傳者）登記自己的物件，回應（HTTP $CODE_TRUE_OWNER）：$BODY_TRUE_OWNER"
[ "$CODE_TRUE_OWNER" = "200" ] && pass "真正的上傳者可以正常登記成功（HTTP 200）——修正沒有誤傷正常流程" || fail "應該回 200，實際是 HTTP $CODE_TRUE_OWNER"
TRUE_OWNER_ID=$($PSQL -tAc "select owner_id from files where object_path='$STOLEN_PATH';")
[ "$TRUE_OWNER_ID" = "$UID_OTHER" ] && pass "files 表裡這筆紀錄的 owner_id 正確是真正的上傳者 B" || fail "files 表的 owner_id 是 $TRUE_OWNER_ID（應該是 $UID_OTHER）"
STOLEN_FILE_ID=$(echo "$BODY_TRUE_OWNER" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).fileId)}catch{console.log("")}})')

echo ""
echo "=== [PR #49 審閱意見] file-register：同一個真正的上傳者重複呼叫（例如網路逾時重試）要冪等成功，不能留下重複列 ==="
echo "  （files(bucket, object_path) 現在有唯一約束，見 migrations/0027；insert 會打到"
echo "  23505 unique_violation，file-register 要能辨識『這是自己重試』而不是直接 500）"
RESP_RETRY=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OTHER" -H "Content-Type: application/json" -d "{\"roomId\":\"$ROOM_D2\",\"objectPath\":\"$STOLEN_PATH\",\"name\":\"stolen.png\",\"mimeType\":\"image/png\",\"sizeBytes\":1500}")
CODE_RETRY=$(echo "$RESP_RETRY" | tail -1)
BODY_RETRY=$(echo "$RESP_RETRY" | head -n -1)
echo "  B 對同一個 object_path 重複呼叫，回應（HTTP $CODE_RETRY）：$BODY_RETRY"
[ "$CODE_RETRY" = "200" ] && pass "同一個上傳者重試時冪等成功（HTTP 200），不是噴 500" || fail "應該回 200（冪等成功），實際是 HTTP $CODE_RETRY"
RETRY_FILE_ID=$(echo "$BODY_RETRY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).fileId)}catch{console.log("")}})')
[ "$RETRY_FILE_ID" = "$STOLEN_FILE_ID" ] && pass "重試回傳的 fileId 跟第一次登記的相同，是同一筆紀錄，不是新建的重複列" || fail "重試回傳的 fileId（$RETRY_FILE_ID）跟第一次（$STOLEN_FILE_ID）不一致"
DUPLICATE_ROW_COUNT=$($PSQL -tAc "select count(*) from files where object_path='$STOLEN_PATH';")
[ "$DUPLICATE_ROW_COUNT" = "1" ] && pass "files 表裡這個 object_path 仍然只有 1 筆紀錄（唯一約束生效，沒有留下重複列）" || fail "files 表裡這個 object_path 有 $DUPLICATE_ROW_COUNT 筆（應該是 1）"

echo ""
echo "=== [PR #49 審閱意見] files(bucket, object_path) 資料庫層確實有唯一約束（不只靠應用層擋）==="
CONSTRAINT_EXISTS=$($PSQL -tAc "select count(*) from pg_constraint where conname = 'files_bucket_object_path_key';")
[ "$CONSTRAINT_EXISTS" = "1" ] && pass "資料庫層確實存在 files_bucket_object_path_key 唯一約束" || fail "找不到 files_bucket_object_path_key 唯一約束（應用層即使有漏洞，資料庫也擋不住重複登記）"

kill "$FR_PID" 2>/dev/null || true
sleep 1

echo ""
echo "=== [PR #49 審閱意見] SECURITY DEFINER 函式的 RPC 暴露範圍：直接以 authenticated／anon 身分呼叫，不能讀到別人的 owner_id／status ==="
echo "  （room_file_is_active_owned_by_caller／room_file_is_active 兩個函式因為要給"
echo "  storage.objects 的 RLS policy 評估使用，authenticated／anon 一定要有 EXECUTE"
echo "  權限；PostgREST 會把它們自動掛成 /rpc/ 端點，這裡直接驗證『被當一般 RPC 呼叫』"
echo "  時，回傳的資訊範圍是不是真的已經縮小到不會洩漏跨使用者資訊）"
RPC_ACTIVE_AS_OTHER=$(curl -s -X POST "http://localhost:3611/rpc/room_file_is_active_owned_by_caller" -H "Authorization: Bearer $JWT_OTHER" -H "Content-Type: application/json" -d "{\"p_object_path\":\"$OBJECT_PATH\"}")
echo "  B（不是 $OBJECT_PATH 的擁有者）直接呼叫 room_file_is_active_owned_by_caller：$RPC_ACTIVE_AS_OTHER"
[ "$RPC_ACTIVE_AS_OTHER" = "false" ] && pass "非擁有者直接呼叫只會拿到 false，問不到『這個路徑其實是誰的、還在不在』" || fail "回傳 $RPC_ACTIVE_AS_OTHER（應該是 false）"

RPC_ACTIVE_AS_OWNER=$(curl -s -X POST "http://localhost:3611/rpc/room_file_is_active_owned_by_caller" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"p_object_path\":\"$OBJECT_PATH\"}")
echo "  A（真正的擁有者）直接呼叫 room_file_is_active_owned_by_caller：$RPC_ACTIVE_AS_OWNER"
[ "$RPC_ACTIVE_AS_OWNER" = "true" ] && pass "擁有者直接呼叫可以問到自己檔案的狀態（true），符合函式設計意圖——只能問自己的" || fail "回傳 $RPC_ACTIVE_AS_OWNER（應該是 true）"

echo ""
echo "=== [PR #49 審閱意見] room_files_storage_object_owner()（讀出真正上傳者）不能被一般使用者當 RPC 直接呼叫 ==="
echo "  （這個函式只給 service_role 用，authenticated／anon 呼叫應該直接被 Postgres 權限"
echo "  系統擋下來，不是『函式內部判斷後回傳空值』——這樣才能防止一般使用者用這支函式"
echo "  探測任意路徑背後的真正上傳者身分）"
RPC_OWNER_AS_AUTH=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:3611/rpc/room_files_storage_object_owner" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"p_bucket\":\"room-files\",\"p_object_path\":\"$OBJECT_PATH\"}")
CODE_RPC_OWNER_AUTH=$(echo "$RPC_OWNER_AS_AUTH" | tail -1)
echo "  authenticated 使用者直接呼叫，回應（HTTP $CODE_RPC_OWNER_AUTH）：$(echo "$RPC_OWNER_AS_AUTH" | head -n -1)"
[ "$CODE_RPC_OWNER_AUTH" != "200" ] && pass "authenticated 角色呼叫被 Postgres 權限系統拒絕（HTTP $CODE_RPC_OWNER_AUTH，不是 200）" || fail "authenticated 角色竟然可以直接呼叫成功（HTTP 200），洩漏了跨使用者的上傳者身分"

RPC_OWNER_AS_ANON=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:3611/rpc/room_files_storage_object_owner" -H "Authorization: Bearer $JWT_ANON" -H "Content-Type: application/json" -d "{\"p_bucket\":\"room-files\",\"p_object_path\":\"$OBJECT_PATH\"}")
CODE_RPC_OWNER_ANON=$(echo "$RPC_OWNER_AS_ANON" | tail -1)
echo "  anon 使用者直接呼叫，回應（HTTP $CODE_RPC_OWNER_ANON）：$(echo "$RPC_OWNER_AS_ANON" | head -n -1)"
[ "$CODE_RPC_OWNER_ANON" != "200" ] && pass "anon 角色呼叫也被拒絕（HTTP $CODE_RPC_OWNER_ANON，不是 200）" || fail "anon 角色竟然可以直接呼叫成功（HTTP 200）"

RPC_OWNER_AS_SERVICE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:3611/rpc/room_files_storage_object_owner" -H "Authorization: Bearer $JWT_SERVICE" -H "Content-Type: application/json" -d "{\"p_bucket\":\"room-files\",\"p_object_path\":\"$OBJECT_PATH\"}")
CODE_RPC_OWNER_SERVICE=$(echo "$RPC_OWNER_AS_SERVICE" | tail -1)
BODY_RPC_OWNER_SERVICE=$(echo "$RPC_OWNER_AS_SERVICE" | head -n -1)
echo "  service_role（file-register 實際使用的身分）直接呼叫，回應（HTTP $CODE_RPC_OWNER_SERVICE）：$BODY_RPC_OWNER_SERVICE"
[ "$CODE_RPC_OWNER_SERVICE" = "200" ] && [ "$BODY_RPC_OWNER_SERVICE" = "\"$UID_OWNER\"" ] && pass "service_role 呼叫成功，且正確讀出真正的上傳者 $UID_OWNER——函式本身邏輯正確，只是權限收得夠窄" || fail "service_role 呼叫結果不如預期（HTTP $CODE_RPC_OWNER_SERVICE，body：$BODY_RPC_OWNER_SERVICE）"

echo ""
echo "=== [項目 15] approval-decide 的 file.delete：DB 軟刪除成功後，真的會呼叫 Storage remove() ==="
echo "ok" > "$STORAGE_REMOVE_MODE_FILE"
rm -f "$WORKDIR/gw/storage_call_log.txt"
$PSQL -c "update files set status='active', deleted_at=null where id='$FILE_D';"
ROOM_D3="30000000-0000-0000-0000-0000000000d1"
$PSQL -c "insert into rooms (id, owner_id, name, title_generated) values ('$ROOM_D3','$UID_OWNER','D room 3', true);"
$PSQL -c "insert into room_members (room_id, user_id, role) values ('$ROOM_D3','$UID_OWNER','owner'), ('$ROOM_D3','$UID_OTHER','member') on conflict (room_id, user_id) do nothing;"
APR_OK="40000000-0000-0000-0000-0000000000d1"
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_OK','$ROOM_D3','$UID_OWNER','file.delete','{\"fileId\":\"$FILE_D\"}'::jsonb,'pending', now() + interval '1 hour');"

AD_STUB="$WORKDIR/approval_decide_stub.ts"
cat > "$AD_STUB" <<DENO
await import("$REPO_ROOT/supabase/functions/approval-decide/index.ts");
DENO
(
  SUPABASE_URL=http://localhost:3612 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$AD_STUB" \
      > "$WORKDIR/approval_decide.log" 2>&1 &
  echo $! > "$WORKDIR/approval_decide.pid"
)
sleep 2
AD_PID=$(cat "$WORKDIR/approval_decide.pid")

RESP_DELETE_OK=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APR_OK\",\"decision\":\"approved\"}")
CODE_DELETE_OK=$(echo "$RESP_DELETE_OK" | tail -1)
echo "  回應（HTTP $CODE_DELETE_OK）：$(echo "$RESP_DELETE_OK" | head -n -1)"
[ "$CODE_DELETE_OK" = "200" ] && pass "file.delete 核准成功（HTTP 200）" || fail "應該成功，實際是 HTTP $CODE_DELETE_OK"
FILE_STATUS_OK=$($PSQL -tAc "select status from files where id='$FILE_D';")
[ "$FILE_STATUS_OK" = "deleted" ] && pass "DB 層確實軟刪除成功（status=deleted）" || fail "檔案狀態是 $FILE_STATUS_OK（應該是 deleted）"
grep -q "REMOVE /storage/v1/object/room-files.*$OBJECT_PATH" "$WORKDIR/gw/storage_call_log.txt" && pass "真的呼叫了 Storage 的 remove()，帶正確的 bucket／object_path" || fail "沒有偵測到 Storage remove() 呼叫，或路徑不正確：$(cat "$WORKDIR/gw/storage_call_log.txt" 2>/dev/null)"
AUDIT_STORAGE_REMOVED=$($PSQL -tAc "select (metadata->>'storageRemoved')::boolean from audit_logs where action='file.delete.executed' order by created_at desc limit 1;")
[ "$AUDIT_STORAGE_REMOVED" = "t" ] && pass "audit_logs 正確記錄 storageRemoved=true，稽核紀錄本身就能看出這次清理成功" || fail "audit_logs 的 storageRemoved 是 $AUDIT_STORAGE_REMOVED（應該是 true）"

kill "$AD_PID" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 15，PR #48 審閱意見] 跨帳號刪檔：不是自己的檔案，approval-decide 必須"
echo "  在 DB 層就拒絕，不能讓 Storage remove() 有機會被呼叫到 ==="
echo "  （沿用 PR #47 已整合的項目 2 修正：executeTool 的 UPDATE 帶 owner_id=核准者本人"
echo "  的條件，跨帳號時這裡會拿到 0 筆、直接 throw；這裡驗證的是 D 階段新增的 Storage"
echo "  remove() 呼叫緊接在同一個 executeTool 裡，順序上一定在那個 throw 之後，"
echo "  不會在 DB 拒絕之後還是把實體物件清掉）"
rm -f "$WORKDIR/gw/storage_call_log.txt"
$PSQL -c "insert into storage.objects (bucket_id, name, owner) values ('room-files','$OBJECT_PATH-cross','$UID_OWNER');"
FILE_CROSS="20000000-0000-0000-0000-0000000000d3"
$PSQL -c "insert into files (id, room_id, owner_id, bucket, object_path, name, mime_type, size_bytes, status, created_by) values ('$FILE_CROSS','$ROOM_D3','$UID_OWNER','room-files','$OBJECT_PATH-cross','owner-only.png','image/png',1000,'active','$UID_OWNER');"
APR_CROSS="40000000-0000-0000-0000-0000000000d3"
# 核准請求本身由 UID_OTHER 發起（模擬「房間成員自己組一筆核准請求，fileId 填別人的
# 檔案」，跟 PR #47/approval-decide 檔案開頭註解描述的原始漏洞情境一致），approve
# 時也是 UID_OTHER 自己核准自己發起的這筆請求。
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_CROSS','$ROOM_D3','$UID_OTHER','file.delete','{\"fileId\":\"$FILE_CROSS\"}'::jsonb,'pending', now() + interval '1 hour');"

(
  SUPABASE_URL=http://localhost:3612 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$AD_STUB" \
      > "$WORKDIR/approval_decide_cross.log" 2>&1 &
  echo $! > "$WORKDIR/approval_decide_cross.pid"
)
sleep 2
AD_PID_CROSS=$(cat "$WORKDIR/approval_decide_cross.pid")

RESP_CROSS=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OTHER" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APR_CROSS\",\"decision\":\"approved\"}")
CODE_CROSS=$(echo "$RESP_CROSS" | tail -1)
echo "  回應（HTTP $CODE_CROSS）：$(echo "$RESP_CROSS" | head -n -1)"
[ "$CODE_CROSS" = "500" ] && pass "跨帳號刪檔在 DB 層被拒絕（HTTP 500，execution_failed，延續 PR #47 的既有行為）" || fail "應該回 500，實際是 HTTP $CODE_CROSS"
FILE_STATUS_CROSS=$($PSQL -tAc "select status from files where id='$FILE_CROSS';")
[ "$FILE_STATUS_CROSS" = "active" ] && pass "檔案在 DB 層仍然是 active，沒有被跨帳號核准動到" || fail "檔案狀態是 $FILE_STATUS_CROSS（應該仍是 active）"
if [ -f "$WORKDIR/gw/storage_call_log.txt" ] && grep -q "REMOVE" "$WORKDIR/gw/storage_call_log.txt"; then
  fail "【嚴重】跨帳號刪檔被 DB 拒絕了，但 Storage remove() 竟然還是被呼叫到：$(cat "$WORKDIR/gw/storage_call_log.txt")"
else
  pass "【修正驗證】跨帳號刪檔被 DB 拒絕後，Storage remove() 完全沒有被呼叫——不會出現『DB 說不是你的檔案，但物件還是被清掉』這種矛盾狀態"
fi
STORAGE_OBJECT_STILL_THERE=$($PSQL -tAc "select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH-cross';")
[ "$STORAGE_OBJECT_STILL_THERE" = "1" ] && pass "Storage 物件本身也還在（沒有被跨帳號核准間接清掉）" || fail "Storage 物件竟然消失了（應該還在，count=$STORAGE_OBJECT_STILL_THERE）"

kill "$AD_PID_CROSS" 2>/dev/null || true
sleep 1

echo ""
echo "=== [項目 15] approval-decide 的 file.delete：Storage remove() 失敗時，DB 軟刪除仍然成功、approval 仍然回報 executed ==="
echo "  （安全關鍵的那一步——收回存取權限的 DB 狀態——已經達成；Storage 清理失敗是"
echo "  『這次沒清乾淨』，不是『這次刪除操作失敗』，兩者要分開回報，不能因為清理步驟"
echo "  失敗就讓使用者以為檔案根本沒被刪除、又手動重試一次核准。就算清理失敗，這裡"
echo "  同時驗證修改過的 room_files_select_member／room_files_select_owner 兩條"
echo "  policy 都已經因為 files.status 不是 active 而不再放行，不依賴 Storage 清理"
echo "  是否成功）"
echo "fail" > "$STORAGE_REMOVE_MODE_FILE"
rm -f "$WORKDIR/gw/storage_call_log.txt"
$PSQL -c "insert into storage.objects (bucket_id, name, owner) values ('room-files','$OBJECT_PATH-2','$UID_OWNER');"
FILE_D2="20000000-0000-0000-0000-0000000000d2"
$PSQL -c "insert into files (id, room_id, owner_id, bucket, object_path, name, mime_type, size_bytes, status, created_by) values ('$FILE_D2','$ROOM_D3','$UID_OWNER','room-files','$OBJECT_PATH-2','test-file-2.png','image/png',1000,'active','$UID_OWNER');"
APR_FAIL="40000000-0000-0000-0000-0000000000d2"
$PSQL -c "insert into approval_requests (id, room_id, requested_by, tool_name, arguments_json, status, expires_at) values ('$APR_FAIL','$ROOM_D3','$UID_OWNER','file.delete','{\"fileId\":\"$FILE_D2\"}'::jsonb,'pending', now() + interval '1 hour');"

(
  SUPABASE_URL=http://localhost:3612 \
  SUPABASE_SERVICE_ROLE_KEY="$JWT_SERVICE" \
  SUPABASE_ANON_KEY="$JWT_ANON" \
  ALLOWED_ORIGINS=http://localhost:5173 \
    "$DENO_BIN" run --node-modules-dir=none --allow-net --allow-env "$AD_STUB" \
      > "$WORKDIR/approval_decide2.log" 2>&1 &
  echo $! > "$WORKDIR/approval_decide2.pid"
)
sleep 2
AD_PID2=$(cat "$WORKDIR/approval_decide2.pid")

RESP_DELETE_FAIL=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:8000/" -H "Authorization: Bearer $JWT_OWNER" -H "Content-Type: application/json" -d "{\"approvalId\":\"$APR_FAIL\",\"decision\":\"approved\"}")
CODE_DELETE_FAIL=$(echo "$RESP_DELETE_FAIL" | tail -1)
echo "  回應（HTTP $CODE_DELETE_FAIL）：$(echo "$RESP_DELETE_FAIL" | head -n -1)"
[ "$CODE_DELETE_FAIL" = "200" ] && pass "即使 Storage remove() 失敗，approval 仍然回報成功（HTTP 200，安全關鍵的 DB 狀態已經達成）" || fail "應該仍然是 HTTP 200，實際是 HTTP $CODE_DELETE_FAIL"
FILE_STATUS_FAIL=$($PSQL -tAc "select status from files where id='$FILE_D2';")
[ "$FILE_STATUS_FAIL" = "deleted" ] && pass "DB 層仍然確實軟刪除成功（status=deleted），不受 Storage 失敗影響" || fail "檔案狀態是 $FILE_STATUS_FAIL（應該仍是 deleted）"
AUDIT_STORAGE_FAILED=$($PSQL -tAc "select (metadata->>'storageRemoved')::boolean from audit_logs where action='file.delete.executed' order by created_at desc limit 1;")
[ "$AUDIT_STORAGE_FAILED" = "f" ] && pass "audit_logs 誠實記錄 storageRemoved=false，之後人工排查 Storage 用量時可以直接查出這筆沒清乾淨" || fail "audit_logs 的 storageRemoved 是 $AUDIT_STORAGE_FAILED（應該是 false，如實記錄清理失敗）"
APR_STATUS_FAIL=$($PSQL -tAc "select status from approval_requests where id='$APR_FAIL';")
[ "$APR_STATUS_FAIL" = "executed" ] && pass "approval_requests 狀態是 executed（不是 failed）——核准動作本身沒有失敗" || fail "approval_requests 狀態是 $APR_STATUS_FAIL（應該是 executed）"

# 就算這次清理沒成功，DB 層的 status 已經不是 active，兩條 policy 應該都已經不放行了。
MEMBER_VISIBLE_AFTER_CLEANUP_FAIL=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OTHER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH-2';
")
[ "$MEMBER_VISIBLE_AFTER_CLEANUP_FAIL" = "0" ] && pass "Storage 清理失敗時，房間成員也已經看不到這個物件了（存取權限只看 DB 的 files.status，不依賴清理是否成功）" || fail "房間成員竟然還看得到 $MEMBER_VISIBLE_AFTER_CLEANUP_FAIL 筆"
OWNER_VISIBLE_AFTER_CLEANUP_FAIL=$($PSQL -tAc "
  set local role authenticated;
  set local request.jwt.claim.sub = '$UID_OWNER';
  select count(*) from storage.objects where bucket_id='room-files' and name='$OBJECT_PATH-2';
")
[ "$OWNER_VISIBLE_AFTER_CLEANUP_FAIL" = "0" ] && pass "Storage 清理失敗時，就算是擁有者也已經看不到了" || fail "擁有者竟然還看得到 $OWNER_VISIBLE_AFTER_CLEANUP_FAIL 筆"

kill "$AD_PID2" 2>/dev/null || true
sleep 1

echo ""
if [ "$FAIL" = "0" ]; then
  echo "=== 全部通過 ==="
  exit 0
else
  echo "=== 有測項失敗，見上面 FAIL 標記 ==="
  exit 1
fi
