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

export const CONSULT_TOOL_NAME = "consult_other_ai";
// 工作型代理寫進記事本/待辦事項（brainstorms/2026-09-23-worker-agent-notebook-write.md）：
// 只有使用者原始訊息明確要求記錄，才會在建立 session 時用 agent_with_overrides 多附帶
// 這個工具（見 createSession() 的 includeNotebookTool 參數），不是每個 agent 固定都有。
export const WRITE_TO_NOTEBOOK_TOOL_NAME = "write_to_notebook";

// 每個使用者的 agent 第一次觸發工作型代理時建立一次、之後重複使用（見
// userManagedAgents.ts），系統提示詞跟固定工具集只在這裡設定一次；之後要改既有使用者
// 已經建立過的 agent，需要另外呼叫 updateManagedAgentModel() 這類更新 API（目前只有
// 更新 model，還沒有更新 system/tools 的版本，見設計紀錄裡的已知限制）。
function buildBaseTools() {
  return [
    {
      type: "agent_toolset_20260401",
      default_config: { permission_policy: { type: "always_allow" } },
    },
    {
      type: "custom",
      name: CONSULT_TOOL_NAME,
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
  ];
}

function buildWriteToNotebookTool() {
  return {
    type: "custom",
    name: WRITE_TO_NOTEBOOK_TOOL_NAME,
    description:
      "把任務的結果新增一則記事或待辦事項，直接寫進聊天室真正的「記事本」/「待辦事項」（不是 /mnt/session/outputs/ 底下的檔案）。只能新增一則新的，不能查詢、修改或刪除既有的記事/待辦——即使任務聽起來像是要「更新」某個既有項目，也只能新增一則新的來記錄，不要嘗試尋找或覆蓋舊的。可以在同一個任務裡呼叫多次，分別記錄不同的內容。",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "task"], description: "要新增到記事本（note）還是待辦事項（task）" },
        title: { type: "string", description: "標題" },
        content: { type: "string", description: "記事的內容（kind 是 note 時填，task 不需要）" },
      },
      required: ["kind", "title"],
    },
  };
}

const BASE_SYSTEM_PROMPT =
  "你是「AI 協作室」聊天室裡的工作型代理，負責實際動手完成使用者交辦的任務（寫程式、修 bug、整理/產生檔案、部署等）。完成後把最終產出的檔案寫到 /mnt/session/outputs/。若同一個問題已經嘗試修正 3 次以上仍然卡住，呼叫 consult_other_ai 工具求助另一位 AI，不需要等待使用者回應。全部完成後，最後一則訊息用「SUMMARY: 」開頭簡短總結成果，且只在確定檔案真的寫進 /mnt/session/outputs/ 之後才能提到檔名。";

// 「這個 session 有沒有附帶 write_to_notebook 工具」會改變系統提示詞要怎麼講這件事
// （brainstorms/2026-09-23-worker-agent-notebook-write.md 訪談 Q1）：預設（沒有這個工具）
// 要明講「沒有能力寫進記事本」，避免摘要誤導使用者；有這個工具的那次呼叫則要反過來
// 講清楚什麼時候該用、規則是什麼（只能新增、不能改既有項目）。
function buildSystemPrompt(includeNotebookTool: boolean): string {
  if (includeNotebookTool) {
    return `${BASE_SYSTEM_PROMPT} 這次任務使用者有要求把結果記進記事本/待辦事項，你有 write_to_notebook 這個工具可以用——只能拿它新增一則新的記事或待辦，不能查詢、修改或刪除既有項目；跟輸出檔案（/mnt/session/outputs/）是兩件獨立的事，該輸出檔案的部分還是照常輸出。呼叫失敗的話不用讓整個任務失敗，繼續完成其他部分，只要在 SUMMARY 裡誠實說明這筆沒有記錄成功即可。`;
  }
  return `${BASE_SYSTEM_PROMPT} 你沒有任何工具能直接寫入聊天室的「記事本」或「待辦事項」——那是另一個獨立系統，你唯一能產出的東西就是 /mnt/session/outputs/ 底下的檔案，會被存進使用者的「檔案夾」。如果任務要求把結果「記進記事本/待辦事項」，只能把結果整理成 /mnt/session/outputs/ 底下的一份檔案，並在摘要裡明確說明「已將結果輸出成檔案（不是寫進記事本本身）」，不要宣稱內容已經真的寫進記事本或待辦事項。`;
}

export async function createManagedAgent(apiKey: string, model: string): Promise<CreateAgentResult> {
  const res = await cmaFetch(apiKey, "/agents", {
    method: "POST",
    headers: cmaHeaders(apiKey),
    body: JSON.stringify({
      name: "AI 協作室工作型代理",
      model,
      // 每個使用者的 agent 是第一次觸發時建立、之後重複使用的物件（見
      // userManagedAgents.ts），這裡的固定工具集／預設系統提示詞不含 write_to_notebook——
      // 那個工具是按需求透過 createSession() 的 agent_with_overrides 在單次 session 附帶，
      // 不是每個 agent 固定都有。
      system: buildSystemPrompt(false),
      tools: buildBaseTools(),
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
  // brainstorms/2026-09-23-worker-agent-notebook-write.md 訪談 Q1：只有這次任務的使用者
  // 原始訊息明確要求記錄，才為「這個 session」多附帶 write_to_notebook 工具——用
  // agent_with_overrides 做單次 session 的覆蓋，不動 agent 本身固定的工具集/版本。
  includeNotebookTool?: boolean;
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

  // agent_with_overrides 的 tools/system 是整份覆蓋、不是合併，所以要重新列出完整的
  // 工具集（base tools + 有需要的話多加 write_to_notebook），不能只送新增的那一個。
  const agent = opts.includeNotebookTool
    ? {
        type: "agent_with_overrides",
        id: opts.agentId,
        system: buildSystemPrompt(true),
        tools: [...buildBaseTools(), buildWriteToNotebookTool()],
      }
    : { type: "agent", id: opts.agentId };

  const res = await cmaFetch(opts.apiKey, "/sessions", {
    method: "POST",
    headers: cmaHeaders(opts.apiKey),
    body: JSON.stringify({
      agent,
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
