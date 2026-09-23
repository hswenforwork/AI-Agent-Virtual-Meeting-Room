// Provider Adapter 介面（對應原始規劃文件 10.4 節與 docs/MVP規劃-v2.md 第 4 章）
// anthropic.ts / openai.ts / google.ts 三個供應商共用同一介面，呼叫端（agent-run）
// 依 agent.provider 選對應的 create*Provider() 即可，不需要改動呼叫邏輯。

export class ProviderHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q4：三家供應商真正的 tool use，
// 目前只有一個工具（loop_in_agent，見 agentCollaboration.ts），先用固定的簡單 JSON Schema
// 形狀（object + string properties + enum），不需要更複雜的巢狀結構。
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

// 對應 brainstorms/2026-09-23-gpt-audit-followups.md Q14/Q15：PDF 走三家供應商各自的
// 原生文件輸入（base64），不再靠本地解析庫擷取文字。附加到 messages 裡最後一則
// user 訊息的內容前面（三家的文件輸入都是「訊息內容的一個 block」，不是獨立欄位）。
export interface DocumentAttachment {
  name: string;
  mimeType: string;
  base64: string;
}

export interface GenerateRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  model: string;
  maxOutputTokens: number;
  tools?: ToolDefinition[];
  documents?: DocumentAttachment[];
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCall?: ToolCall;
}

export interface ProviderError {
  status: number;
  raw: unknown;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface StreamUsage {
  usage: { inputTokens: number; outputTokens: number };
  toolCall?: ToolCall;
}

export interface AIProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  // 對應 brainstorms/2026-09-22-provider-model-selection.md：即時呼叫供應商自己的
  // 模型清單 API，不維護一份會過期的精選清單（今天才踩到 gemini-2.5-flash 過期的教訓）。
  listModels(): Promise<ModelOption[]>;
  // 對應 brainstorms/2026-09-22-streaming-replies.md：串流版本的 generate()，每收到一段
  // 文字就呼叫 onDelta，全部結束後 resolve 最終用量（三家供應商的用量資訊都只在串流的
  // 最後才會拿到完整數字，過程中不用逐段累計）。
  // signal：停止回覆功能用（brainstorms/2026-09-23-stop-generation.md），呼叫端偵測到使用者
  // 按下停止時 abort() 這個 signal，fetch 會直接中止連線，不用等供應商自然把這輪串流送完。
  generateStream(
    request: GenerateRequest,
    onDelta: (textDelta: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamUsage>;
}
