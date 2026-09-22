// 抓取並快取某個使用者、某個供應商的模型清單。
// 對應 brainstorms/2026-09-22-provider-model-selection.md：清單抓取失敗不應該讓
// 呼叫端的主要流程（存金鑰、手動重新整理）跟著失敗，錯誤只記錄、回傳 null。

import type { AIProvider, ModelOption } from "./providers/types.ts";
import type { supabaseAdmin } from "./supabaseAdmin.ts";
import type { ProviderSlug } from "./vault.ts";

export async function refreshCachedModels(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  provider: ProviderSlug,
  adapter: AIProvider,
): Promise<ModelOption[] | null> {
  try {
    const models = await adapter.listModels();
    await admin
      .from("user_provider_keys")
      .update({ cached_models: models, models_fetched_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", provider);
    return models;
  } catch (err) {
    console.error("抓取模型清單失敗", userId, provider, err);
    return null;
  }
}
