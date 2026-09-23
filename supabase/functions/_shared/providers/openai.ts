import {
  ProviderHttpError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
  type StreamUsage,
  type ToolCall,
  type ToolDefinition,
} from "./types.ts";
import { readSseStream } from "../sse.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// GET /v1/models 回傳這個帳號能用的所有模型，聊天模型跟 embedding／audio／image／
// moderation 等專用模型混在一起、沒有欄位標明用途，只能靠 id 本身的命名規則過濾。
// 這份規則本身也可能過期，但風險比「整組模型清單寫死在程式碼裡」小很多——
// 頂多多顯示/少顯示幾個邊緣情況，不會出現「選了一個已經不存在的模型」這種硬錯誤。
function isChatModel(id: string): boolean {
  if (!/^(gpt-|o[0-9]|chatgpt-)/i.test(id)) return false;
  return !/embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image/i.test(id);
}

async function listOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("OpenAI list models error", res.status, body);
    throw new ProviderHttpError(res.status, body);
  }

  const data = await res.json();
  return (data.data ?? [])
    .map((m: { id: string }) => m.id)
    .filter(isChatModel)
    .sort()
    .map((id: string) => ({ id, label: id }));
}

type OpenAIContentPart = { type: "text"; text: string } | { type: "file"; file: { filename: string; file_data: string } };

// PDF 走 Chat Completions 原生的 file content part（brainstorms/2026-09-23-gpt-audit-followups.md
// Q14/Q15）：file_data 是完整的 data URL 字串（含 mime type 前綴），不是單獨欄位；
// 官方範例都有帶 filename，論壇回報沒帶會直接出錯，所以一定要帶。
function buildOpenAIMessages(request: GenerateRequest) {
  const built: { role: string; content: string | OpenAIContentPart[] }[] = [
    { role: "system", content: request.systemPrompt },
    ...request.messages.map((m) => ({ role: m.role as string, content: m.content as string | OpenAIContentPart[] })),
  ];

  if (!request.documents || request.documents.length === 0) return built;

  const lastUserIndex = built.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return built;

  const original = built[lastUserIndex];
  const originalText = typeof original.content === "string" ? original.content : "";
  const parts: OpenAIContentPart[] = request.documents.map((doc) => ({
    type: "file",
    file: { filename: doc.name, file_data: `data:${doc.mimeType};base64,${doc.base64}` },
  }));
  parts.push({ type: "text", text: originalText });
  built[lastUserIndex] = { role: "user", content: parts };
  return built;
}

function buildOpenAITools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function parseOpenAIToolCall(toolCalls: unknown): ToolCall | undefined {
  const call = Array.isArray(toolCalls) ? (toolCalls[0] as { function?: { name?: string; arguments?: string } }) : undefined;
  if (!call?.function?.name) return undefined;
  try {
    return { name: call.function.name, input: JSON.parse(call.function.arguments || "{}") };
  } catch (err) {
    console.error("解析 OpenAI tool_calls 參數失敗", call.function.name, err);
    return undefined;
  }
}

export function createOpenAIProvider(apiKey: string): AIProvider {
  return {
    listModels: () => listOpenAIModels(apiKey),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          max_completion_tokens: request.maxOutputTokens,
          messages: buildOpenAIMessages(request),
          tools: buildOpenAITools(request.tools),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("OpenAI API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      const data = await res.json();
      const message = data.choices?.[0]?.message;
      const text = message?.content ?? "";

      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        toolCall: parseOpenAIToolCall(message?.tool_calls),
      };
    },
    async generateStream(request: GenerateRequest, onDelta: (textDelta: string) => void): Promise<StreamUsage> {
      const res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          max_completion_tokens: request.maxOutputTokens,
          stream: true,
          // 沒有這個欄位，串流過程完全拿不到用量數字（不是逐段給、也不是預設附加最後一包）。
          stream_options: { include_usage: true },
          messages: buildOpenAIMessages(request),
          tools: buildOpenAITools(request.tools),
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        console.error("OpenAI streaming API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      // tool_calls 串流時是用 index 分開、逐段補上 name/arguments 片段（跟文字 delta 一樣是
      // 累加式的），要收完整個串流才有完整的 function 名稱跟參數 JSON 字串可以解析。
      const toolCallAccum = new Map<number, { name: string; argsAccum: string }>();

      await readSseStream(res.body, (raw) => {
        if (raw === "[DONE]") return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        const choices = data.choices as
          | { delta?: { content?: string; tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[] } }[]
          | undefined;
        const delta = choices?.[0]?.delta;
        if (delta?.content) onDelta(delta.content);
        for (const tc of delta?.tool_calls ?? []) {
          const existing = toolCallAccum.get(tc.index) ?? { name: "", argsAccum: "" };
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsAccum += tc.function.arguments;
          toolCallAccum.set(tc.index, existing);
        }

        // 最後一包（choices 是空陣列）才會帶完整 usage
        const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
      });

      let toolCall: ToolCall | undefined;
      const first = toolCallAccum.get(0);
      if (first?.name) {
        try {
          toolCall = { name: first.name, input: JSON.parse(first.argsAccum || "{}") };
        } catch (err) {
          console.error("解析 OpenAI 串流 tool_calls 參數失敗", first.name, err);
        }
      }

      return { usage: { inputTokens, outputTokens }, toolCall };
    },
  };
}
