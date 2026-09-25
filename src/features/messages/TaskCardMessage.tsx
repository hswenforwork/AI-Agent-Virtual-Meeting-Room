import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { format } from "date-fns";
import { supabase } from "../../lib/supabase";
import type { AgentRow, MessageRow } from "../../types/database";
import { formatTokenUsage } from "./tokenUsage";

const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: "等待確認",
  queued: "排隊中",
  running: "執行中",
  completed: "已完成",
  failed: "失敗",
  cancelled: "已取消",
};

const STATUS_COLOR: Record<string, string> = {
  pending_confirmation: "bg-amber-100 text-amber-800",
  queued: "bg-amber-100 text-amber-800",
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-600",
};

export function TaskCardMessage({ message, agentsById }: { message: MessageRow; agentsById: Map<string, AgentRow> }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = message.sender_agent_id ? agentsById.get(message.sender_agent_id) : undefined;
  const metadata = message.metadata ?? {};
  const status = metadata.status ?? "pending_confirmation";
  const tokenUsage = formatTokenUsage(message.input_tokens, message.output_tokens);

  const handleStart = async () => {
    if (!metadata.workerTaskId) return;
    setStarting(true);
    setError(null);
    const { error: invokeErr } = await supabase.functions.invoke("worker-task-start", {
      body: { workerTaskId: metadata.workerTaskId },
    });
    if (invokeErr) setError("開始執行失敗，請稍後重試。");
    setStarting(false);
  };

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">{agent?.name ?? "工作型代理"} · 任務卡片</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_COLOR[status] ?? "bg-slate-100 text-slate-600"}`}>
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>

        <div className="markdown-body text-slate-900">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || metadata.taskSummary || ""}</ReactMarkdown>
        </div>

        {metadata.progressLog && metadata.progressLog.length > 0 && status === "running" && (
          <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
            {metadata.progressLog.map((line, i) => (
              <div key={i} className="truncate">{line}</div>
            ))}
          </div>
        )}

        {metadata.outputs && metadata.outputs.length > 0 && (
          <div className="mt-2 text-xs text-slate-500">
            產出檔案：{metadata.outputs.map((o) => o.name).join("、")}（已存到檔案夾）
          </div>
        )}

        {(status === "pending_confirmation" || status === "failed") && (
          <div className="mt-2">
            <button
              onClick={handleStart}
              disabled={starting}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {starting ? "啟動中…" : status === "failed" ? "重試" : "開始執行"}
            </button>
            {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
          </div>
        )}

        <div className="mt-1 text-[10px] text-slate-400">
          {format(new Date(message.created_at), "HH:mm")}
          {tokenUsage && <> · {tokenUsage}</>}
        </div>
      </div>
    </div>
  );
}
