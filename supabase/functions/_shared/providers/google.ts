import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult } from "./types.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Gemini 的多輪對話角色是 "user"/"model"（不是 "assistant"），systemInstruction
// 是跟 contents 平行的獨立欄位，不是 contents 陣列裡的一則訊息。
export function createGoogleProvider(apiKey: string): AIProvider {
  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const res = await fetch(
        `${GEMINI_API_BASE}/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: request.messages.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: { maxOutputTokens: request.maxOutputTokens },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("Gemini API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n");

      return {
        text,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}
