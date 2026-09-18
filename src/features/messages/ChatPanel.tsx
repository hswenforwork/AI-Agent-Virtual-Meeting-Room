import { useMemo, useRef, useEffect } from "react";
import { useMessages } from "./useMessages";
import { useAgents } from "./useAgents";
import { useAgentRunStatus } from "./useAgentRunStatus";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { AgentRow } from "../../types/database";

export function ChatPanel({ roomId }: { roomId: string }) {
  const { data: messages, isLoading } = useMessages(roomId);
  const { data: agents } = useAgents(roomId);
  const runningAgentIds = useAgentRunStatus(roomId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentRow>();
    (agents ?? []).forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  const runningNames = (agents ?? [])
    .filter((a) => runningAgentIds.has(a.id))
    .map((a) => a.name);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {isLoading && <div className="text-center text-sm text-slate-400">載入訊息中…</div>}
        {messages?.map((message) => (
          <MessageBubble key={message.id} message={message} agentsById={agentsById} />
        ))}
        {runningNames.length > 0 && (
          <div className="text-xs text-slate-400">{runningNames.join("、")} 回覆中…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <MessageComposer roomId={roomId} agents={agents ?? []} />
    </div>
  );
}
