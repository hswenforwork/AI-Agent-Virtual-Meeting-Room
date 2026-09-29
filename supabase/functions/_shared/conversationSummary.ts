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
// 鎖逾時：持鎖的呼叫如果因為 Edge Function 被提前收回等原因意外中斷、沒機會釋放鎖，
// 逾時後允許之後的呼叫當作「上一個已經死掉」重新搶占，避免摘要功能因為一次意外就永久卡死。
const LOCK_STALE_MS = 5 * 60 * 1000;

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
  // 項目 10 修正：同一個房間可能有好幾個 agent_run 平行執行（chat-dispatch 平行派送
  // 多位被點名的代理），每一個都會呼叫這個函式。用條件式 UPDATE 原子搶占
  // summary_locked_at，搶不到就代表已經有另一個呼叫在處理，直接跳過——避免兩個呼叫
  // 各自基於同一份舊摘要生成新版本、後寫入覆蓋先寫入，讓先寫入那次涵蓋到的內容從
  // 最終存檔的摘要裡消失。
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data: claimedRoom, error: claimErr } = await admin
    .from("rooms")
    .update({ summary_locked_at: new Date().toISOString() })
    .eq("id", roomId)
    .or(`summary_locked_at.is.null,summary_locked_at.lt.${staleBefore}`)
    .select("id")
    .maybeSingle();
  if (claimErr) {
    console.error("搶占對話摘要鎖失敗", roomId, claimErr);
    return;
  }
  if (!claimedRoom) return; // 已經有另一個呼叫在處理這個房間的摘要

  try {
    const { data: room } = await admin
      .from("rooms")
      .select("conversation_summary, summary_covered_until")
      .eq("id", roomId)
      .maybeSingle();
    if (!room) return;

    // 先找出「最新 RECENT_WINDOW 則」的邊界時間點：只有比這個邊界更舊、且還沒被摘要過
    // 的訊息才算積壓（agent-run 一律verbatim 帶最新 RECENT_WINDOW 則進去，不需要摘要）。
    const { data: boundaryRows } = await admin
      .from("messages")
      .select("created_at")
      .eq("room_id", roomId)
      .eq("status", "completed")
      .neq("sender_type", "system")
      .order("created_at", { ascending: false })
      .range(RECENT_WINDOW - 1, RECENT_WINDOW - 1);
    const recentCutoff = boundaryRows?.[0]?.created_at;
    if (!recentCutoff) return; // 訊息總數還不到 RECENT_WINDOW，沒有積壓可言

    // 積壓改成「最舊在前（asc）+ LIMIT」抓，並且上界卡在 recentCutoff：確保每一次呼叫
    // 涵蓋到的範圍一定是從上次 covered_until 之後「連續、不跳過」地往前推進，即使一次
    // 涵蓋不完（超過 BACKLOG_FETCH_CAP），covered_until 也只會推進到「這批實際摘要進去
    // 的最新一則」為止，下一次呼叫會從那裡繼續接著涵蓋，不會有任何訊息被永久跳過
    // （原本 desc + LIMIT 抓「最新一批」的寫法，積壓超過 BACKLOG_FETCH_CAP 時，
    // 中間比這批更舊的積壓會被永久跳過，见 migrations/0024 的說明）。
    const { data: rows } = await admin
      .from("messages")
      .select("sender_type, content, created_at")
      .eq("room_id", roomId)
      .eq("status", "completed")
      .neq("sender_type", "system")
      .gt("created_at", room.summary_covered_until ?? "1970-01-01T00:00:00Z")
      .lt("created_at", recentCutoff)
      .order("created_at", { ascending: true })
      .limit(BACKLOG_FETCH_CAP);

    const backlog = rows ?? [];
    if (backlog.length < BACKLOG_THRESHOLD) return;

    if (!triggeringUserId) return;
    const apiKey = await getUserProviderKey(admin, triggeringUserId, "anthropic");
    if (!apiKey) return;

    // backlog 已經是舊到新排序，可以直接餵給模型
    const provider = createAnthropicProvider(apiKey);
    const userPrompt = `既有摘要：\n${room.conversation_summary || "（目前沒有摘要）"}\n\n新增的這段對話紀錄：\n${formatTranscript(backlog)}`;

    const result = await provider.generate({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      model: SUMMARY_MODEL,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });

    const newSummary = result.text.trim();
    if (!newSummary) return;

    // backlog 最後一筆（asc 排序下最新的一筆）是這批實際被摘要進去的訊息裡最新的一筆，
    // 摘要涵蓋到它為止——不是整個 recentCutoff，避免謊報涵蓋到了實際上還沒被摘要的訊息。
    await admin
      .from("rooms")
      .update({ conversation_summary: newSummary, summary_covered_until: backlog[backlog.length - 1].created_at })
      .eq("id", roomId);
  } catch (err) {
    // 摘要是錦上添花的功能，失敗不影響聊天本身可用性
    console.error("自動摘要對話失敗", roomId, err);
  } finally {
    await admin.from("rooms").update({ summary_locked_at: null }).eq("id", roomId);
  }
}
