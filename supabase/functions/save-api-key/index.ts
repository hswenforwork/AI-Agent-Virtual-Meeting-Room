// save-api-key：使用者在「設定」頁輸入自己的 AI API key。
// 對應 brainstorms/2026-09-22-user-api-key-settings.md Q6/Q8：
// 先對該供應商發一次最小額度的測試呼叫，成功才寫進 Supabase Vault；失敗不寫入，
// 回傳清楚區分「金鑰無效」「額度/速率問題」「供應商暫時無法回應」的錯誤。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { friendlyProviderError, jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";
import { createAnthropicProvider } from "../_shared/providers/anthropic.ts";
import { createOpenAIProvider } from "../_shared/providers/openai.ts";
import { createGoogleProvider } from "../_shared/providers/google.ts";
import { ProviderHttpError, type AIProvider } from "../_shared/providers/types.ts";

const DEFAULT_CLAUDE_MODEL = Deno.env.get("DEFAULT_CLAUDE_MODEL") ?? "claude-sonnet-5";
const DEFAULT_GPT_MODEL = Deno.env.get("DEFAULT_GPT_MODEL") ?? "gpt-5.1";
const DEFAULT_GEMINI_MODEL = Deno.env.get("DEFAULT_GEMINI_MODEL") ?? "gemini-2.5-flash";

const PROVIDERS = ["anthropic", "openai", "google"] as const;
type Provider = (typeof PROVIDERS)[number];

function providerFor(provider: Provider, apiKey: string): { adapter: AIProvider; model: string } {
  switch (provider) {
    case "anthropic":
      return { adapter: createAnthropicProvider(apiKey), model: DEFAULT_CLAUDE_MODEL };
    case "openai":
      return { adapter: createOpenAIProvider(apiKey), model: DEFAULT_GPT_MODEL };
    case "google":
      return { adapter: createGoogleProvider(apiKey), model: DEFAULT_GEMINI_MODEL };
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { provider, apiKey } = await req.json();
    if (!PROVIDERS.includes(provider)) return jsonError("不支援的供應商", 400, headers);
    if (typeof apiKey !== "string" || !apiKey.trim()) return jsonError("請輸入 API key", 400, headers);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const trimmedKey = apiKey.trim();
    const { adapter, model } = providerFor(provider, trimmedKey);

    try {
      await adapter.generate({
        systemPrompt: "你只需要回覆「測試成功」四個字，不要回覆其他任何內容。",
        messages: [{ role: "user", content: "這是一次金鑰有效性測試，請直接回覆指定內容。" }],
        model,
        maxOutputTokens: 16,
      });
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        const friendly = friendlyProviderError(err.status);
        return jsonError(friendly.message, 400, friendly.code, headers);
      }
      console.error("測試 API key 時發生未預期錯誤", provider, err);
      return jsonError("測試金鑰時發生未預期錯誤，請稍後重試", 500, "internal_error", headers);
    }

    const admin = supabaseAdmin();
    const { error: rpcErr } = await admin.rpc("set_user_provider_key", {
      p_user_id: user.id,
      p_provider: provider,
      p_secret: trimmedKey,
    });
    if (rpcErr) {
      console.error("寫入 API key 失敗", user.id, provider, rpcErr);
      return jsonError("儲存金鑰時發生錯誤，請稍後重試", 500, "internal_error", headers);
    }

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (err) {
    console.error("save-api-key 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
