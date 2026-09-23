// 讓 AI 能直接把「記事本／待辦事項」寫回 Supabase，不再只能讀（workspaceContext.ts）。
// 對應 brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q4-Q9：
//   三家供應商都支援（Q4）；只回短確認、不額外生成聊天回覆（Q5）；記事 vs 待辦由 AI 自己判斷
//   （Q6）；GPT/Gemini 也跑同一套分類呼叫，只是不給 task 選項（Q7）；同時支援新增跟
//   修改/完成既有項目（Q8）；找不到或不確定要改哪一筆時用 clarify 請使用者說清楚，不用猜（Q9）。

import type { AIProvider, ChatMessage } from "./providers/types.ts";
import type { supabaseAdmin } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;
type Usage = { inputTokens: number; outputTokens: number };

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
// workspace_write 的 content 可能是一整段筆記，用同一個上限（不分 task/question/workspace_write）
// 比只留給 task 摘要的短上限安全，避免長記事被截斷。
const CLASSIFY_MAX_OUTPUT_TOKENS = 600;
const MATCH_ITEMS_MAX_NOTES = 40;
const MATCH_ITEMS_MAX_TASKS = 60;
const MATCH_ITEM_PREVIEW_CHARS = 40;

export interface WorkspaceMatchItem {
  id: string;
  type: "note" | "task";
  title: string;
  // 記事本內容預覽（brainstorms/2026-09-23-workspace-write-cross-room-overwrite.md）：
  // 很多記事沒有標題（顯示成「未命名記事」），光看標題完全分不出彼此，分類模型很容易
  // 誤判成同一筆而錯配到 update_note，把跨聊天室、內容完全不相關的既有記事覆蓋掉。
  // 補上內容預覽讓模型有更多依據判斷「這真的是同一筆嗎」。
  preview?: string;
}

export type WorkspaceWriteAction =
  | { action: "create_note"; title: string; content: string }
  | { action: "create_task"; title: string }
  | { action: "update_note"; id: string; title?: string; content?: string }
  | { action: "update_task"; id: string; status?: "todo" | "in_progress" | "done"; title?: string }
  | { action: "clarify"; question: string };

export type ClassifyResult =
  | { kind: "task"; summary: string; needsNotebookTool: boolean; usage: Usage }
  | { kind: "question"; usage: Usage }
  | { kind: "workspace_write"; write: WorkspaceWriteAction; usage: Usage };

// 給分類 prompt 看的既有記事／待辦清單（含 id，用來比對 update_note/update_task 要改哪一筆）。
export async function fetchWorkspaceMatchItems(admin: AdminClient, ownerId: string): Promise<WorkspaceMatchItem[]> {
  const [{ data: notes }, { data: tasks }] = await Promise.all([
    admin
      .from("notes")
      .select("id, title, content")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false })
      .limit(MATCH_ITEMS_MAX_NOTES),
    admin
      .from("tasks")
      .select("id, title, status")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(MATCH_ITEMS_MAX_TASKS),
  ]);

  const items: WorkspaceMatchItem[] = [];
  for (const n of notes ?? []) {
    const preview = (n.content ?? "").trim().slice(0, MATCH_ITEM_PREVIEW_CHARS);
    items.push({ id: n.id, type: "note", title: n.title || "未命名記事", preview: preview || undefined });
  }
  for (const t of tasks ?? []) {
    const statusLabel = t.status === "done" ? "（已完成）" : t.status === "in_progress" ? "（進行中）" : "";
    items.push({ id: t.id, type: "task", title: `${t.title}${statusLabel}` });
  }
  return items;
}

function buildMatchItemsText(items: WorkspaceMatchItem[]): string {
  if (items.length === 0) return "（目前沒有任何記事或待辦）";
  return items
    .map((i) => `- [${i.type}] id=${i.id} 標題：${i.title}${i.preview ? `（內容開頭：${i.preview}…）` : ""}`)
    .join("\n");
}

const WORKSPACE_WRITE_SPEC = `
2.「workspace_write」：使用者明確要求把內容「記進記事本」或「加進待辦事項」，或要求修改／完成／更新既有的記事或待辦
   （單純聊天中提到某件事、或要求做其他一般性工作，都不算——那些屬於「question」或「task」）。
   依情況回傳以下其中一種格式：
   - 新增一則記事：{"type":"workspace_write","action":"create_note","title":"...","content":"..."}
   - 新增一則待辦：{"type":"workspace_write","action":"create_task","title":"..."}
   - 修改既有記事（title/content 只填有變動的欄位）：{"type":"workspace_write","action":"update_note","id":"（下面清單裡的 id，一定要照抄，不能自己編）","title":"...","content":"..."}
   - 修改既有待辦，包含標記完成／改狀態（status/title 只填有變動的欄位，status 只能是 todo/in_progress/done）：{"type":"workspace_write","action":"update_task","id":"（下面清單裡的 id，一定要照抄，不能自己編）","status":"done"}
   - 使用者要修改/完成某一筆，但你在下面清單裡找不到明確對應的項目，或有多筆標題相似、不確定是哪一筆：
     {"type":"workspace_write","action":"clarify","question":"用一句話請使用者說清楚是哪一筆"}

   update_note/update_task 會直接覆蓋掉既有內容，選錯會讓使用者的舊資料憑空消失，
   一定要非常保守：
   - 只有使用者這則訊息本身明確在講「修改／更新／補充／完成／刪掉某部分」一筆**既有**的
     記事或待辦時，才能用 update_note/update_task；使用者是在講一件新的事、新的內容，
     即使清單裡剛好有標題或內容相似（尤其是標題是「未命名記事」這種預設值，或內容開頭
     剛好雷同）的項目，也一律當成新的一筆，用 create_note/create_task，絕對不能因為
     「看起來像」就配對過去覆蓋掉。
   - 只有在使用者的話明確指出是哪一筆（提到標題關鍵字、內容關鍵字、或明確說「剛剛那則」
     這類上下文），且下面清單裡有清楚對應的單一項目時，才用 update_note/update_task；
     只要有任何不確定，一律用 clarify 反問，不要用猜的、也不要因為「這是唯一一筆」就
     直接選它。

目前既有的記事本／待辦事項清單（只用來比對 update_note/update_task 要改哪一筆，跟這次意圖無關就不用管它；
這份清單可能包含其他聊天室、跟這次對話主題完全無關的項目）：
{existingItems}
`;

function buildClassifySystemPrompt(allowTask: boolean, matchItemsText: string): string {
  if (allowTask) {
    return `你負責判斷使用者最新這則訊息的意圖，只能回傳一行 JSON，不要有任何其他文字。可能的意圖有三種：

1.「task」：需要實際動手做事才能完成的一般性任務——寫程式、修 bug、跑測試、產生檔案、部署、大規模搜尋整理資料等，做完會有具體產出或變更。
   格式：{"type":"task","summary":"一句話描述這個任務要做什麼","needsNotebookTool":true 或 false}
   needsNotebookTool：只有使用者這則訊息本身明確要求把這個任務的結果或過程「記進記事本」
   「加進待辦事項」「記錄下來」之類（不只是做完任務本身，還額外要求記錄）才設為 true；
   單純交辦任務、沒有額外要求記錄的話，一律設為 false。
${WORKSPACE_WRITE_SPEC.replace("{existingItems}", matchItemsText)}
3.「question」：以上兩種都不是的所有情況（單純問答、討論、閒聊、請教意見）。
   格式：{"type":"question"}`;
  }

  return `你負責判斷使用者最新這則訊息的意圖，只能回傳一行 JSON，不要有任何其他文字。可能的意圖有兩種：
${WORKSPACE_WRITE_SPEC.replace("{existingItems}", matchItemsText).replace("2.「workspace_write」", "1.「workspace_write」")}
2.「question」：以上都不是的所有情況（單純問答、討論、閒聊、請教意見，或任何需要實際動手做的一般性任務——這裡不支援任務執行，一律當問題處理）。
   格式：{"type":"question"}`;
}

function parseWorkspaceWrite(parsed: Record<string, unknown>, matchItems: WorkspaceMatchItem[]): WorkspaceWriteAction | null {
  const action = parsed.action;
  const findItem = (id: unknown, type: WorkspaceMatchItem["type"]) =>
    typeof id === "string" ? matchItems.find((i) => i.id === id && i.type === type) : undefined;

  if (action === "create_note" && typeof parsed.title === "string") {
    return { action: "create_note", title: parsed.title.trim() || "未命名記事", content: String(parsed.content ?? "") };
  }
  if (action === "create_task" && typeof parsed.title === "string" && parsed.title.trim()) {
    return { action: "create_task", title: parsed.title.trim() };
  }
  if (action === "update_note") {
    const item = findItem(parsed.id, "note");
    if (!item) return { action: "clarify", question: "找不到你指的那一筆記事，可以說清楚一點是哪一筆嗎？" };
    return {
      action: "update_note",
      id: item.id,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
    };
  }
  if (action === "update_task") {
    const item = findItem(parsed.id, "task");
    if (!item) return { action: "clarify", question: "找不到你指的那一筆待辦，可以說清楚一點是哪一筆嗎？" };
    const status = parsed.status;
    return {
      action: "update_task",
      id: item.id,
      status: status === "todo" || status === "in_progress" || status === "done" ? status : undefined,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
    };
  }
  if (action === "clarify" && typeof parsed.question === "string" && parsed.question.trim()) {
    return { action: "clarify", question: parsed.question.trim() };
  }
  return null;
}

export async function classifyMessage(
  provider: AIProvider,
  model: string,
  history: ChatMessage[],
  allowTask: boolean,
  matchItems: WorkspaceMatchItem[],
): Promise<ClassifyResult> {
  if (history.length === 0) return { kind: "question", usage: ZERO_USAGE };

  const systemPrompt = buildClassifySystemPrompt(allowTask, buildMatchItemsText(matchItems));

  try {
    const result = await provider.generate({
      systemPrompt,
      messages: history,
      model,
      maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS,
    });
    const match = result.text.match(/\{.*\}/s);
    if (!match) return { kind: "question", usage: result.usage };
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    if (allowTask && parsed.type === "task" && typeof parsed.summary === "string" && parsed.summary.trim()) {
      return {
        kind: "task",
        summary: parsed.summary.trim(),
        needsNotebookTool: parsed.needsNotebookTool === true,
        usage: result.usage,
      };
    }
    if (parsed.type === "workspace_write") {
      const write = parseWorkspaceWrite(parsed, matchItems);
      if (write) return { kind: "workspace_write", write, usage: result.usage };
    }
    return { kind: "question", usage: result.usage };
  } catch (err) {
    console.error("意圖分類失敗，視為一般問題", err);
    return { kind: "question", usage: ZERO_USAGE };
  }
}

// 執行實際的資料庫寫入，回傳要顯示給使用者的短確認文字（Q5：只回短確認，不額外生成聊天回覆）。
// ownerId 是真正的歸屬（brainstorms/2026-09-23-gpt-audit-followups.md Q1），roomId 只在新增時
// 當作這筆記事/待辦的「來源房間」參考欄位，不影響誰看得到它。
export async function applyWorkspaceWrite(
  admin: AdminClient,
  roomId: string,
  ownerId: string,
  userId: string | undefined,
  write: WorkspaceWriteAction,
): Promise<string> {
  switch (write.action) {
    case "create_note": {
      const { error } = await admin
        .from("notes")
        .insert({ room_id: roomId, owner_id: ownerId, title: write.title, content: write.content, created_by: userId });
      if (error) throw error;
      return `已幫你記到記事本：${write.title}`;
    }
    case "create_task": {
      const { error } = await admin.from("tasks").insert({ room_id: roomId, owner_id: ownerId, title: write.title });
      if (error) throw error;
      return `已幫你加進待辦事項：${write.title}`;
    }
    case "update_note": {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (write.title !== undefined) patch.title = write.title;
      if (write.content !== undefined) patch.content = write.content;
      const { error } = await admin.from("notes").update(patch).eq("id", write.id);
      if (error) throw error;
      return `已幫你更新記事：${write.title ?? ""}`.trim();
    }
    case "update_task": {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (write.status !== undefined) patch.status = write.status;
      if (write.title !== undefined) patch.title = write.title;
      const { error } = await admin.from("tasks").update(patch).eq("id", write.id);
      if (error) throw error;
      const statusLabel = write.status === "done" ? "已標記完成" : write.status ? "已更新狀態" : "已更新";
      return `${statusLabel}：${write.title ?? ""}`.trim();
    }
    case "clarify":
      return write.question;
  }
}
