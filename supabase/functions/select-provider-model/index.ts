// select-provider-model：使用者在「設定」頁選定某個供應商要用哪個模型。
// 對應 brainstorms/2026-09-22-provider-model-selection.md Q7/Q8/Q9：
// Anthropic 的選擇要順便同步這個使用者已經建好的 Managed Agent（如果有的話）。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";
import { getUserProviderKey } from "../_shared/vault.ts";
import { updateManagedAgentModel } from "../_shared/managedAgents.ts";

const PROVIDERS = ["anthropic", "openai", "google"] as const;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { provider, model } = await req.json();
    if (!PROVIDERS.includes(provider)) return jsonError("不支援的供應商", 400, headers);
    if (typeof model !== "string" || !model.trim()) return jsonError("請選擇一個模型", 400, headers);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();
    // 只有已經存過金鑰的 user_provider_keys 列才會被 update 到；沒有金鑰就沒有東西可以更新。
    const { data: updated, error: updateErr } = await admin
      .from("user_provider_keys")
      .update({ selected_model: model })
      .eq("user_id", user.id)
      .eq("provider", provider)
      .select("id")
      .maybeSingle();
    if (updateErr) {
      console.error("儲存模型偏好失敗", user.id, provider, updateErr);
      return jsonError("儲存模型偏好失敗，請稍後重試", 500, "internal_error", headers);
    }
    if (!updated) {
      return jsonError("請先設定這個供應商的 API key", 400, "missing_api_key", headers);
    }

    // 這步失敗不影響模型偏好本身已經存好（brainstorms/2026-09-22-provider-model-selection.md Q9）：
    // 還沒用過工作型代理的使用者沒有 Managed Agent 可以同步，下次第一次觸發時會直接用新選的模型建立。
    if (provider === "anthropic") {
      const { data: managedAgent } = await admin
        .from("user_managed_agents")
        .select("agent_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (managedAgent) {
        const apiKey = await getUserProviderKey(admin, user.id, "anthropic");
        if (apiKey) {
          try {
            await updateManagedAgentModel(apiKey, managedAgent.agent_id, model);
          } catch (err) {
            console.error("同步 Managed Agent 模型失敗", user.id, err);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (err) {
    console.error("select-provider-model 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
