// chat-dispatch：驗證訊息、依結構化 @mention 決定要啟動哪些代理，建立 agent_runs，
// 再逐一觸發 agent-run。對應 docs/MVP規劃-v2.md 第 3.1 節第 4 點的點名路由邏輯：
//   沒有 @：只有主管代理（is_supervisor=true，MVP 綁定 Claude）回覆
//   有 @：只有被點名的供應商回覆，主管代理當輪不參與
// 對應 brainstorms/2026-09-22-user-api-key-settings.md Q1/Q3/Q5（BYOK）：
//   代理是否可用不再看房間層級的 agents.status，改看「發這則訊息的使用者」
//   自己有沒有設定該供應商的 API key；沒有的話不回覆，用 system 訊息提示去設定，
//   不會退回任何部署者的全域金鑰。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";
import { createAnthropicProvider } from "../_shared/providers/anthropic.ts";
import { getUserProviderKey, type ProviderSlug } from "../_shared/vault.ts";

const MAX_AGENT_RUNS_PER_MESSAGE = Number(Deno.env.get("MAX_AGENT_RUNS_PER_MESSAGE") ?? "4");
const AGENT_RUN_FETCH_TIMEOUT_MS = Number(Deno.env.get("AGENT_RUN_FETCH_TIMEOUT_MS") ?? "10000");
const AGENT_RUN_FETCH_MAX_ATTEMPTS = 3;
const AGENT_RUN_FETCH_RETRY_DELAYS_MS = [500, 1500];
const TITLE_MAX_OUTPUT_TOKENS = 30;
const TITLE_MODEL = Deno.env.get("DEFAULT_CLAUDE_MODEL") ?? "claude-sonnet-5";
const TITLE_SYSTEM_PROMPT =
  "你負責幫聊天室取一個 5-10 個字的精簡標題，只根據使用者這則訊息的主題來取，不要加任何標點符號、引號或「標題：」這類前綴，只回傳標題本身。";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { messageId } = await req.json();
    if (!messageId) return jsonError("缺少 messageId", 400, headers);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();

    const { data: message, error: messageErr } = await admin
      .from("messages")
      .select("id, room_id, sender_user_id, sender_type, content")
      .eq("id", messageId)
      .single();

    if (messageErr || !message) return jsonError("找不到這則訊息", 404, "not_found", headers);
    if (message.sender_type !== "user" || message.sender_user_id !== user.id) {
      return jsonError("您沒有這則訊息的權限", 403, "forbidden", headers);
    }

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", message.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden", headers);

    // 房間第一則訊息：搶著把 title_generated 標記為 true 再產生標題（brainstorms/2026-09-22-room-sidebar-history.md Q4），
    // 用「update ... where title_generated = false」當簡易的搶旗標機制，避免使用者連續送兩則訊息時重複觸發兩次標題產生。
    const { data: claimedRoom } = await admin
      .from("rooms")
      .update({ title_generated: true })
      .eq("id", message.room_id)
      .eq("title_generated", false)
      .select("id")
      .maybeSingle();
    const shouldGenerateTitle = !!claimedRoom;

    const { data: mentions } = await admin
      .from("message_mentions")
      .select("agent_id")
      .eq("message_id", messageId);

    let targetAgentIds = (mentions ?? []).map((m) => m.agent_id);
    const notices: string[] = [];
    // 同一則訊息裡最多用到三種供應商，個別查一次 Vault、快取結果，避免重複呼叫。
    const keyCache = new Map<ProviderSlug, boolean>();
    async function senderHasKey(provider: ProviderSlug): Promise<boolean> {
      if (!keyCache.has(provider)) {
        const key = await getUserProviderKey(admin, user.id, provider);
        keyCache.set(provider, !!key);
      }
      return keyCache.get(provider)!;
    }

    if (targetAgentIds.length === 0) {
      const { data: supervisor } = await admin
        .from("agents")
        .select("id, name, provider")
        .eq("room_id", message.room_id)
        .eq("is_supervisor", true)
        .maybeSingle();
      if (supervisor) {
        const hasKey = await senderHasKey(supervisor.provider as ProviderSlug);
        if (hasKey) {
          targetAgentIds = [supervisor.id];
        } else {
          notices.push(`尚未設定 ${supervisor.name} 的 API key，請先到「設定」頁輸入後再試一次。`);
        }
      }
    } else {
      // 項目 3 修正（二次驗證，資料庫層的 message_mentions RLS policy 已經擋住新增
      // 跨房間點名，這裡加上 room_id 篩選當第二層防禦）：只信任「屬於這則訊息所在房間」
      // 的代理 id，不屬於這個房間的 agent_id 不會出現在 targetAgents 裡，
      // 下面的 availableIds／targetAgentIds.filter() 就會自然把它排除，不會被觸發執行。
      const { data: targetAgents } = await admin
        .from("agents")
        .select("id, name, provider")
        .eq("room_id", message.room_id)
        .in("id", targetAgentIds);

      const availableIds = new Set<string>();
      const noKeyNames: string[] = [];
      for (const agent of targetAgents ?? []) {
        if (await senderHasKey(agent.provider as ProviderSlug)) {
          availableIds.add(agent.id);
        } else {
          noKeyNames.push(agent.name);
        }
      }

      if (noKeyNames.length > 0) {
        notices.push(`${noKeyNames.join("、")} 需要你自己的 API key 才能回覆，請先到「設定」頁輸入。`);
      }
      targetAgentIds = targetAgentIds.filter((id) => availableIds.has(id));
    }

    if (targetAgentIds.length > MAX_AGENT_RUNS_PER_MESSAGE) {
      targetAgentIds = targetAgentIds.slice(0, MAX_AGENT_RUNS_PER_MESSAGE);
      notices.push(`一次最多同時點名 ${MAX_AGENT_RUNS_PER_MESSAGE} 位代理，其餘已略過。`);
    }

    if (notices.length > 0) {
      await admin.from("messages").insert({
        room_id: message.room_id,
        sender_type: "system",
        content: notices.join("\n"),
        status: "completed",
      });
    }

    // 項目 7 修正：同一則訊息可能因為前端網路逾時、使用者連點等原因重複呼叫
    // chat-dispatch。原本這裡每次都直接 insert 一筆新的 agent_runs，會讓同一個
    // 代理對同一則訊息重複回覆、也重複打一次真的會計費的 LLM 呼叫。現在
    // agent_runs(trigger_message_id, agent_id)（排除 loop-in）有唯一索引
    // （見 migrations/0021），insert 撞到唯一索引（Postgres unique_violation，
    // code 23505）就代表這個代理已經有一筆執行紀錄了：只有在那筆還卡在 queued
    // （代表上一次插入成功後、觸發 agent-run 那一步卻沒有真的送出去）才重新觸發，
    // 其餘狀態（running/completed/failed）代表已經在處理或已經處理完，不重複觸發。
    const runIds: string[] = [];
    for (const agentId of targetAgentIds) {
      const { data: run, error: runErr } = await admin
        .from("agent_runs")
        .insert({
          room_id: message.room_id,
          agent_id: agentId,
          trigger_message_id: messageId,
          status: "queued",
        })
        .select("id")
        .single();

      if (runErr) {
        if (runErr.code === "23505") {
          const { data: existing } = await admin
            .from("agent_runs")
            .select("id, status")
            .eq("trigger_message_id", messageId)
            .eq("agent_id", agentId)
            .eq("is_loop_in", false)
            .maybeSingle();
          if (existing && existing.status === "queued") {
            runIds.push(existing.id);
          }
          continue;
        }
        console.error("建立 agent_run 失敗", runErr);
        continue;
      }
      if (!run) continue;
      runIds.push(run.id);
    }

    const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const internalSecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 平行觸發所有被點名的代理（brainstorms/2026-09-23-gpt-audit-followups.md Q2）：
    // 原本依序 await 每一位代理回完才觸發下一位，是為了避免打滿 RPM；但三家供應商各自
    // 是獨立的帳號、獨立算額度，依序執行不會降低任何一家的請求量，只會讓使用者等更久，
    // 也讓後面的代理讀歷史訊息時看到前面已完成的回覆，跟文件承諾的「各自獨立回答、
    // 平行並排顯示」不符（agent-run 那邊另外用 reply_to_id 過濾同一批次的其他代理回覆
    // 來保證獨立，不依賴這裡的執行順序）。
    // 用 EdgeRuntime.waitUntil() 包起來：一旦這個 handler 把 Response 送出去，
    // Edge Function 的執行環境隨時可能被提前收回，沒有 waitUntil() 的話，
    // 這裡「射後不理」的 fetch 常常來不及送到 agent-run 就被中斷。
    //
    // 項目 7 修正：原本這個 fetch 不檢查回應狀態碼、失敗也只是 log 一行就結束，
    // 讓 agent_runs 永遠卡在 queued——使用者看不到任何回覆，也看不到任何錯誤
    // 提示，UI 上就是無限轉圈。現在加上逾時（AbortController）、有限次重試（含
    // 退避間隔），重試用盡就把這筆 agent_run 標成 failed，前端才有機會顯示錯誤
    // 狀態而不是永遠卡住。
    const triggerAgentRun = async (runId: string) => {
      for (let attempt = 1; attempt <= AGENT_RUN_FETCH_MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), AGENT_RUN_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(`${functionsBase}/agent-run`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${internalSecret}`,
            },
            body: JSON.stringify({ runId }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (response.ok) return;
          console.error("觸發 agent-run 回傳非成功狀態", runId, attempt, response.status);
        } catch (err) {
          clearTimeout(timeoutId);
          console.error("觸發 agent-run 失敗", runId, attempt, err);
        }
        if (attempt < AGENT_RUN_FETCH_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, AGENT_RUN_FETCH_RETRY_DELAYS_MS[attempt - 1]));
        }
      }
      // 只有還在 queued 才蓋成 failed：避免蓋掉 agent-run 其實已經收到請求、
      // 只是回應在我們判定逾時之後才送達、自己把狀態更新成別的值的情況。
      await admin
        .from("agent_runs")
        .update({ status: "failed", error_code: "dispatch_failed", updated_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("status", "queued");
    };

    const dispatchAgentRuns = async () => {
      await Promise.all(runIds.map((runId) => triggerAgentRun(runId)));
    };

    // deno-lint-ignore no-undef
    EdgeRuntime.waitUntil(dispatchAgentRuns());

    if (shouldGenerateTitle) {
      // deno-lint-ignore no-undef
      EdgeRuntime.waitUntil(generateRoomTitle(admin, user.id, message.room_id, message.content));
    }

    return new Response(JSON.stringify({ runIds }), { headers });
  } catch (err) {
    console.error("chat-dispatch 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});

async function generateRoomTitle(
  admin: ReturnType<typeof supabaseAdmin>,
  userId: string,
  roomId: string,
  firstMessageContent: string,
) {
  try {
    // 房間標題是錦上添花的功能，用發第一則訊息的使用者自己的 Anthropic key；
    // 沒設定就略過，房間名稱維持預設的「新對話」，不影響聊天本身。
    const apiKey = await getUserProviderKey(admin, userId, "anthropic");
    if (!apiKey) return;

    const provider = createAnthropicProvider(apiKey);
    const result = await provider.generate({
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: firstMessageContent }],
      model: TITLE_MODEL,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
    });

    const title = result.text.trim().replace(/^["「『]|["」』]$/g, "");
    if (!title) return;

    await admin.from("rooms").update({ name: title.slice(0, 80) }).eq("id", roomId);
  } catch (err) {
    // 標題產生失敗不影響聊天室本身可用性，房間名稱維持原本的「新對話」即可。
    console.error("產生房間標題失敗", roomId, err);
  }
}
