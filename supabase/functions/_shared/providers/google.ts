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

// 對應 brainstorms/2026-09-23-gemini-503-retry.md：Gemini API 常見的「high demand，
// 暫時無法使用」是官方自己回報的 503 UNAVAILABLE（訊息明講「Spikes in demand are
// usually temporary. Please try again later.」），跟金鑰、額度、程式邏輯都無關，重試
// 一兩次通常就會過。429（RESOURCE_EXHAUSTED，短暫的速率限制）也是同一種可重試的錯誤。
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 700;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// generate()／generateStream() 共用：遇到 429/503 這種暫時性錯誤時，消耗掉這次回應的
// body（避免連線資源沒釋放）、等一段時間（指數退避）再重試，最多重試 MAX_RETRIES 次；
// 其他狀態碼（包含金鑰無效、額度用完等不會自己好的錯誤）或已經用完重試次數，直接把
// 這次的 Response 原封不動回傳給呼叫端，讓既有的 !res.ok 判斷跟 ProviderHttpError
// 邏輯照舊處理，不用另外重寫一份錯誤處理。
async function fetchWithGeminiRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_RETRIES) {
      return res;
    }
    await res.text().catch(() => {});
    const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
    console.error(`Gemini API 暫時無法使用（${res.status}），${delay}ms 後重試（第 ${attempt + 1} 次）`);
    await sleep(delay, (init.signal as AbortSignal | null) ?? undefined);
  }
}

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

// 回報「@Gemini 一律顯示（沒有回應內容）」（brainstorms/2026-09-23-gemini-empty-response-fix.md）：
// -flash／-flash-lite 這幾代模型預設會啟用「思考」，而思考消耗的 token 算在同一個
// maxOutputTokens 額度裡——開放式的提問（例如「自我介紹」）常常整個額度都花在思考上，
// 完全沒有剩餘額度輸出看得到的文字，回應就會是空的（finishReason 通常是 MAX_TOKENS）。
// 這個專案的其他兩家供應商（Anthropic／OpenAI）目前都沒有主動要求延伸思考，這裡關掉
// Gemini 的思考讓三家行為一致，也把額度全部留給看得到的回覆內容。
// -pro 這一代的思考無法完全關閉（設 0 會被拒絕），只針對 -flash/-flash-lite 關閉。
function buildGeminiGenerationConfig(maxOutputTokens: number, model: string) {
  const config: Record<string, unknown> = { maxOutputTokens };
  if (/flash/i.test(model)) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  return config;
}

// 同樣對應上面那份設計紀錄：回應完全沒有文字、也沒有呼叫工具時，把 finishReason／
// safetyRatings 印出來，方便之後真的再發生時能直接從 log 看出是額度被思考吃光、
// 被安全機制擋下、還是其他原因，不用只看到一個「（沒有回應內容）」乾瞪眼。
function logEmptyGeminiResponse(context: string, candidate: Record<string, unknown> | undefined) {
  console.error(
    "Gemini 回應沒有任何文字內容",
    context,
    "finishReason:",
    candidate?.finishReason,
    "safetyRatings:",
    candidate?.safetyRatings,
  );
}

// Gemini 的多輪對話角色是 "user"/"model"（不是 "assistant"），systemInstruction
// 是跟 contents 平行的獨立欄位，不是 contents 陣列裡的一則訊息。
export function createGoogleProvider(apiKey: string): AIProvider {
  return {
    listModels: () => listGoogleModels(apiKey),
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const res = await fetchWithGeminiRetry(
        `${GEMINI_API_BASE}/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: buildGeminiContents(request.messages, request.documents),
            tools: buildGeminiTools(request.tools),
            generationConfig: buildGeminiGenerationConfig(request.maxOutputTokens, request.model),
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
      if (!text && !extractGeminiToolCall(parts)) logEmptyGeminiResponse("generate()", data.candidates?.[0]);

      return {
        text,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        toolCall: extractGeminiToolCall(parts),
      };
    },
    async generateStream(
      request: GenerateRequest,
      onDelta: (textDelta: string) => void,
      signal?: AbortSignal,
    ): Promise<StreamUsage> {
      const res = await fetchWithGeminiRetry(
        `${GEMINI_API_BASE}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: buildGeminiContents(request.messages, request.documents),
            tools: buildGeminiTools(request.tools),
            generationConfig: buildGeminiGenerationConfig(request.maxOutputTokens, request.model),
          }),
          signal,
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
      let sawAnyText = false;
      let lastCandidate: Record<string, unknown> | undefined;

      await readSseStream(res.body, (raw) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }

        const candidates = data.candidates as
          | ({ content?: { parts?: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }[] } } & Record<string, unknown>)[]
          | undefined;
        lastCandidate = candidates?.[0];
        const parts = lastCandidate?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("");
        if (text) {
          sawAnyText = true;
          onDelta(text);
        }
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

      if (!sawAnyText && !toolCall) logEmptyGeminiResponse("generateStream()", lastCandidate);

      return { usage: { inputTokens, outputTokens }, toolCall };
    },
  };
}
