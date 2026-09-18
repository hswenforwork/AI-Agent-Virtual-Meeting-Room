// approval-decide：核准／拒絕高風險操作（目前僅 file.delete），核准後立即執行並寫入稽核紀錄。
// 對應 docs/MVP規劃-v2.md Q12：低風險寫入（記事/待辦）不經過這裡，只有刪除/批次修改才需要。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated");

    const { approvalId, decision } = await req.json();
    if (!approvalId || !["approved", "rejected"].includes(decision)) {
      return jsonError("參數不正確", 400);
    }

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated");

    const admin = supabaseAdmin();

    const { data: approval, error: approvalErr } = await admin
      .from("approval_requests")
      .select("id, room_id, tool_name, arguments_json, status")
      .eq("id", approvalId)
      .single();
    if (approvalErr || !approval) return jsonError("找不到這個核准請求", 404, "not_found");

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", approval.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden");

    if (approval.status !== "pending") {
      return jsonError("這個請求已經處理過了", 409, "already_decided");
    }

    if (decision === "rejected") {
      await admin.from("approval_requests").update({ status: "rejected" }).eq("id", approvalId);
      await admin.from("audit_logs").insert({
        room_id: approval.room_id,
        actor_type: "user",
        actor_id: user.id,
        action: `${approval.tool_name}.rejected`,
        metadata: approval.arguments_json,
      });
      return new Response(JSON.stringify({ status: "rejected" }), { headers });
    }

    // decision === "approved"
    try {
      await executeTool(admin, approval.tool_name, approval.arguments_json);
      await admin.from("approval_requests").update({ status: "executed" }).eq("id", approvalId);
      await admin.from("audit_logs").insert({
        room_id: approval.room_id,
        actor_type: "user",
        actor_id: user.id,
        action: `${approval.tool_name}.executed`,
        metadata: approval.arguments_json,
      });
      return new Response(JSON.stringify({ status: "executed" }), { headers });
    } catch (execErr) {
      console.error("執行核准動作失敗", execErr);
      await admin.from("approval_requests").update({ status: "failed" }).eq("id", approvalId);
      return jsonError("執行失敗，請稍後重試", 500, "execution_failed");
    }
  } catch (err) {
    console.error("approval-decide 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error");
  }
});

async function executeTool(
  admin: ReturnType<typeof supabaseAdmin>,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (toolName === "file.delete") {
    const fileId = args.fileId as string;
    if (!fileId) throw new Error("缺少 fileId");
    // 軟刪除：先標記 deleted_at，物件本身之後由排程清理（對應原始規劃文件 7.5 節）
    const { error } = await admin
      .from("files")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })
      .eq("id", fileId);
    if (error) throw error;
    return;
  }
  throw new Error(`未知的工具：${toolName}`);
}
