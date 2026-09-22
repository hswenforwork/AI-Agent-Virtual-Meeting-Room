import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult, type ModelOption } from "./types.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

export { ProviderHttpError };

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
  };
}
