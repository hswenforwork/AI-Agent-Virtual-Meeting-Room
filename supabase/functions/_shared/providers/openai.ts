import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult, type ModelOption } from "./types.ts";

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
  };
}
