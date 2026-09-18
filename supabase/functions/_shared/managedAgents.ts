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
