// Anthropic Managed Agents（CMA，beta）薄封裝：只做這個專案「工作型代理」用得到的幾個呼叫。
// 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q4 架構修正：
// 代理設定（agent）跟環境（environment）是一次性設定好、存成 Secrets 的資源（見 scripts/setup-managed-agent.md），
// 這裡只處理「每次任務」會用到的 session 建立／事件收送／輸出檔案下載。

const CMA_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const CMA_BETA = "managed-agents-2026-04-01";
const FILES_BETA = "files-api-2025-04-14";

function cmaHeaders(apiKey: string, extraBetas: string[] = []) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": [CMA_BETA, ...extraBetas].join(","),
  };
}

export class ManagedAgentsError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Managed Agents API 錯誤 ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function cmaFetch(apiKey: string, path: string, init: RequestInit) {
  const res = await fetch(`${CMA_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ManagedAgentsError(res.status, body);
  }
  return res;
}

// 對應 brainstorms/2026-09-22-user-api-key-settings.md Q9/Q10：Managed Agents 的
// agent／environment 綁定建立時所用的 Anthropic 帳號，每個使用者第一次觸發工作型代理時
// 要用自己的金鑰建立一份專屬的，不能繼續共用部署者當初手動跑 scripts/setup-managed-agent.sh
// 建好的那一套。這兩個函式把該腳本的建立邏輯原封不動搬進程式碼執行。

export interface CreateEnvironmentResult {
  id: string;
}

export async function createManagedEnvironment(apiKey: string): Promise<CreateEnvironmentResult> {
  const res = await cmaFetch(apiKey, "/environments", {
    method: "POST",
    headers: cmaHeaders(apiKey),
    body: JSON.stringify({
      name: "ai-collab-room-worker-env",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
      },
    }),
  });
  return await res.json();
}

export interface CreateAgentResult {
  id: string;
}

export async function createManagedAgent(apiKey: string, model: string): Promise<CreateAgentResult> {
  const res = await cmaFetch(apiKey, "/agents", {
    method: "POST",
    headers: cmaHeaders(apiKey),
    body: JSON.stringify({
      name: "AI 協作室工作型代理",
      model,
      system:
        "你是「AI 協作室」聊天室裡的工作型代理，負責實際動手完成使用者交辦的任務（寫程式、修 bug、整理/產生檔案、部署等）。完成後把最終產出的檔案寫到 /mnt/session/outputs/。若同一個問題已經嘗試修正 3 次以上仍然卡住，呼叫 consult_other_ai 工具求助另一位 AI，不需要等待使用者回應。全部完成後，最後一則訊息用「SUMMARY: 」開頭簡短總結成果。",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { permission_policy: { type: "always_allow" } },
        },
        {
          type: "custom",
          name: "consult_other_ai",
          description:
            "當你卡住、同一個問題已經嘗試修正 3 次以上仍無法解決時，呼叫這個工具，提供完整的問題描述、已嘗試過的方法、錯誤訊息，向另一位 AI（Gemini）求助分析與建議。",
          input_schema: {
            type: "object",
            properties: {
              problem_description: { type: "string", description: "卡住的問題完整描述" },
              attempted_solutions: { type: "string", description: "已經嘗試過的解法" },
              error_details: { type: "string", description: "遇到的錯誤訊息或現象" },
            },
            required: ["problem_description", "attempted_solutions", "error_details"],
          },
        },
      ],
    }),
  });
  return await res.json();
}

// 更新既有 agent 的 model（對應 brainstorms/2026-09-22-provider-model-selection.md Q8/Q9：
// 使用者在「設定」頁改了偏好的 Claude 模型，順便同步這個使用者已經建好的 Managed Agent）。
// 官方文件：更新是 POST /v1/agents/{agent_id}（不是 PATCH/PUT），只送要改的欄位就好，
// 每次更新會建立一個新的版本（agent 本身是有版本歷史的物件），已經釘住舊版本的 session 不受影響。
export async function updateManagedAgentModel(apiKey: string, agentId: string, model: string): Promise<void> {
  await cmaFetch(apiKey, `/agents/${agentId}`, {
    method: "POST",
    headers: cmaHeaders(apiKey),
    body: JSON.stringify({ model }),
  });
}

export interface CreateSessionOptions {
  apiKey: string;
  agentId: string;
  environmentId: string;
  title?: string;
  initialUserMessage: string;
  githubRepo?: { url: string; token: string; branch?: string };
}

export async function createSession(opts: CreateSessionOptions): Promise<{ id: string }> {
  const resources = opts.githubRepo
    ? [
        {
          type: "github_repository",
          url: opts.githubRepo.url,
          authorization_token: opts.githubRepo.token,
          ...(opts.githubRepo.branch ? { checkout: { type: "branch", name: opts.githubRepo.branch } } : {}),
        },
      ]
    : undefined;

  const res = await cmaFetch(opts.apiKey, "/sessions", {
    method: "POST",
    headers: cmaHeaders(opts.apiKey),
    body: JSON.stringify({
      agent: { type: "agent", id: opts.agentId },
      environment_id: opts.environmentId,
      title: opts.title,
      resources,
      initial_events: [
        { type: "user.message", content: [{ type: "text", text: opts.initialUserMessage }] },
      ],
    }),
  });
  return await res.json();
}

export async function sendCustomToolResult(
  apiKey: string,
  sessionId: string,
  toolUseId: string,
  resultText: string,
) {
  await cmaFetch(apiKey, `/sessions/${sessionId}/events`, {
    method: "POST",
    headers: cmaHeaders(apiKey),
    body: JSON.stringify({
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [{ type: "text", text: resultText }],
        },
      ],
    }),
  });
}

export async function archiveSession(apiKey: string, sessionId: string) {
  await cmaFetch(apiKey, `/sessions/${sessionId}/archive`, {
    method: "POST",
    headers: cmaHeaders(apiKey),
  });
}

export type CmaEvent = Record<string, unknown> & { type: string };

// 讀取 SSE 事件串流，逐一 yield 已解析的事件物件。
// 對應官方文件「stream-first」建議：呼叫端要在送出 initial_events 前後盡快打開這個串流，
// 但這裡因為用 initial_events 建立 session（session 一建立就直接進 running），
// 背景任務改在 session 建立完成後立刻打開串流即可，接收不到的早期事件損失在可接受範圍內（MVP）。
export async function* streamSessionEvents(
  apiKey: string,
  sessionId: string,
): AsyncGenerator<CmaEvent> {
  const res = await fetch(`${CMA_BASE}/sessions/${sessionId}/events/stream`, {
    headers: { ...cmaHeaders(apiKey), accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new ManagedAgentsError(res.status, body);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;

        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          yield parsed;
        } catch (err) {
          console.error("解析 CMA 事件失敗", err, rawEvent);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface OutputFile {
  id: string;
  filename: string;
  size_bytes: number;
}

export async function listSessionOutputFiles(apiKey: string, sessionId: string): Promise<OutputFile[]> {
  const res = await cmaFetch(apiKey, `/files?scope_id=${encodeURIComponent(sessionId)}`, {
    headers: cmaHeaders(apiKey, [FILES_BETA]),
  });
  const data = await res.json();
  return data.data ?? [];
}

export async function downloadFile(apiKey: string, fileId: string): Promise<Uint8Array> {
  const res = await cmaFetch(apiKey, `/files/${fileId}/content`, {
    headers: cmaHeaders(apiKey, [FILES_BETA]),
  });
  return new Uint8Array(await res.arrayBuffer());
}
