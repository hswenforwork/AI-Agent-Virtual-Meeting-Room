import {
  ProviderHttpError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type ModelOption,
  type StreamUsage,
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
          messages: [
            { role: "system", content: request.systemPrompt },
            ...request.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("OpenAI API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "";

      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
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
          messages: [
            { role: "system", content: request.systemPrompt },
            ...request.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        console.error("OpenAI streaming API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      let inputTokens = 0;
      let outputTokens = 0;

      await readSseStream(res.body, (raw) => {
        if (raw === "[DONE]") return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        const choices = data.choices as { delta?: { content?: string } }[] | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);

        // 最後一包（choices 是空陣列）才會帶完整 usage
        const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
      });

      return { usage: { inputTokens, outputTokens } };
    },
  };
}
