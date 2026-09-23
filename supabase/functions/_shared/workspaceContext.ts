// 把記事本／待辦事項／檔案夾整理成一段文字，讓 AI（一般聊天跟工作型代理都適用）
// 當作上下文參考。對應 brainstorms/2026-09-22-sidebar-resize-ai-context.md Q4/Q5。
// brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1：記事本/待辦/檔案夾已經
// 改成跨聊天室共用（RLS 依 rooms.owner_id 判斷，見 migrations/0011_shared_workspace.sql），
// 這裡用 service_role 直接查詢，所以要自己算出「跟這個房間同一個擁有者的所有房間 id」，
// 不能只查單一 room_id。

import type { supabaseAdmin } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const NOTES_MAX_COUNT = 5;
const NOTES_MAX_CHARS_EACH = 1000;
const TASKS_MAX_COUNT = 20;
const FILE_CONTEXT_MAX_FILES = 3;
const FILE_CONTEXT_MAX_CHUNKS_PER_FILE = 2;
const FILE_CONTEXT_MAX_CHARS = 6000;

const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "待辦",
  in_progress: "進行中",
};

// 給定一個房間 id，回傳「同一個擁有者名下所有房間 id」的清單（至少包含這個房間自己）。
export async function resolveWorkspaceRoomIds(admin: AdminClient, roomId: string): Promise<string[]> {
  const { data: room } = await admin.from("rooms").select("owner_id").eq("id", roomId).maybeSingle();
  if (!room) return [roomId];

  const { data: rooms } = await admin.from("rooms").select("id").eq("owner_id", room.owner_id);
  const ids = (rooms ?? []).map((r) => r.id);
  return ids.length > 0 ? ids : [roomId];
}

async function buildNotesContext(admin: AdminClient, roomIds: string[]): Promise<string> {
  const { data: notes } = await admin
    .from("notes")
    .select("title, content")
    .in("room_id", roomIds)
    .order("updated_at", { ascending: false })
    .limit(NOTES_MAX_COUNT);

  if (!notes || notes.length === 0) return "";

  return notes
    .map((n) => `【${n.title || "未命名記事"}】\n${(n.content ?? "").slice(0, NOTES_MAX_CHARS_EACH)}`)
    .join("\n\n");
}

// 只給還沒完成的（todo／in_progress），已完成的不進 context，避免累積很多已完成
// 事項時把 context 灌爆（brainstorms/2026-09-22-sidebar-resize-ai-context.md Q5）。
async function buildTasksContext(admin: AdminClient, roomIds: string[]): Promise<string> {
  const { data: tasks } = await admin
    .from("tasks")
    .select("title, description, status")
    .in("room_id", roomIds)
    .in("status", ["todo", "in_progress"])
    .order("created_at", { ascending: true })
    .limit(TASKS_MAX_COUNT);

  if (!tasks || tasks.length === 0) return "";

  return tasks
    .map((t) => {
      const label = TASK_STATUS_LABEL[t.status] ?? t.status;
      return `- [${label}] ${t.title}${t.description ? `：${t.description}` : ""}`;
    })
    .join("\n");
}

async function buildFileContext(admin: AdminClient, roomIds: string[]): Promise<string> {
  const { data: files } = await admin
    .from("files")
    .select("id, name")
    .in("room_id", roomIds)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(FILE_CONTEXT_MAX_FILES);

  if (!files || files.length === 0) return "";

  const parts: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    const { data: chunks } = await admin
      .from("file_text_chunks")
      .select("content")
      .eq("file_id", file.id)
      .order("chunk_no", { ascending: true })
      .limit(FILE_CONTEXT_MAX_CHUNKS_PER_FILE);

    if (!chunks || chunks.length === 0) continue;

    const content = chunks.map((c) => c.content).join("\n");
    if (totalChars + content.length > FILE_CONTEXT_MAX_CHARS) break;
    totalChars += content.length;
    parts.push(`【檔案：${file.name}】\n${content}`);
  }

  return parts.join("\n\n");
}

export async function buildWorkspaceContext(admin: AdminClient, roomId: string): Promise<string> {
  const roomIds = await resolveWorkspaceRoomIds(admin, roomId);
  const [notes, tasks, files] = await Promise.all([
    buildNotesContext(admin, roomIds),
    buildTasksContext(admin, roomIds),
    buildFileContext(admin, roomIds),
  ]);

  const sections: string[] = [];
  if (notes) sections.push(`## 記事本\n${notes}`);
  if (tasks) sections.push(`## 待辦事項（尚未完成）\n${tasks}`);
  if (files) sections.push(`## 檔案夾參考資料\n${files}`);

  return sections.join("\n\n");
}
