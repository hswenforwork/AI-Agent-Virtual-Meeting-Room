// 把房間的記事本／待辦事項／檔案夾整理成一段文字，讓 AI（一般聊天跟工作型代理都適用）
// 當作上下文參考。對應 brainstorms/2026-09-22-sidebar-resize-ai-context.md Q4/Q5。

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

async function buildNotesContext(admin: AdminClient, roomId: string): Promise<string> {
  const { data: notes } = await admin
    .from("notes")
    .select("title, content")
    .eq("room_id", roomId)
    .order("updated_at", { ascending: false })
    .limit(NOTES_MAX_COUNT);

  if (!notes || notes.length === 0) return "";

  return notes
    .map((n) => `【${n.title || "未命名記事"}】\n${(n.content ?? "").slice(0, NOTES_MAX_CHARS_EACH)}`)
    .join("\n\n");
}

// 只給還沒完成的（todo／in_progress），已完成的不進 context，避免房間累積很多已完成
// 事項時把 context 灌爆（brainstorms/2026-09-22-sidebar-resize-ai-context.md Q5）。
async function buildTasksContext(admin: AdminClient, roomId: string): Promise<string> {
  const { data: tasks } = await admin
    .from("tasks")
    .select("title, description, status")
    .eq("room_id", roomId)
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

async function buildFileContext(admin: AdminClient, roomId: string): Promise<string> {
  const { data: files } = await admin
    .from("files")
    .select("id, name")
    .eq("room_id", roomId)
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
  const [notes, tasks, files] = await Promise.all([
    buildNotesContext(admin, roomId),
    buildTasksContext(admin, roomId),
    buildFileContext(admin, roomId),
  ]);

  const sections: string[] = [];
  if (notes) sections.push(`## 記事本\n${notes}`);
  if (tasks) sections.push(`## 待辦事項（尚未完成）\n${tasks}`);
  if (files) sections.push(`## 檔案夾參考資料\n${files}`);

  return sections.join("\n\n");
}
