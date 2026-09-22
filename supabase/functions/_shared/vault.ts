// 讀取使用者自帶 API Key（BYOK）的唯一入口，只能用 service_role client 呼叫。
// 明碼金鑰只存在 Supabase Vault，這裡呼叫的是 migrations/0009_byok_api_keys.sql
// 定義的 SECURITY DEFINER 函式，執行權限只授權給 service_role（對應 Q6）。

import type { supabaseAdmin } from "./supabaseAdmin.ts";

export type ProviderSlug = "anthropic" | "openai" | "google";

export async function getUserProviderKey(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  provider: ProviderSlug,
): Promise<string | null> {
  const { data, error } = await admin.rpc("get_user_provider_key", {
    p_user_id: userId,
    p_provider: provider,
  });
  if (error) {
    console.error("讀取使用者 API key 失敗", userId, provider, error);
    return null;
  }
  return (data as string | null) ?? null;
}
