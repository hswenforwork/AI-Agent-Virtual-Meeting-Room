// Provider Adapter 介面（對應原始規劃文件 10.4 節與 docs/MVP規劃-v2.md 第 4 章）
// MVP 只實作 anthropic.ts；openai.ts / google.ts 之後補上實作即可，呼叫端不需改動。

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

export interface AIProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
