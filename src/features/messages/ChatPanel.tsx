import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { useMessages, useLoadOlderMessages } from "./useMessages";
import { useAgents } from "./useAgents";
import { useAgentRunStatus } from "./useAgentRunStatus";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { AgentRow } from "../../types/database";

// 往上捲到接近頂部時觸發載入更舊訊息（brainstorms/2026-09-23-gpt-audit-followups.md Q10）
const LOAD_MORE_SCROLL_THRESHOLD = 60;

export function ChatPanel({ roomId }: { roomId: string }) {
  const { data: messages, isLoading } = useMessages(roomId);
  const { data: agents } = useAgents(roomId);
  const runningAgentIds = useAgentRunStatus(roomId);
  const loadOlder = useLoadOlderMessages(roomId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentRow>();
    (agents ?? []).forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

  // 換房間時重置「還有沒有更舊訊息可以載入」的狀態
  useEffect(() => {
    setHasMore(true);
  }, [roomId]);

  // 只在「最新一則訊息變了」（新訊息進來）時捲到底部；往上載入更舊訊息也會改變
  // messages.length，但不該連帶被這個效果捲到底部，所以依賴的是最後一則的 id 而不是長度。
  const lastMessageId = messages?.[messages.length - 1]?.id;
  useEffect(() => {
    if (prevScrollHeightRef.current !== null) return; // 這次更新是載入更舊訊息造成的，不要捲動
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastMessageId]);

  // 載入更舊訊息後，把捲動位置往下調整回原本看的內容，避免畫面因為上方多了內容而跳動
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevScrollHeightRef.current !== null) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = null;
    }
  }, [messages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el || loadOlder.isPending || !hasMore) return;
    if (el.scrollTop > LOAD_MORE_SCROLL_THRESHOLD) return;

    prevScrollHeightRef.current = el.scrollHeight;
    loadOlder.mutate(undefined, {
      onSuccess: (result) => {
        if (result.loaded === 0) setHasMore(false);
      },
      onError: () => {
        prevScrollHeightRef.current = null;
      },
    });
  }

  const runningNames = (agents ?? [])
    .filter((a) => runningAgentIds.has(a.id))
    .map((a) => a.name);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-3 overflow-y-auto p-4">
        {isLoading && <div className="text-center text-sm text-slate-400">載入訊息中…</div>}
        {loadOlder.isPending && <div className="text-center text-xs text-slate-400">載入更舊訊息中…</div>}
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
