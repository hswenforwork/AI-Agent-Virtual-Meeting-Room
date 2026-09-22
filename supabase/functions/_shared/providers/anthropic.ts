import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult } from "./types.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export { ProviderHttpError };

export function createAnthropicProvider(apiKey: string): AIProvider {
  return {
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
