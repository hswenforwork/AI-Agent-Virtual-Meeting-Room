import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult } from "./types.ts";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

export function createOpenAIProvider(apiKey: string): AIProvider {
  return {
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
