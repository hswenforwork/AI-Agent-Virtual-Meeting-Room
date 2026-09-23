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
      .select("id, room_id, tool_name, arguments_json, status, expires_at")
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

    // 過期檢查：expires_at 有設定且已經過了，一律當成過期，不再進入下面的原子搶占。
    // 這裡先把它標成 expired（條件式 update，跟下面搶占用同一個手法，避免跟另一個
    // 同時進來的請求互相覆蓋彼此的終態），標記成功與否都直接回覆過期，不繼續往下執行。
    if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now()) {
      await admin
        .from("approval_requests")
        .update({ status: "expired" })
        .eq("id", approvalId)
        .eq("status", "pending");
      return jsonError("這個核准請求已經過期", 410, "expired", headers);
    }

    if (decision === "rejected") {
      // 原子搶占：只有「目前還是 pending」的那一列會被這個 UPDATE 動到，PostgreSQL
      // 保證同一筆列的並發 UPDATE 只有一個交易能搶到，另一個會等鎖、甦醒後看到
      // status 已經不是 pending，這個條件式 update 影響 0 筆，not claimed。
      const { data: claimed, error: claimErr } = await admin
        .from("approval_requests")
        .update({ status: "rejected" })
        .eq("id", approvalId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claimed) return jsonError("這個請求已經處理過了", 409, "already_decided", headers);

      await admin.from("audit_logs").insert({
        room_id: approval.room_id,
        actor_type: "user",
        actor_id: user.id,
        action: `${approval.tool_name}.rejected`,
        metadata: approval.arguments_json,
      });
      return new Response(JSON.stringify({ status: "rejected" }), { headers });
    }

    // decision === "approved"：先原子搶占 pending -> executing，搶到的那一個才會真的
    // 執行工具；搶不到（0 筆）代表已經有另一個請求正在處理或已經處理完，直接回 409，
    // 不會重複執行（項目 8 的核心修正——舊版本是「先 SELECT 判斷、再分開 UPDATE」，
    // 兩個同時送出的請求都可能讀到同一個 pending，各自執行一次高風險操作；
    // 實測：兩個同時核准同一筆 approval，file.delete 被執行兩次，PR 說明有附重現紀錄）。
    const { data: claimed, error: claimErr } = await admin
      .from("approval_requests")
      .update({ status: "executing" })
      .eq("id", approvalId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) return jsonError("這個請求已經處理過了", 409, "already_decided", headers);

    try {
      await executeTool(admin, approval.tool_name, approval.arguments_json, user.id);
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
  approverId: string,
) {
  if (toolName === "file.delete") {
    const fileId = args.fileId as string;
    if (!fileId) throw new Error("缺少 fileId");
    // 項目 2 修正：原本只憑 arguments_json.fileId 直接 update，完全沒驗證這個檔案是不是
    // 核准者自己的——approval_requests 的 insert policy 只檢查「這一列的 room_id 是自己
    // 有權限的房間」，不會檢查 arguments_json 裡任意塞的 fileId 指向誰的檔案，任何房間
    // 成員都可以幫自己的房間建一筆核准請求、卻在 fileId 填別人的檔案 id，核准後就會把
    // 別人的檔案刪掉（實測重現，見 PR 說明）。
    // 修正：update 條件加上 owner_id = 核准者本人、status = active；如果沒有任何一筆
    // 符合（檔案不存在、不是自己的、或已經是 deleted），一律當成失敗，不能默默回報成功
    // ——用 .select().maybeSingle() 確認實際有動到列，而不是只看 error 是否為 null
    // （Supabase/PostgREST 的 update 在 0 筆符合條件時不會回傳 error，需要另外檢查）。
    const { data, error } = await admin
      .from("files")
      .update({ status: "deleted", deleted_at: new Date().toISOString() })
      .eq("id", fileId)
      .eq("owner_id", approverId)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("找不到可刪除的檔案，或這個檔案不屬於你");
    return;
  }
  throw new Error(`未知的工具：${toolName}`);
}
