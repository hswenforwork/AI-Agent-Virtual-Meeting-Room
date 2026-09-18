// chat-dispatch：驗證訊息、依結構化 @mention 決定要啟動哪些代理，建立 agent_runs，
// 再逐一觸發 agent-run。對應 docs/MVP規劃-v2.md 第 3.1 節第 4 點的點名路由邏輯：
//   沒有 @：只有主管代理（is_supervisor=true，MVP 綁定 Claude）回覆
//   有 @：只有被點名且 status=active 的供應商回覆，主管代理當輪不參與

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const MAX_AGENT_RUNS_PER_MESSAGE = Number(Deno.env.get("MAX_AGENT_RUNS_PER_MESSAGE") ?? "4");

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated");

    const { messageId } = await req.json();
    if (!messageId) return jsonError("缺少 messageId", 400);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated");

    const admin = supabaseAdmin();

    const { data: message, error: messageErr } = await admin
      .from("messages")
      .select("id, room_id, sender_user_id, sender_type")
      .eq("id", messageId)
      .single();

    if (messageErr || !message) return jsonError("找不到這則訊息", 404, "not_found");
    if (message.sender_type !== "user" || message.sender_user_id !== user.id) {
      return jsonError("您沒有這則訊息的權限", 403, "forbidden");
    }

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", message.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden");

    const { data: mentions } = await admin
      .from("message_mentions")
      .select("agent_id")
      .eq("message_id", messageId);

    let targetAgentIds = (mentions ?? []).map((m) => m.agent_id);
    let notices: string[] = [];

    if (targetAgentIds.length === 0) {
      const { data: supervisor } = await admin
        .from("agents")
        .select("id")
        .eq("room_id", message.room_id)
        .eq("is_supervisor", true)
        .eq("status", "active")
        .maybeSingle();
      if (supervisor) targetAgentIds = [supervisor.id];
    } else {
      const { data: targetAgents } = await admin
        .from("agents")
        .select("id, name, status")
        .in("id", targetAgentIds);

      const activeIds = new Set(
        (targetAgents ?? []).filter((a) => a.status === "active").map((a) => a.id),
      );
      const inactiveNames = (targetAgents ?? [])
        .filter((a) => a.status !== "active")
        .map((a) => a.name);

      if (inactiveNames.length > 0) {
        notices.push(`${inactiveNames.join("、")} 尚未啟用（尚未設定 API key），暫時無法回覆。`);
      }
      targetAgentIds = targetAgentIds.filter((id) => activeIds.has(id));
    }

    if (targetAgentIds.length > MAX_AGENT_RUNS_PER_MESSAGE) {
      targetAgentIds = targetAgentIds.slice(0, MAX_AGENT_RUNS_PER_MESSAGE);
      notices.push(`一次最多同時點名 ${MAX_AGENT_RUNS_PER_MESSAGE} 位代理，其餘已略過。`);
    }

    if (notices.length > 0) {
      await admin.from("messages").insert({
        room_id: message.room_id,
        sender_type: "system",
        content: notices.join("\n"),
        status: "completed",
      });
    }

    const runIds: string[] = [];
    for (const agentId of targetAgentIds) {
      const { data: run, error: runErr } = await admin
        .from("agent_runs")
        .insert({
          room_id: message.room_id,
          agent_id: agentId,
          trigger_message_id: messageId,
          status: "queued",
        })
        .select("id")
        .single();

      if (runErr || !run) {
        console.error("建立 agent_run 失敗", runErr);
        continue;
      }
      runIds.push(run.id);
    }

    const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const internalSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 依序觸發，避免免費/低額度層瞬間打滿 RPM（對應原始規劃文件 12.3 節）
    for (const runId of runIds) {
      fetch(`${functionsBase}/agent-run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${internalSecret}`,
        },
        body: JSON.stringify({ runId }),
      }).catch((err) => console.error("觸發 agent-run 失敗", runId, err));
    }

    return new Response(JSON.stringify({ runIds }), { headers });
  } catch (err) {
    console.error("chat-dispatch 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error");
  }
});
