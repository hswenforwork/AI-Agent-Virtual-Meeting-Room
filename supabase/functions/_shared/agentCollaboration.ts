// 代理互相協作（loop-in）：讓一則回覆用真正的 AI tool use 把另一位供應商的代理拉進來，
// 它的回答獨立顯示成一則新訊息，不用再回傳給原本的代理做二次整合。
// 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q2-Q8。

import type { supabaseAdmin } from "./supabaseAdmin.ts";
import { listConfiguredProviders, type ProviderSlug } from "./vault.ts";
import type { ToolDefinition } from "./providers/types.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

export const LOOP_IN_TOOL_NAME = "loop_in_agent";

const PROVIDER_LABEL: Record<ProviderSlug, string> = {
  anthropic: "Claude",
  openai: "GPT",
  google: "Gemini",
};

export function providerLabel(provider: ProviderSlug): string {
  return PROVIDER_LABEL[provider];
}

// 只給使用者「自己有設定 key」的其他供應商當可選項（Q7 待釐清事項）；一個都沒有就回傳
// null，這次回覆完全不附帶 loop-in 工具（沒有任何可選對象，給了工具也沒有意義）。
export async function buildLoopInTool(
  admin: AdminClient,
  userId: string,
  currentProvider: ProviderSlug,
): Promise<ToolDefinition | null> {
  const configured = await listConfiguredProviders(admin, userId);
  const available = (["anthropic", "openai", "google"] as ProviderSlug[]).filter(
    (p) => p !== currentProvider && configured.has(p),
  );
  if (available.length === 0) return null;

  return {
    name: LOOP_IN_TOOL_NAME,
    description:
      "當你判斷這個問題交給另一位 AI 代理回答更合適時（例如需要它的專長、或想交叉確認你的答案），" +
      "呼叫這個工具把它拉進這個對話；它會自己生成一則獨立的回覆給使用者看，你不會再看到它的答案、" +
      "也不用等它回覆完，正常結束你自己這次的回覆即可。",
    parameters: {
      type: "object",
      properties: {
        target_provider: {
          type: "string",
          description: "要拉入的代理供應商",
          enum: available,
        },
        reason: {
          type: "string",
          description: "為什麼需要拉這位代理進來、想請它回答或協助什麼，會直接轉達給它當作提示",
        },
      },
      required: ["target_provider", "reason"],
    },
  };
}

// 建立被拉入代理（B）的 agent_run 並觸發它；B 的回答不回傳給 A（Q5），這裡不等待
// agent-run 執行完，射後不理即可（呼叫端要用 EdgeRuntime.waitUntil 包起來）。
export async function spawnLoopInRun(
  admin: AdminClient,
  params: { roomId: string; triggerMessageId: string; targetProvider: ProviderSlug; reason: string },
): Promise<void> {
  const { data: targetAgent } = await admin
    .from("agents")
    .select("id")
    .eq("room_id", params.roomId)
    .eq("provider", params.targetProvider)
    .maybeSingle();
  if (!targetAgent) return;

  const { data: run, error } = await admin
    .from("agent_runs")
    .insert({
      room_id: params.roomId,
      agent_id: targetAgent.id,
      trigger_message_id: params.triggerMessageId,
      status: "queued",
      is_loop_in: true,
      loop_in_reason: params.reason,
    })
    .select("id")
    .single();
  if (error || !run) {
    console.error("建立 loop-in agent_run 失敗", error);
    return;
  }

  const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const internalSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    await fetch(`${functionsBase}/agent-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${internalSecret}` },
      body: JSON.stringify({ runId: run.id }),
    });
  } catch (err) {
    console.error("觸發 loop-in agent-run 失敗", run.id, err);
  }
}
