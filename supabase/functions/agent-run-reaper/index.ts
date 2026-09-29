// agent-run-reaper：項目 7 修正的排程備援。chat-dispatch 已經會在每次被呼叫時順手清掃
// 逾時仍卡在 queued 的 agent_runs（見 _shared/agentRunReaper.ts），但完全沒人發訊息的
// 房間永遠不會觸發那次順手清掃。這支獨立端點給 pg_cron 排程呼叫，邏輯借鏡
// knowledge-audit 的排程設計：只接受 service_role key（不會過期，適合放進長期排程，
// 不像使用者 JWT 一小時左右就會過期），見 README「附加設定：孤兒 queued 紀錄排程復原」。
//
// 跟 knowledge-audit 不同的是這裡不需要 ownerId——agent_runs 的孤兒判定（status='queued'
// 且逾時）是全站範圍的派送狀態，不是某個使用者名下的資料，不存在「service_role 拿到全部
// 人資料」的疑慮。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { reapStaleQueuedAgentRuns } from "../_shared/agentRunReaper.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    const isServiceRoleCall = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
    if (!isServiceRoleCall) {
      return jsonError("只接受 service_role 呼叫（排程用途，不開放一般使用者直接觸發）", 403, "forbidden", headers);
    }

    const admin = supabaseAdmin();
    const { reapedIds } = await reapStaleQueuedAgentRuns(admin);

    return new Response(JSON.stringify({ ok: true, reapedCount: reapedIds.length, reapedIds }), { headers });
  } catch (err) {
    console.error("agent-run-reaper 未預期錯誤", err);
    return jsonError("清掃時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
