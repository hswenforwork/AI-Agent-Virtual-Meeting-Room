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

export interface UsageDailyRow {
  usage_date: string;
  room_id: string;
  agent_id: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
}

// 最小化的 Database 型別，只標註本專案用到的資料表／欄位形狀，滿足 supabase-js 的泛型即可。
export interface Database {
  public: {
    Tables: {
      profiles: { Row: ProfileRow; Insert: Partial<ProfileRow>; Update: Partial<ProfileRow> };
      rooms: { Row: RoomRow; Insert: Partial<RoomRow>; Update: Partial<RoomRow> };
      room_members: {
        Row: { room_id: string; user_id: string; role: "owner" | "member"; joined_at: string };
        Insert: { room_id: string; user_id: string; role?: "owner" | "member" };
        Update: Partial<{ role: "owner" | "member" }>;
      };
      agents: { Row: AgentRow; Insert: Partial<AgentRow>; Update: Partial<AgentRow> };
      messages: { Row: MessageRow; Insert: Partial<MessageRow>; Update: Partial<MessageRow> };
      message_mentions: {
        Row: { id: string; message_id: string; agent_id: string; created_at: string };
        Insert: { message_id: string; agent_id: string };
        Update: never;
      };
      notes: { Row: NoteRow; Insert: Partial<NoteRow>; Update: Partial<NoteRow> };
      tasks: { Row: TaskRow; Insert: Partial<TaskRow>; Update: Partial<TaskRow> };
      files: { Row: FileRow; Insert: Partial<FileRow>; Update: Partial<FileRow> };
      approval_requests: {
        Row: ApprovalRequestRow;
        Insert: Partial<ApprovalRequestRow>;
        Update: Partial<ApprovalRequestRow>;
      };
      usage_daily: {
        Row: UsageDailyRow;
        Insert: Partial<UsageDailyRow>;
        Update: Partial<UsageDailyRow>;
      };
    };
  };
}
