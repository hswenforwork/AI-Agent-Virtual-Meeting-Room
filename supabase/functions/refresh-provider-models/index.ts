// refresh-provider-models：使用者在「設定」頁按「重新整理清單」，
// 用已經存好的金鑰重抓模型清單（不需要重新輸入金鑰）。
// 對應 brainstorms/2026-09-22-provider-model-selection.md Q4。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";
import { createProviderAdapter } from "../_shared/providers/index.ts";
import { refreshCachedModels } from "../_shared/modelCache.ts";
import { getUserProviderKey, type ProviderSlug } from "../_shared/vault.ts";

const PROVIDERS = ["anthropic", "openai", "google"] as const;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { provider } = await req.json();
    if (!PROVIDERS.includes(provider)) return jsonError("不支援的供應商", 400, headers);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();
    const apiKey = await getUserProviderKey(admin, user.id, provider as ProviderSlug);
    if (!apiKey) return jsonError("尚未設定這個供應商的 API key", 400, "missing_api_key", headers);

    const adapter = createProviderAdapter(provider as ProviderSlug, apiKey);
    const models = await refreshCachedModels(admin, user.id, provider as ProviderSlug, adapter);
    if (models === null) {
      return jsonError("重新整理模型清單失敗，請稍後重試", 500, "internal_error", headers);
    }

    return new Response(JSON.stringify({ ok: true, models }), { headers });
  } catch (err) {
    console.error("refresh-provider-models 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
