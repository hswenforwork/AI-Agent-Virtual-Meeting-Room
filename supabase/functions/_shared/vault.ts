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

// 只查「有沒有設定」，不解密明碼（明碼要透過 Vault RPC，成本高很多）。用在像
// loop-in 工具定義這種每次生成回覆都要跑一次、只需要知道「有哪些供應商可選」的地方
// （brainstorms/2026-09-23-gpt-audit-followups.md Q7）。
export async function listConfiguredProviders(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
): Promise<Set<ProviderSlug>> {
  const { data, error } = await admin.from("user_provider_keys").select("provider").eq("user_id", userId);
  if (error) {
    console.error("查詢使用者已設定的供應商失敗", userId, error);
    return new Set();
  }
  return new Set((data ?? []).map((row) => row.provider as ProviderSlug));
}
