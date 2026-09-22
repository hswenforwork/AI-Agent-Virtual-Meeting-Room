// 取得（第一次用時自動建立）某個使用者專屬的 Managed Agents agent／environment。
// 對應 brainstorms/2026-09-22-user-api-key-settings.md Q9/Q10。

import { createManagedAgent, createManagedEnvironment } from "./managedAgents.ts";
import type { supabaseAdmin } from "./supabaseAdmin.ts";

export interface UserManagedAgentResources {
  agentId: string;
  environmentId: string;
}

export async function getOrCreateUserManagedAgent(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  apiKey: string,
  model: string,
): Promise<UserManagedAgentResources> {
  const { data: existing } = await admin
    .from("user_managed_agents")
    .select("agent_id, environment_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return { agentId: existing.agent_id, environmentId: existing.environment_id };

  const environment = await createManagedEnvironment(apiKey);
  const agent = await createManagedAgent(apiKey, model);

  const { data: inserted, error } = await admin
    .from("user_managed_agents")
    .insert({ user_id: userId, agent_id: agent.id, environment_id: environment.id })
    .select("agent_id, environment_id")
    .single();

  if (error || !inserted) {
    // user_id 是 unique：如果是兩個請求同時第一次觸發造成的衝突，改讀已經寫入的那筆就好，
    // 不需要把剛建好但沒存到的 agent/environment 丟掉重試。
    const { data: raceExisting } = await admin
      .from("user_managed_agents")
      .select("agent_id, environment_id")
      .eq("user_id", userId)
      .single();
    if (raceExisting) return { agentId: raceExisting.agent_id, environmentId: raceExisting.environment_id };
    throw error ?? new Error("建立使用者專屬 Managed Agents 資源失敗");
  }

  return { agentId: inserted.agent_id, environmentId: inserted.environment_id };
}
