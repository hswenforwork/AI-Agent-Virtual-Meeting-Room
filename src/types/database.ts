// 手寫的簡化型別，對應 supabase/migrations/0001_init.sql。
// 之後接上真實 Supabase 專案後，建議改用 `supabase gen types typescript` 產生的型別取代這份檔案。

export type SenderType = "user" | "agent" | "system";
export type MessageStatus = "pending" | "streaming" | "completed" | "failed";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rate_limited"
  | "cancelled";
export type TaskStatus = "todo" | "in_progress" | "done";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

export interface ProfileRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  last_message_at: string;
  title_generated: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  room_id: string;
  slug: string;
  name: string;
  provider: "anthropic" | "openai" | "google";
  status: "active" | "inactive";
  is_supervisor: boolean;
  system_prompt: string;
  model_config: Record<string, unknown>;
  created_at: string;
}

export type MessageKind = "chat" | "task_card";
export type WorkerTaskStatus = "pending_confirmation" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TaskCardMetadata {
  status?: WorkerTaskStatus;
  taskSummary?: string;
  workerTaskId?: string;
  sessionId?: string;
  progressLog?: string[];
  outputs?: { name: string; fileId: string }[];
}

export interface MessageRow {
  id: string;
  room_id: string;
  sender_type: SenderType;
  sender_user_id: string | null;
  sender_agent_id: string | null;
  content: string;
  status: MessageStatus;
  reply_to_id: string | null;
  client_id: string | null;
  kind: MessageKind;
  metadata: TaskCardMetadata;
  created_at: string;
}

export interface NoteRow {
  id: string;
  room_id: string;
  title: string;
  content: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  room_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  room_id: string;
  bucket: string;
  object_path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  status: "active" | "deleted";
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ApprovalRequestRow {
  id: string;
  room_id: string;
  run_id: string | null;
  requested_by: string | null;
  tool_name: string;
  arguments_json: Record<string, unknown>;
  risk_level: "medium" | "high";
  status: ApprovalStatus;
  expires_at: string | null;
  created_at: string;
}

export interface UserProviderKeyRow {
  id: string;
  user_id: string;
  provider: "anthropic" | "openai" | "google";
  updated_at: string;
  created_at: string;
}

export interface UsageDailyRow {
  usage_date: string;
  room_id: string;
  agent_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
}
