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

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

// PDF 走原生文件輸入（brainstorms/2026-09-23-gpt-audit-followups.md Q14/Q15）：inlineData
// part 放在最後一則 user 訊息的 parts 最前面（純 base64，不是 data URL）。
function buildGeminiContents(messages: GenerateRequest["messages"], documents?: DocumentAttachment[]) {
  const built = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }] as GeminiPart[],
  }));

  if (!documents || documents.length === 0) return built;

  const lastUserIndex = [...built].map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return built;

  const docParts: GeminiPart[] = documents.map((doc) => ({
    inlineData: { mimeType: doc.mimeType, data: doc.base64 },
  }));
  built[lastUserIndex] = { role: "user", parts: [...docParts, ...built[lastUserIndex].parts] };
  return built;
}

function buildGeminiTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: "OBJECT",
          properties: Object.fromEntries(
            Object.entries(t.parameters.properties).map(([key, prop]) => [
              key,
              { type: prop.type.toUpperCase(), description: prop.description, enum: prop.enum },
            ]),
          ),
          required: t.parameters.required,
        },
      })),
    },
  ];
}

function extractGeminiToolCall(parts: { functionCall?: { name: string; args: Record<string, unknown> } }[]): ToolCall | undefined {
  const withCall = parts.find((p) => p.functionCall);
  if (!withCall?.functionCall) return undefined;
  return { name: withCall.functionCall.name, input: withCall.functionCall.args ?? {} };
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
            contents: buildGeminiContents(request.messages, request.documents),
            tools: buildGeminiTools(request.tools),
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
      const parts = (data.candidates?.[0]?.content?.parts ?? []) as {
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
      }[];
      const text = parts.map((p) => p.text ?? "").join("\n");

      return {
        text,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        toolCall: extractGeminiToolCall(parts),
      };
    },
    async generateStream(request: GenerateRequest, onDelta: (textDelta: string) => void): Promise<StreamUsage> {
      const res = await fetch(
        `${GEMINI_API_BASE}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: buildGeminiContents(request.messages, request.documents),
            tools: buildGeminiTools(request.tools),
            generationConfig: { maxOutputTokens: request.maxOutputTokens },
          }),
        },
      );

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        console.error("Gemini streaming API error", res.status, body);
        throw new ProviderHttpError(res.status, body);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let toolCall: ToolCall | undefined;

      await readSseStream(res.body, (raw) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        const candidates = data.candidates as
          | { content?: { parts?: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[] } }[]
          | undefined;
        const parts = candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("");
        if (text) onDelta(text);
        if (!toolCall) toolCall = extractGeminiToolCall(parts);

        // usageMetadata 每一包都會帶，但數字是累計值（不是逐段增量），取最後一次收到的就好
        const usageMetadata = data.usageMetadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number }
          | undefined;
        if (usageMetadata) {
          inputTokens = usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      });

      return { usage: { inputTokens, outputTokens }, toolCall };
    },
  };
}
