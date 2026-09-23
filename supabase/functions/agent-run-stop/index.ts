// agent-run-stop：使用者按「停止」時呼叫，把指定的 agent_run 標成
// cancel_requested = true。真正中止呼叫中的供應商請求是 agent-run 自己在串流過程中
// 定期輪詢這個欄位、偵測到後 abort() 掉 fetch（見 agent-run/index.ts）；這裡只負責
// 驗證身分／房間權限，然後下這個旗標，不直接碰供應商 API。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { runId } = await req.json();
    if (!runId) return jsonError("缺少 runId", 400, headers);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();

    const { data: run, error: runErr } = await admin
      .from("agent_runs")
      .select("id, room_id, status")
      .eq("id", runId)
      .single();
    if (runErr || !run) return jsonError("找不到這個 run", 404, "not_found", headers);

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", run.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden", headers);

    if (run.status !== "queued" && run.status !== "running") {
      return new Response(JSON.stringify({ skipped: true }), { headers });
    }

    await admin.from("agent_runs").update({ cancel_requested: true }).eq("id", runId);

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (err) {
    console.error("agent-run-stop 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
