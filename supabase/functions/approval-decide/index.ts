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
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { approvalId, decision } = await req.json();
    if (!approvalId || !["approved", "rejected"].includes(decision)) {
      return jsonError("參數不正確", 400, headers);
    }

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();

    const { data: approval, error: approvalErr } = await admin
      .from("approval_requests")
      .select("id, room_id, tool_name, arguments_json, status")
      .eq("id", approvalId)
      .single();
    if (approvalErr || !approval) return jsonError("找不到這個核准請求", 404, "not_found", headers);

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", approval.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden", headers);

    if (approval.status !== "pending") {
      return jsonError("這個請求已經處理過了", 409, "already_decided", headers);
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
      const executionResult = await executeTool(admin, approval.tool_name, approval.arguments_json);
      await admin.from("approval_requests").update({ status: "executed" }).eq("id", approvalId);
      await admin.from("audit_logs").insert({
        room_id: approval.room_id,
        actor_type: "user",
        actor_id: user.id,
        action: `${approval.tool_name}.executed`,
        metadata: { ...approval.arguments_json, ...executionResult },
      });
      return new Response(JSON.stringify({ status: "executed" }), { headers });
    } catch (execErr) {
      console.error("執行核准動作失敗", execErr);
      await admin.from("approval_requests").update({ status: "failed" }).eq("id", approvalId);
      return jsonError("執行失敗，請稍後重試", 500, "execution_failed", headers);
    }
  } catch (err) {
    console.error("approval-decide 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});

async function executeTool(
  admin: ReturnType<typeof supabaseAdmin>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName === "file.delete") {
    const fileId = args.fileId as string;
    if (!fileId) throw new Error("缺少 fileId");
    // 軟刪除：先標記 deleted_at，資料庫層的存取權限立刻收回（RLS／應用層查詢都篩
    // status='active'），這一步失敗就整個 throw，approval 標成 failed，不會有任何
    // 副作用發生。
    const { data, error } = await admin
      .from("files")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })
      .eq("id", fileId)
      .select("bucket, object_path")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("找不到要刪除的檔案");

    // 項目 15 修正（Storage 清理）：原本這裡的註解寫著「物件本身之後由排程清理」，
    // 但這個排程從來沒有真的做出來——soft delete 只讓 files 這一列在應用層看起來
    // 消失，Storage 裡的實體物件（跟它佔用的空間）永遠留著，也還是能靠這個物件的
    // 路徑透過 room_files_select_member／room_files_select_owner 這兩條 RLS policy
    // 繼續被下載（只要呼叫端還是房間成員或檔案擁有者），soft delete 並沒有真的收回
    // 下載權限，只有列表看不到而已。
    //
    // 這裡在資料庫狀態已經確定改成 deleted 之後，才嘗試真的刪除 Storage 物件——
    // 這一步失敗（例如物件已經不存在、Storage 服務暫時不可用）不應該讓整個
    // file.delete 核准回報失敗，因為安全關鍵的那一步（收回存取權限的 DB 狀態）已經
    // 成功了；失敗與否都記錄進回傳值，由呼叫端寫進 audit_logs，讓之後要人工排查
    // Storage 用量／孤兒物件時，稽核紀錄本身就能看出哪些刪除當下沒有真的清乾淨，
    // 不必另外去比對 Storage 使用量才發現有清理失敗的個案。
    const { error: removeErr } = await admin.storage.from(data.bucket).remove([data.object_path]);
    if (removeErr) {
      console.error("刪除 Storage 物件失敗（資料庫狀態已經標成 deleted）", data.bucket, data.object_path, removeErr);
    }
    return { storageRemoved: !removeErr };
  }
  throw new Error(`未知的工具：${toolName}`);
}
