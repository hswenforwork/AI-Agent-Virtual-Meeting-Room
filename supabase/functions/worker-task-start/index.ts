// worker-task-start：使用者在任務卡片按下「開始執行」後呼叫。
// 建立 Managed Agents（CMA）session，並在背景（EdgeRuntime.waitUntil）持續收事件串流、
// 更新任務卡片、處理「卡住求助其他 AI」的自訂工具呼叫、任務結束後把產出檔案歸檔。
// 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q2/Q4/Q6/Q7/Q8/Q9/Q10。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";
import {
  archiveSession,
  createSession,
  downloadFile,
  listSessionOutputFiles,
  ManagedAgentsError,
  sendCustomToolResult,
  streamSessionEvents,
  type CmaEvent,
} from "../_shared/managedAgents.ts";
import { consultGemini } from "../_shared/providers/gemini.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

// 代理的系統提示詞（角色設定、SUMMARY: 開頭慣例、consult_other_ai 使用時機）
// 是 agent 設定本身的一部分，建立一次、可重複使用 —— 定義在 scripts/setup-managed-agent.sh，
// 不是每次 session 都重送，這裡只需要知道工具名稱本身。
const CONSULT_TOOL_NAME = "consult_other_ai";
const PROGRESS_LOG_MAX_ENTRIES = 6;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated");

    const { workerTaskId } = await req.json();
    if (!workerTaskId) return jsonError("缺少 workerTaskId", 400);

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated");

    const admin = supabaseAdmin();

    const { data: workerTask, error: workerTaskErr } = await admin
      .from("worker_tasks")
      .select("id, room_id, agent_id, origin_message_id, task_card_message_id, task_summary, status")
      .eq("id", workerTaskId)
      .single();
    if (workerTaskErr || !workerTask) return jsonError("找不到這個任務", 404, "not_found");

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", workerTask.room_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden");

    if (workerTask.status !== "pending_confirmation") {
      return new Response(JSON.stringify({ ok: false, error: { code: "already_started", message: "這個任務已經開始執行過了。" } }), { headers });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    const agentId = Deno.env.get("MANAGED_AGENTS_AGENT_ID");
    const environmentId = Deno.env.get("MANAGED_AGENTS_ENVIRONMENT_ID");
    if (!apiKey || !agentId || !environmentId) {
      await failTask(
        admin,
        workerTask,
        "尚未完成工作型代理的後台設定（Managed Agents agent/environment），請聯絡管理員依 README 設定。",
      );
      return new Response(JSON.stringify({ ok: false, error: { code: "not_configured", message: "工作型代理尚未設定完成" } }), { headers });
    }

    const { data: originMessage } = await admin
      .from("messages")
      .select("content")
      .eq("id", workerTask.origin_message_id)
      .single();

    const githubRepoUrl = Deno.env.get("GITHUB_REPO_URL");
    const githubToken = Deno.env.get("GITHUB_TOKEN");
    const githubBranch = Deno.env.get("GITHUB_REPO_BRANCH");

    let session: { id: string };
    try {
      session = await createSession({
        apiKey,
        agentId,
        environmentId,
        title: `任務：${workerTask.task_summary.slice(0, 80)}`,
        initialUserMessage: `任務描述：${workerTask.task_summary}\n\n使用者原始訊息：${originMessage?.content ?? ""}`,
        githubRepo: githubRepoUrl && githubToken ? { url: githubRepoUrl, token: githubToken, branch: githubBranch } : undefined,
      });
    } catch (err) {
      console.error("建立 Managed Agents session 失敗", err);
      await failTask(admin, workerTask, "建立工作階段失敗，請稍後重試。");
      return new Response(JSON.stringify({ ok: false, error: { code: "session_create_failed", message: "建立工作階段失敗" } }), { headers });
    }

    await admin
      .from("worker_tasks")
      .update({ status: "running", session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", workerTask.id);

    if (workerTask.task_card_message_id) {
      await admin
        .from("messages")
        .update({ metadata: { status: "running", taskSummary: workerTask.task_summary, workerTaskId: workerTask.id, sessionId: session.id } })
        .eq("id", workerTask.task_card_message_id);
    }

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    const consumeSession = () =>
      runSessionToCompletion(admin, apiKey, geminiApiKey, {
        sessionId: session.id,
        workerTaskId: workerTask.id,
        roomId: workerTask.room_id,
        taskCardMessageId: workerTask.task_card_message_id,
        taskSummary: workerTask.task_summary,
      });

    // deno-lint-ignore no-undef
    EdgeRuntime.waitUntil(consumeSession());

    return new Response(JSON.stringify({ ok: true, sessionId: session.id }), { headers });
  } catch (err) {
    console.error("worker-task-start 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error");
  }
});

async function failTask(
  admin: AdminClient,
  workerTask: { id: string; room_id: string; task_card_message_id: string | null; task_summary: string },
  message: string,
) {
  await admin
    .from("worker_tasks")
    .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
    .eq("id", workerTask.id);

  if (workerTask.task_card_message_id) {
    await admin
      .from("messages")
      .update({
        content: message,
        metadata: { status: "failed", taskSummary: workerTask.task_summary, workerTaskId: workerTask.id },
      })
      .eq("id", workerTask.task_card_message_id);
  }
}

interface SessionContext {
  sessionId: string;
  workerTaskId: string;
  roomId: string;
  taskCardMessageId: string | null;
  taskSummary: string;
}

async function runSessionToCompletion(
  admin: AdminClient,
  apiKey: string,
  geminiApiKey: string | undefined,
  ctx: SessionContext,
) {
  const progressLog: string[] = [];
  let finished = false;
  let sawError = false;

  const pushProgress = async (entry: string) => {
    progressLog.push(entry);
    if (progressLog.length > PROGRESS_LOG_MAX_ENTRIES) progressLog.shift();
    await updateTaskCard(admin, ctx, { status: "running", progressLog });
  };

  try {
    for await (const event of streamSessionEvents(apiKey, ctx.sessionId)) {
      if (finished) break;

      switch (event.type) {
        case "agent.message": {
          const text = extractText(event.content);
          if (text) await pushProgress(text.slice(0, 300));
          break;
        }
        case "agent.custom_tool_use": {
          if (event.name === CONSULT_TOOL_NAME) {
            await handleConsultOtherAi(admin, apiKey, geminiApiKey, ctx, event, pushProgress);
          }
          break;
        }
        case "session.error": {
          sawError = true;
          console.error("Managed Agents session.error", ctx.sessionId, event);
          break;
        }
        case "session.status_idle": {
          const stopReason = event.stop_reason as { type?: string } | undefined;
          if (stopReason?.type !== "requires_action") {
            finished = true;
          }
          break;
        }
        case "session.status_terminated": {
          finished = true;
          break;
        }
      }
    }
  } catch (err) {
    console.error("讀取 Managed Agents 事件串流失敗", ctx.sessionId, err);
    sawError = true;
  }

  await finalizeTask(admin, apiKey, ctx, progressLog, sawError);
}

async function handleConsultOtherAi(
  admin: AdminClient,
  apiKey: string,
  geminiApiKey: string | undefined,
  ctx: SessionContext,
  event: CmaEvent,
  pushProgress: (entry: string) => Promise<void>,
) {
  const input = (event.input ?? {}) as {
    problem_description?: string;
    attempted_solutions?: string;
    error_details?: string;
  };
  await pushProgress(`卡住了，正在詢問另一位 AI（Gemini）協助：${input.problem_description ?? ""}`.slice(0, 300));

  let resultText: string;
  if (!geminiApiKey) {
    resultText = "目前沒有設定可求助的其他 AI（GEMINI_API_KEY 未設定），請依自己的判斷繼續嘗試其他解法。";
  } else {
    const prompt = [
      "另一個 AI 代理在執行程式開發任務時卡住了，請幫忙分析並給出具體建議。",
      `問題描述：${input.problem_description ?? "（未提供）"}`,
      `已嘗試過的方法：${input.attempted_solutions ?? "（未提供）"}`,
      `錯誤訊息：${input.error_details ?? "（未提供）"}`,
    ].join("\n");
    resultText = await consultGemini(geminiApiKey, prompt);
  }

  try {
    await sendCustomToolResult(apiKey, ctx.sessionId, event.id as string, resultText);
  } catch (err) {
    console.error("回傳 consult_other_ai 結果失敗", ctx.sessionId, err);
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: { type?: string }) => block?.type === "text")
    .map((block: { text?: string }) => block.text ?? "")
    .join("\n");
}

async function updateTaskCard(
  admin: AdminClient,
  ctx: SessionContext,
  patch: { status: string; content?: string; outputs?: { name: string; fileId: string }[]; progressLog?: string[] },
) {
  if (!ctx.taskCardMessageId) return;
  const update: Record<string, unknown> = {
    metadata: {
      status: patch.status,
      taskSummary: ctx.taskSummary,
      workerTaskId: ctx.workerTaskId,
      sessionId: ctx.sessionId,
      progressLog: patch.progressLog ?? [],
      outputs: patch.outputs ?? [],
    },
  };
  if (patch.content) update.content = patch.content;
  await admin.from("messages").update(update).eq("id", ctx.taskCardMessageId);
}

async function finalizeTask(
  admin: AdminClient,
  apiKey: string,
  ctx: SessionContext,
  progressLog: string[],
  sawError: boolean,
) {
  const outputs = await filesToArtifacts(admin, apiKey, ctx);

  const lastMessage = [...progressLog].reverse().find((entry) => entry.startsWith("SUMMARY:"));
  const summary = lastMessage
    ? lastMessage.replace(/^SUMMARY:\s*/, "")
    : progressLog[progressLog.length - 1] ?? "任務已結束，但沒有取得摘要內容。";

  const status = sawError && outputs.length === 0 ? "failed" : "completed";

  await admin
    .from("worker_tasks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", ctx.workerTaskId);

  await updateTaskCard(admin, ctx, { status, content: summary, outputs, progressLog });

  try {
    await archiveSession(apiKey, ctx.sessionId);
  } catch (err) {
    console.error("封存 session 失敗（不影響任務結果）", ctx.sessionId, err);
  }
}

async function filesToArtifacts(
  admin: AdminClient,
  apiKey: string,
  ctx: SessionContext,
): Promise<{ name: string; fileId: string }[]> {
  let outputFiles;
  try {
    outputFiles = await listSessionOutputFiles(apiKey, ctx.sessionId);
    if (outputFiles.length === 0) {
      // 官方文件提到 session.status_idle 到輸出檔案出現在 files.list 之間有 1-3 秒的索引延遲
      await new Promise((resolve) => setTimeout(resolve, 2000));
      outputFiles = await listSessionOutputFiles(apiKey, ctx.sessionId);
    }
  } catch (err) {
    if (err instanceof ManagedAgentsError) {
      console.error("列出輸出檔案失敗", ctx.sessionId, err.status, err.body);
    } else {
      console.error("列出輸出檔案失敗", ctx.sessionId, err);
    }
    return [];
  }

  const artifacts: { name: string; fileId: string }[] = [];
  for (const outputFile of outputFiles) {
    try {
      const bytes = await downloadFile(apiKey, outputFile.id);
      const objectPath = `${ctx.roomId}/worker-output/${ctx.workerTaskId}/${outputFile.filename}`;
      const { error: uploadErr } = await admin.storage
        .from("room-files")
        .upload(objectPath, bytes, { contentType: guessMimeType(outputFile.filename), upsert: true });
      if (uploadErr) {
        console.error("上傳產出檔案到 Storage 失敗", objectPath, uploadErr);
        continue;
      }

      const { data: fileRow, error: insertErr } = await admin
        .from("files")
        .insert({
          room_id: ctx.roomId,
          bucket: "room-files",
          object_path: objectPath,
          name: outputFile.filename,
          mime_type: guessMimeType(outputFile.filename),
          size_bytes: outputFile.size_bytes,
        })
        .select("id")
        .single();
      if (insertErr || !fileRow) {
        console.error("登記產出檔案失敗", objectPath, insertErr);
        continue;
      }

      artifacts.push({ name: outputFile.filename, fileId: fileRow.id });
    } catch (err) {
      console.error("處理產出檔案失敗", outputFile.filename, err);
    }
  }
  return artifacts;
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
