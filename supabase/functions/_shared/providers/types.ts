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

export interface GenerateRequest {
  systemPrompt: string;
  messages: ChatMessage[];
  model: string;
  maxOutputTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ProviderError {
  status: number;
  raw: unknown;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AIProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  // 對應 brainstorms/2026-09-22-provider-model-selection.md：即時呼叫供應商自己的
  // 模型清單 API，不維護一份會過期的精選清單（今天才踩到 gemini-2.5-flash 過期的教訓）。
  listModels(): Promise<ModelOption[]>;
}
