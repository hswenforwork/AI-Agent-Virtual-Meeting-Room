import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { format } from "date-fns";
import type { AgentRow, MessageRow } from "../../types/database";

export function MessageBubble({
  message,
  agentsById,
}: {
  message: MessageRow;
  agentsById: Map<string, AgentRow>;
}) {
  if (message.sender_type === "system") {
    return (
      <div className="mx-auto max-w-md rounded-full bg-slate-200 px-3 py-1 text-center text-xs text-slate-600">
        {message.content}
      </div>
    );
  }

  const isUser = message.sender_type === "user";
  const agent = message.sender_agent_id ? agentsById.get(message.sender_agent_id) : undefined;
  const label = isUser ? "我" : agent?.name ?? "代理";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm shadow-sm ${
          isUser ? "bg-slate-900 text-white" : "bg-white text-slate-900 border border-slate-200"
        }`}
      >
        {!isUser && <div className="mb-1 text-xs font-semibold text-slate-500">{label}</div>}
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
        <div className={`mt-1 text-[10px] ${isUser ? "text-slate-300" : "text-slate-400"}`}>
          {format(new Date(message.created_at), "HH:mm")}
        </div>
      </div>
    </div>
  );
}
