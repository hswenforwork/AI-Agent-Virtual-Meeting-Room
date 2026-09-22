import { ProviderHttpError, type AIProvider, type GenerateRequest, type GenerateResult, type ModelOption } from "./types.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// GET /v1beta/models 回傳的模型（包含 embedding 專用模型）都有 supportedGenerationMethods
// 這個欄位，只留下真正支援 generateContent（聊天）的那些；name 是 "models/xxx" 格式，
// 呼叫 generateContent 時要用不帶 "models/" 前綴的那段（跟 generate() 裡的 request.model 一致）。
async function listGoogleModels(apiKey: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 10; page++) {
    const url = new URL(GEMINI_API_BASE);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("Gemini list models error", res.status, body);
      throw new ProviderHttpError(res.status, body);
    }

    const data = await res.json();
    for (const m of data.models ?? []) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = (m.name as string)?.replace(/^models\//, "");
      if (!id) continue;
      models.push({ id, label: m.displayName ?? id });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return models;
}

// Gemini 的多輪對話角色是 "user"/"model"（不是 "assistant"），systemInstruction
// 是跟 contents 平行的獨立欄位，不是 contents 陣列裡的一則訊息。
export function createGoogleProvider(apiKey: string): AIProvider {
  return {
    listModels: () => listGoogleModels(apiKey),
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
