import {
  ProviderHttpError,
  type AIProvider,
  type DocumentAttachment,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
  type StreamUsage,
  type ToolCall,
  type ToolDefinition,
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

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } };

// PDF 走原生文件輸入（brainstorms/2026-09-23-gpt-audit-followups.md Q14/Q15），document
// content block 放在最後一則 user 訊息的內容最前面（Anthropic 官方文件要求文件在文字之前）。
function buildAnthropicMessages(messages: GenerateRequest["messages"], documents?: DocumentAttachment[]) {
  const built = messages.map((m) => ({ role: m.role, content: m.content as string | AnthropicContentBlock[] }));
  if (!documents || documents.length === 0) return built;

  const lastUserIndex = [...built].map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return built;

  const original = built[lastUserIndex];
  const originalText = typeof original.content === "string" ? original.content : "";
  const blocks: AnthropicContentBlock[] = documents.map((doc) => ({
    type: "document",
    source: { type: "base64", media_type: doc.mimeType, data: doc.base64 },
  }));
  blocks.push({ type: "text", text: originalText });
  built[lastUserIndex] = { role: "user", content: blocks };
  return built;
}

function buildAnthropicTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

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
          messages: buildAnthropicMessages(request.messages, request.documents),
          tools: buildAnthropicTools(request.tools),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("Anthropic API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      const data = await res.json();
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("\n");
      const toolUseBlock = content.find((block: { type: string }) => block.type === "tool_use") as
        | { name: string; input: Record<string, unknown> }
        | undefined;

      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
        toolCall: toolUseBlock ? { name: toolUseBlock.name, input: toolUseBlock.input } : undefined,
      };
    },
    async generateStream(
      request: GenerateRequest,
      onDelta: (textDelta: string) => void,
      signal?: AbortSignal,
    ): Promise<StreamUsage> {
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
          messages: buildAnthropicMessages(request.messages, request.documents),
          tools: buildAnthropicTools(request.tools),
          stream: true,
        }),
        signal,
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        console.error("Anthropic streaming API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let streamError: { status: number; body: string } | null = null;
      // tool_use 的 input 是用 input_json_delta 逐段送 partial_json 字串，要照 content block
      // 的 index 分開累積，content_block_stop 時才把累積出來的 JSON 字串解析成物件
      // （brainstorms/2026-09-23-gpt-audit-followups.md Q4：loop-in 工具呼叫本身不用串流
      // 顯示給使用者看，只要結束後知道呼叫了哪個工具、參數是什麼）。
      const toolBlocks = new Map<number, { name: string; jsonAccum: string }>();
      let toolCall: ToolCall | undefined;

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
          case "content_block_start": {
            const block = data.content_block as { type?: string; name?: string } | undefined;
            const index = data.index as number | undefined;
            if (block?.type === "tool_use" && typeof index === "number" && block.name) {
              toolBlocks.set(index, { name: block.name, jsonAccum: "" });
            }
            break;
          }
          case "content_block_delta": {
            const index = data.index as number | undefined;
            const delta = data.delta as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) onDelta(delta.text);
            if (delta?.type === "input_json_delta" && typeof index === "number" && delta.partial_json) {
              const pending = toolBlocks.get(index);
              if (pending) pending.jsonAccum += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const index = data.index as number | undefined;
            if (typeof index === "number" && toolBlocks.has(index) && !toolCall) {
              const pending = toolBlocks.get(index)!;
              try {
                toolCall = { name: pending.name, input: JSON.parse(pending.jsonAccum || "{}") };
              } catch (err) {
                console.error("解析 Anthropic tool_use 輸入失敗", pending.name, err);
              }
            }
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
          // ping、message_stop、其他未知型別一律忽略
          // （官方文件明確要求：未知事件類型要能容忍，不能直接丟例外）
        }
      });

      if (streamError) {
        throw new ProviderHttpError(streamError.status, streamError.body);
      }

      return { usage: { inputTokens, outputTokens }, toolCall };
    },
  };
}
