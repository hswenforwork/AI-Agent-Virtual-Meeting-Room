import {
  ProviderHttpError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
  type StreamUsage,
} from "./types.ts";
import { readSseStream } from "../sse.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

export { ProviderHttpError };

// Anthropic 串流中途也會用 `event: error` 回傳錯誤（不是只有 HTTP 層級的錯誤），
// 依官方文件目前定義的 error.type 對應到具代表性的 HTTP 狀態碼，讓下游的
// friendlyProviderError() 能分辨是金鑰問題／額度問題／供應商暫時不可用。
const ANTHROPIC_STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
};

// GET /v1/models 回傳的都已經是聊天用的 Claude 模型（type 一律是 "model"），不用額外過濾；
// 用 after_id 分頁把所有頁抓完（比照 has_more/last_id 這個 Anthropic 慣用的分頁慣例）。
async function listAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  let afterId: string | undefined;

  for (let page = 0; page < 10; page++) {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);

    const res = await fetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Anthropic list models error", res.status, body);
      throw new ProviderHttpError(res.status, body);
    }

    const data = await res.json();
    for (const m of data.data ?? []) {
      models.push({ id: m.id, label: m.display_name ?? m.id });
    }
    if (!data.has_more || !data.last_id) break;
    afterId = data.last_id;
  }

  return models;
}

export function createAnthropicProvider(apiKey: string): AIProvider {
  return {
    listModels: () => listAnthropicModels(apiKey),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          system: request.systemPrompt,
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("Anthropic API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      const data = await res.json();
      const text = Array.isArray(data.content)
        ? data.content
            .filter((block: { type: string }) => block.type === "text")
            .map((block: { text: string }) => block.text)
            .join("\n")
        : "";

      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
    async generateStream(request: GenerateRequest, onDelta: (textDelta: string) => void): Promise<StreamUsage> {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          system: request.systemPrompt,
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        console.error("Anthropic streaming API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let streamError: { status: number; body: string } | null = null;

      await readSseStream(res.body, (raw) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          return; // 理論上不該發生，防禦性忽略解析不出來的片段
        }

        switch (data.type) {
          case "message_start": {
            const usage = (data.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
            inputTokens = usage?.input_tokens ?? 0;
            break;
          }
          case "content_block_delta": {
            const delta = data.delta as { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) onDelta(delta.text);
            break;
          }
          case "message_delta": {
            const usage = data.usage as { output_tokens?: number } | undefined;
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
            break;
          }
          case "error": {
            const error = data.error as { type?: string; message?: string } | undefined;
            const status = (error?.type && ANTHROPIC_STREAM_ERROR_STATUS[error.type]) ?? 500;
            streamError = { status, body: JSON.stringify(error ?? data) };
            break;
          }
          // ping、content_block_start/stop、message_stop、其他未知型別一律忽略
          // （官方文件明確要求：未知事件類型要能容忍，不能直接丟例外）
        }
      });

      if (streamError) {
        throw new ProviderHttpError(streamError.status, streamError.body);
      }

      return { usage: { inputTokens, outputTokens } };
    },
  };
}
