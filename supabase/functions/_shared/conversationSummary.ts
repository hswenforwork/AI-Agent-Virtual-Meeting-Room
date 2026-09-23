// 對話自動摘要：房間層級的長期記憶，解決 agent-run 只抓最近 24 則訊息、更舊的對話
// AI 完全不知道的問題。對應 brainstorms/2026-09-23-gpt-audit-followups.md Q11-Q13。
//
// 機制：每次 agent-run 組歷史訊息前都跑一次這個檢查——如果「已摘要範圍」跟「最新 24 則
// （agent-run 一律verbatim 帶進去的範圍）」之間累積了超過門檻（20 則）的未摘要訊息，
// 就先把這一段折進摘要、更新存起來，之後才繼續正常回覆。摘要本身跟一般聊天用的模型
// 無關，固定用房間裡發第一則訊息的使用者自己的 Anthropic key（沒有就靜默略過，
// 不影響聊天本身可用性，比照 chat-dispatch 的 generateRoomTitle() 同一種取捨）。

import type { supabaseAdmin } from "./supabaseAdmin.ts";
import { createAnthropicProvider } from "./providers/anthropic.ts";
import { getUserProviderKey } from "./vault.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const RECENT_WINDOW = 24; // 要跟 agent-run 的 RECENT_MESSAGE_LIMIT 一致
const BACKLOG_THRESHOLD = 20;
const BACKLOG_FETCH_CAP = 300;
const SUMMARY_MODEL = Deno.env.get("DEFAULT_CLAUDE_MODEL") ?? "claude-sonnet-5";
const SUMMARY_MAX_OUTPUT_TOKENS = 800;

const SUMMARY_SYSTEM_PROMPT = `你負責幫一個多方 AI 協作聊天室維護「對話摘要」，這份摘要會在之後的對話裡當作背景資訊
提供給 AI，讓它記得更早之前聊過什麼。請把「既有摘要」跟「新增的這段對話紀錄」合併成一份更新後的摘要：
- 保留重要的事實、決定、使用者的偏好與待辦方向；省略閒聊、寒暄、已經不重要的細節。
- 用條列式，繁體中文，控制在 500 字以內。
- 只回傳摘要內容本身，不要加「摘要：」這類前綴、不要加任何額外說明。`;

interface MessageRow {
  sender_type: string;
  content: string;
  created_at: string;
}

function formatTranscript(rows: MessageRow[]): string {
  return rows
    .map((r) => `${r.sender_type === "user" ? "使用者" : r.sender_type === "agent" ? "AI" : "系統"}：${r.content}`)
    .join("\n");
}

export async function maybeSummarizeConversation(
  admin: AdminClient,
  roomId: string,
  triggeringUserId: string | undefined,
): Promise<void> {
  try {
    const { data: room } = await admin
      .from("rooms")
      .select("conversation_summary, summary_covered_until")
      .eq("id", roomId)
      .maybeSingle();
    if (!room) return;

    const { data: rows } = await admin
      .from("messages")
      .select("sender_type, content, created_at")
      .eq("room_id", roomId)
      .eq("status", "completed")
      .neq("sender_type", "system")
      .gt("created_at", room.summary_covered_until ?? "1970-01-01T00:00:00Z")
      .order("created_at", { ascending: false })
      .limit(RECENT_WINDOW + BACKLOG_FETCH_CAP);

    const backlog = (rows ?? []).slice(RECENT_WINDOW);
    if (backlog.length < BACKLOG_THRESHOLD) return;

    if (!triggeringUserId) return;
    const apiKey = await getUserProviderKey(admin, triggeringUserId, "anthropic");
    if (!apiKey) return;

    // backlog 是新到舊排序，摘要要照時間先後給模型看才合理
    const chronological = [...backlog].reverse();
    const provider = createAnthropicProvider(apiKey);
    const userPrompt = `既有摘要：\n${room.conversation_summary || "（目前沒有摘要）"}\n\n新增的這段對話紀錄：\n${formatTranscript(chronological)}`;

    const result = await provider.generate({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      model: SUMMARY_MODEL,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

    const newSummary = result.text.trim();
    if (!newSummary) return;

    // backlog[0]（新到舊排序的第一筆）是這批未摘要訊息裡最新的一筆，摘要涵蓋到它為止
    await admin
      .from("rooms")
      .update({ conversation_summary: newSummary, summary_covered_until: backlog[0].created_at })
      .eq("id", roomId);
  } catch (err) {
    // 摘要是錦上添花的功能，失敗不影響聊天本身可用性
    console.error("自動摘要對話失敗", roomId, err);
  }
}
