// 代理主動提出「新知識／決策／關聯」草稿的工具（借鏡 /grill-me：原始推論先落在
// knowledge_proposals，不是正式知識，一定要使用者自己確認過才會變成 knowledge_items／
// decisions／knowledge_links 裡的正式一列）。跟 agentCollaboration.ts 的 loop_in_agent
// 同一種「真正的 AI tool use」機制，見 docs/AI-Partner借鏡對照.md 第 4 項。

import type { supabaseAdmin } from "./supabaseAdmin.ts";
import type { ToolDefinition } from "./providers/types.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

export const PROPOSE_KNOWLEDGE_TOOL_NAME = "propose_knowledge";

const ACTIVE_DECISIONS_IN_DESCRIPTION = 10;

async function fetchActiveDecisionsSummary(admin: AdminClient, ownerId: string): Promise<string> {
  const { data } = await admin
    .from("decisions")
    .select("id, title")
    .eq("owner_id", ownerId)
    .eq("status", "active")
    .order("decided_at", { ascending: false })
    .limit(ACTIVE_DECISIONS_IN_DESCRIPTION);

  if (!data || data.length === 0) return "（目前沒有任何有效的決策）";
  return data.map((d) => `- id=${d.id} 標題：${d.title}`).join("\n");
}

// 只在正常聊天回覆（非被拉入協作的 B、且找得到 ownerId）時附帶這個工具，跟 loop_in_agent
// 同樣的限制條件（agent-run/index.ts）。
export async function buildProposeKnowledgeTool(admin: AdminClient, ownerId: string): Promise<ToolDefinition> {
  const decisionsList = await fetchActiveDecisionsSummary(admin, ownerId);

  return {
    name: PROPOSE_KNOWLEDGE_TOOL_NAME,
    description:
      "當你判斷這次對話裡出現了值得長期記住的事實／規則／目標，或使用者做出了一項決策時，" +
      "呼叫這個工具提出一則「知識草稿」，不會直接變成正式資料——使用者要到「共享知識」分頁" +
      "自己確認、修改或拒絕後才算數，你不用等他確認、也不用改變這次回覆本身的內容。" +
      "只有使用者這則訊息或這段對話明確透露出長期有效的事實/規則/目標/決策時才呼叫，" +
      "單純聊天、還不確定、或只是暫時性的資訊，不要呼叫。\n\n" +
      "如果是要記錄一項「決策」，且這項決策明顯是要取代下面清單裡某一筆既有決策，" +
      "把該筆的 id 填進 supersedes_decision_id（一定要照抄 id，不能自己編）；" +
      "如果不確定是否衝突、但內容跟某一筆看起來有關，填 potential_conflict_with 說明，" +
      "讓使用者自己判斷要不要取代——不要自己猜測後直接當作取代。\n\n" +
      `目前有效的決策清單：\n${decisionsList}`,
    parameters: {
      type: "object",
      properties: {
        proposal_type: {
          type: "string",
          description: "要提出的類型：knowledge（長期背景知識）、decision（決策）、link（知識/決策之間的關聯）",
          enum: ["knowledge", "decision", "link"],
        },
        title: { type: "string", description: "簡短標題" },
        body: {
          type: "string",
          description: "knowledge/decision 用：詳細內容（決策的話是決策本身的內容）",
        },
        category: {
          type: "string",
          description: "只有 proposal_type=knowledge 時需要：這則知識屬於哪一類",
          enum: ["goal", "project", "term", "rule", "fact", "other"],
        },
        reasoning: { type: "string", description: "為什麼提出這則知識/決策，你的判斷依據" },
        supersedes_decision_id: {
          type: "string",
          description: "只有 proposal_type=decision 且明確要取代某筆既有決策時填，必須照抄上面清單的 id",
        },
        potential_conflict_with: {
          type: "string",
          description: "只有 proposal_type=decision 且不確定是否與某筆既有決策衝突時填，簡述疑慮",
        },
        from_type: { type: "string", description: "只有 proposal_type=link 時需要", enum: ["knowledge_item", "decision"] },
        from_id: { type: "string", description: "只有 proposal_type=link 時需要" },
        to_type: { type: "string", description: "只有 proposal_type=link 時需要", enum: ["knowledge_item", "decision"] },
        to_id: { type: "string", description: "只有 proposal_type=link 時需要" },
        relation: {
          type: "string",
          description: "只有 proposal_type=link 時需要：兩者的關係",
          enum: ["related", "supports", "depends_on", "contradicts", "supersedes"],
        },
      },
      required: ["proposal_type", "title", "body", "reasoning"],
    },
  };
}

export interface ProposeKnowledgeInput {
  proposal_type?: string;
  title?: string;
  body?: string;
  category?: string;
  reasoning?: string;
  supersedes_decision_id?: string;
  potential_conflict_with?: string;
  from_type?: string;
  from_id?: string;
  to_type?: string;
  to_id?: string;
  relation?: string;
}

// 寫進 knowledge_proposals，不動 knowledge_items/decisions/knowledge_links 任何一張正式表——
// 要變正式資料一定要靠使用者自己呼叫 accept_knowledge_proposal()（0019_shared_knowledge.sql）。
export async function recordKnowledgeProposal(
  admin: AdminClient,
  params: {
    ownerId: string;
    roomId: string;
    sourceMessageId: string;
    proposedByAgentId: string;
    input: ProposeKnowledgeInput;
  },
): Promise<{ ok: boolean; message: string }> {
  const { input } = params;
  const proposalType = input.proposal_type === "decision" || input.proposal_type === "link" ? input.proposal_type : "knowledge";

  if (!input.title || !input.title.trim()) {
    return { ok: false, message: "提案缺少標題，沒有送出。" };
  }

  const payload: Record<string, unknown> = { title: input.title.trim() };
  if (proposalType === "link") {
    if (!input.from_type || !input.from_id || !input.to_type || !input.to_id) {
      return { ok: false, message: "關聯提案缺少 from/to，沒有送出。" };
    }
    payload.from_type = input.from_type;
    payload.from_id = input.from_id;
    payload.to_type = input.to_type;
    payload.to_id = input.to_id;
    payload.relation = input.relation ?? "related";
  } else {
    payload.body = input.body ?? "";
    if (proposalType === "knowledge") payload.category = input.category ?? "other";
    if (proposalType === "decision" && input.supersedes_decision_id) {
      payload.supersedes_decision_id = input.supersedes_decision_id;
    }
    if (proposalType === "decision" && input.potential_conflict_with) {
      payload.potential_conflict_with = input.potential_conflict_with;
    }
  }

  const { error } = await admin.from("knowledge_proposals").insert({
    owner_id: params.ownerId,
    proposal_type: proposalType,
    payload,
    reasoning: input.reasoning ?? "",
    source_message_id: params.sourceMessageId,
    source_room_id: params.roomId,
    proposed_by_agent_id: params.proposedByAgentId,
  });

  if (error) {
    console.error("寫入知識提案失敗", error);
    return { ok: false, message: "提案沒有寫入成功，請稍後再試。" };
  }
  return { ok: true, message: "已提出知識草稿，待你在「共享知識」分頁確認。" };
}
