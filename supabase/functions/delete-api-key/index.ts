// delete-api-key：使用者在「設定」頁移除自己的一把 API key。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const PROVIDERS = ["anthropic", "openai", "google"] as const;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated");

    const { provider } = await req.json();
    if (!PROVIDERS.includes(provider)) return jsonError("不支援的供應商", 400);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated");

    const admin = supabaseAdmin();
    const { error: rpcErr } = await admin.rpc("delete_user_provider_key", {
      p_user_id: user.id,
      p_provider: provider,
    });
    if (rpcErr) {
      console.error("刪除 API key 失敗", user.id, provider, rpcErr);
      return jsonError("刪除金鑰時發生錯誤，請稍後重試", 500, "internal_error");
    }

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (err) {
    console.error("delete-api-key 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error");
  }
});
