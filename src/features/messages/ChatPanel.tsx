import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { useMessages, useLoadOlderMessages } from "./useMessages";
import { useAgents } from "./useAgents";
import { useAgentRunStatus, useStopAgentRun } from "./useAgentRunStatus";
import { MessageBubble } from "./MessageBubble";
import { MessageComposer } from "./MessageComposer";
import type { AgentRow } from "../../types/database";

// 往上捲到接近頂部時觸發載入更舊訊息（brainstorms/2026-09-23-gpt-audit-followups.md Q10）
const LOAD_MORE_SCROLL_THRESHOLD = 60;

export function ChatPanel({ roomId, highlightMessageId }: { roomId: string; highlightMessageId?: string | null }) {
  const { data: messages, isLoading } = useMessages(roomId);
  const { data: agents } = useAgents(roomId);
  const runningRuns = useAgentRunStatus(roomId);
  const stopRun = useStopAgentRun();
  const loadOlder = useLoadOlderMessages(roomId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  // 從「共享知識」來源連結跳轉過來時使用（?highlight=messageId）。只有目標訊息剛好在目前
  // 已載入的分頁範圍內才找得到並捲過去——這個聊天面板本來就是分頁載入，較舊的訊息要往上
  // 捲、觸發 loadOlder 才會載入，這裡不特別另外抓「目標訊息所在那一頁」，找不到就不特別
  // 處理（不影響原本「有新訊息就捲到底部」的行為），是刻意留白的已知限制。
  const [pendingHighlightId, setPendingHighlightId] = useState(highlightMessageId ?? null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);

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
  // 有等待中的高亮跳轉時（從知識來源連結進來）不搶著捲到底部，讓下面那個效果處理。
  const lastMessageId = messages?.[messages.length - 1]?.id;
  useEffect(() => {
    if (prevScrollHeightRef.current !== null) return; // 這次更新是載入更舊訊息造成的，不要捲動
    if (pendingHighlightId) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lastMessageId, pendingHighlightId]);

  // 從共享知識的來源連結跳轉進來：目前這一頁訊息剛好有這則就捲過去並短暫高亮；
  // 沒有（例如是比較舊、還沒往上捲載入的訊息）就放棄，不特別另外抓那一頁（已知限制，
  // 見上面欄位註解），使用者仍然可以自己往上捲找。
  useEffect(() => {
    if (!pendingHighlightId || !messages) return;
    const found = messages.some((m) => m.id === pendingHighlightId);
    if (!found) return;
    const el = document.getElementById(`message-${pendingHighlightId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveHighlightId(pendingHighlightId);
    setPendingHighlightId(null);
    const timer = setTimeout(() => setActiveHighlightId(null), 4000);
    return () => clearTimeout(timer);
  }, [pendingHighlightId, messages]);

  // roomId／目標訊息換了（例如又點了另一個來源連結），重新開始等待跳轉
  useEffect(() => {
    setPendingHighlightId(highlightMessageId ?? null);
  }, [roomId, highlightMessageId]);

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

  const runningAgents = (agents ?? [])
    .filter((a) => runningRuns.has(a.id))
    .map((a) => ({ agent: a, runId: runningRuns.get(a.id)! }));

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-3 overflow-y-auto p-4">
        {isLoading && <div className="text-center text-sm text-slate-400">載入訊息中…</div>}
        {loadOlder.isPending && <div className="text-center text-xs text-slate-400">載入更舊訊息中…</div>}
        {messages?.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            agentsById={agentsById}
            highlighted={message.id === activeHighlightId}
          />
        ))}
        {runningAgents.map(({ agent, runId }) => (
          <div key={agent.id} className="flex items-center gap-2 text-xs text-slate-400">
            <span>{agent.name} 回覆中…</span>
            <button
              type="button"
              onClick={() => stopRun.mutate(runId)}
              disabled={stopRun.isPending && stopRun.variables === runId}
              className="rounded-full border border-slate-300 px-2 py-0.5 text-slate-500 hover:border-slate-500 hover:text-slate-700 disabled:opacity-50"
            >
              停止
            </button>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <MessageComposer roomId={roomId} agents={agents ?? []} />
    </div>
  );
}
