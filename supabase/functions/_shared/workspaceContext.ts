// 把記事本／待辦事項／檔案夾整理成一段文字，讓 AI（一般聊天跟工作型代理都適用）
// 當作上下文參考。對應 brainstorms/2026-09-22-sidebar-resize-ai-context.md Q4/Q5。
// brainstorms/2026-09-23-gpt-audit-followups.md Q1：notes/tasks/files 已經徹底跟房間
// 解耦，真正歸屬是 owner_id（見 migrations/0012_workspace_owner_id.sql），這裡用
// service_role 查詢時只需要先把 room_id 換算成 owner_id，再直接用 owner_id 篩選即可，
// 不用再算「同一個擁有者名下所有房間 id」這種間接關聯。

import type { supabaseAdmin } from "./supabaseAdmin.ts";
import type { DocumentAttachment } from "./providers/types.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const NOTES_MAX_COUNT = 5;
const NOTES_MAX_CHARS_EACH = 1000;
const TASKS_MAX_COUNT = 20;
const FILE_CONTEXT_MAX_FILES = 3;
const FILE_CONTEXT_MAX_CHUNKS_PER_FILE = 2;
const FILE_CONTEXT_MAX_CHARS = 6000;
// PDF 走原生文件輸入（Q14/Q15），每頁都要算進供應商的 context window（Anthropic/Gemini
// 官方文件都提到一頁至少兩三百 token 起跳），先保守只帶最近 2 份，避免單次請求就把
// 上下文塞爆或超過供應商的請求大小上限。
const PDF_CONTEXT_MAX_FILES = 2;

const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "待辦",
  in_progress: "進行中",
};

// 給定一個房間 id，回傳這個房間擁有者的 user id（notes/tasks/files 真正的歸屬）。
export async function resolveWorkspaceOwnerId(admin: AdminClient, roomId: string): Promise<string | null> {
  const { data: room } = await admin.from("rooms").select("owner_id").eq("id", roomId).maybeSingle();
  return room?.owner_id ?? null;
}

async function buildNotesContext(admin: AdminClient, ownerId: string): Promise<string> {
  const { data: notes } = await admin
    .from("notes")
    .select("title, content")
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(NOTES_MAX_COUNT);

  if (!notes || notes.length === 0) return "";

  return notes
    .map((n) => `【${n.title || "未命名記事"}】\n${(n.content ?? "").slice(0, NOTES_MAX_CHARS_EACH)}`)
    .join("\n\n");
}

// 只給還沒完成的（todo／in_progress），已完成的不進 context，避免累積很多已完成
// 事項時把 context 灌爆（brainstorms/2026-09-22-sidebar-resize-ai-context.md Q5）。
async function buildTasksContext(admin: AdminClient, ownerId: string): Promise<string> {
  const { data: tasks } = await admin
    .from("tasks")
    .select("title, description, status")
    .eq("owner_id", ownerId)
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

async function buildFileContext(admin: AdminClient, ownerId: string): Promise<string> {
  const { data: files } = await admin
    .from("files")
    .select("id, name")
    .eq("owner_id", ownerId)
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

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// PDF 不進 buildFileContext 的文字切段流程（file-register 從來不對 PDF 做文字擷取），
// 改成把檔案本體下載下來、轉 base64，讓 provider adapter 當作原生文件輸入附加到請求裡
// （brainstorms/2026-09-23-gpt-audit-followups.md Q14/Q15）。
export async function buildPdfDocuments(admin: AdminClient, ownerId: string): Promise<DocumentAttachment[]> {
  const { data: files } = await admin
    .from("files")
    .select("bucket, object_path, name")
    .eq("owner_id", ownerId)
    .eq("status", "active")
    .eq("mime_type", "application/pdf")
    .order("created_at", { ascending: false })
    .limit(PDF_CONTEXT_MAX_FILES);

  if (!files || files.length === 0) return [];

  const documents: DocumentAttachment[] = [];
  for (const file of files) {
    const { data: blob, error } = await admin.storage.from(file.bucket).download(file.object_path);
    if (error || !blob) {
      console.error("下載 PDF 以附加原生文件輸入失敗", file.object_path, error);
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    documents.push({ name: file.name, mimeType: "application/pdf", base64: bytesToBase64(bytes) });
  }
  return documents;
}

export async function buildWorkspaceContext(admin: AdminClient, roomId: string): Promise<string> {
  const ownerId = await resolveWorkspaceOwnerId(admin, roomId);
  if (!ownerId) return "";

  const [notes, tasks, files] = await Promise.all([
    buildNotesContext(admin, ownerId),
    buildTasksContext(admin, ownerId),
    buildFileContext(admin, ownerId),
  ]);

  const sections: string[] = [];
  if (notes) sections.push(`## 記事本\n${notes}`);
  if (tasks) sections.push(`## 待辦事項（尚未完成）\n${tasks}`);
  if (files) sections.push(`## 檔案夾參考資料\n${files}`);

  return sections.join("\n\n");
}
