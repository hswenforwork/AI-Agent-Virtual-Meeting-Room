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
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "executed"
  | "failed";

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
  // 對話自動摘要（brainstorms/2026-09-23-gpt-audit-followups.md Q11-Q13）
  conversation_summary: string;
  summary_covered_until: string | null;
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
  // 訊息泡泡顯示 token 用量（brainstorms/2026-09-23-message-token-usage-display.md）：
  // 只有一般聊天回覆跟 task_card 才會有值；上線前的舊訊息跟 workspace_write 短確認
  // 一律是 null，前端不顯示任何提示。
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

// room_id 是可為 null 的「來源房間」參考欄位（brainstorms/2026-09-23-gpt-audit-followups.md
// Q1）：owner_id 才是真正的歸屬，來源房間被刪除時 room_id 會變成 null，資料本身不受影響。
export interface NoteRow {
  id: string;
  room_id: string | null;
  owner_id: string;
  title: string;
  content: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  room_id: string | null;
  owner_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  room_id: string | null;
  owner_id: string;
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
  selected_model: string | null;
  cached_models: { id: string; label: string }[];
  models_fetched_at: string | null;
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

// 跨聊天室共享知識系統（docs/AI-Partner借鏡對照.md、supabase/migrations/0020_shared_knowledge.sql）
export type KnowledgeCategory = "goal" | "project" | "term" | "rule" | "fact" | "other";
export type KnowledgeItemStatus = "active" | "archived";
export type DecisionStatus = "active" | "superseded";
export type KnowledgeSourceType = "message" | "note" | "task" | "file" | "external_url";
export type KnowledgeSourceStatus = "valid" | "stale" | "invalid";
export type KnowledgeRelation = "related" | "supports" | "depends_on" | "contradicts" | "supersedes";
export type KnowledgeLinkStatus = "confirmed" | "proposed";
export type KnowledgeProposalType = "knowledge" | "decision" | "correction" | "question" | "link";
export type KnowledgeProposalStatus = "pending" | "accepted" | "edited" | "rejected";

export interface KnowledgeItemRow {
  id: string;
  owner_id: string;
  category: KnowledgeCategory;
  title: string;
  body: string;
  status: KnowledgeItemStatus;
  expires_at: string | null;
  review_interval_days: number | null;
  source_room_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string;
  origin_proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionRow {
  id: string;
  owner_id: string;
  title: string;
  decision_text: string;
  reasoning: string;
  alternatives: string | null;
  status: DecisionStatus;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  decided_at: string;
  source_room_id: string | null;
  created_by: string | null;
  origin_proposal_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSourceRow {
  id: string;
  owner_id: string;
  subject_type: "knowledge_item" | "decision";
  subject_id: string;
  source_type: KnowledgeSourceType;
  room_id: string | null;
  message_id: string | null;
  note_id: string | null;
  task_id: string | null;
  file_id: string | null;
  external_url: string | null;
  verified: boolean;
  content_snapshot: string | null;
  status: KnowledgeSourceStatus;
  created_at: string;
  last_checked_at: string | null;
  checked_by: string | null;
}

export interface KnowledgeLinkRow {
  id: string;
  owner_id: string;
  from_type: "knowledge_item" | "decision";
  from_id: string;
  to_type: "knowledge_item" | "decision";
  to_id: string;
  relation: KnowledgeRelation;
  status: KnowledgeLinkStatus;
  reasoning: string | null;
  created_by: string | null;
  proposed_by_agent_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  origin_proposal_id: string | null;
  created_at: string;
}

export interface KnowledgeProposalRow {
  id: string;
  owner_id: string;
  proposal_type: KnowledgeProposalType;
  payload: Record<string, unknown>;
  reasoning: string;
  source_message_id: string | null;
  source_room_id: string | null;
  proposed_by_agent_id: string | null;
  status: KnowledgeProposalStatus;
  resolved_knowledge_item_id: string | null;
  resolved_decision_id: string | null;
  resolved_link_id: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface KnowledgeAuditFinding {
  finding_id: string;
  category: string;
  severity: "confirmed" | "needs_review" | "suggestion";
  message: string;
  evidence: Record<string, unknown>;
}

export interface KnowledgeAuditReportRow {
  id: string;
  owner_id: string;
  run_at: string;
  triggered_by: "manual" | "schedule";
  summary: string;
  findings: KnowledgeAuditFinding[];
  stats: Record<string, number>;
  created_at: string;
}
