// 點名代理用按鈕選擇（結構化 mention），不用解析文字裡的 @字串，避免代理改名/同名造成誤判
// （對應原始規劃文件 6.2 節與 v2 規劃 Q5/Q6）。

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { AgentRow } from "../../types/database";
import { useSendMessage } from "./useMessages";

export function MessageComposer({ roomId, agents }: { roomId: string; agents: AgentRow[] }) {
  const [content, setContent] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const sendMessage = useSendMessage(roomId);

  function toggleAgent(agent: AgentRow) {
    if (agent.status !== "active") {
      toast.info(`${agent.name} 尚未啟用（尚未設定 API key）`);
      return;
    }
    setSelectedAgentIds((prev) =>
      prev.includes(agent.id) ? prev.filter((id) => id !== agent.id) : [...prev, agent.id],
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || sendMessage.isPending) return;

    try {
      await sendMessage.mutateAsync({ content: trimmed, mentionAgentIds: selectedAgentIds });
      setContent("");
      setSelectedAgentIds([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "傳送失敗，請稍後重試");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-slate-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap gap-2">
        {agents.map((agent) => {
          const selected = selectedAgentIds.includes(agent.id);
          const inactive = agent.status !== "active";
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => toggleAgent(agent)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                selected
                  ? "border-slate-900 bg-slate-900 text-white"
                  : inactive
                    ? "border-slate-200 bg-slate-50 text-slate-400"
                    : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"
              }`}
            >
              @{agent.name}
              {inactive && "（未啟用）"}
            </button>
          );
        })}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          rows={2}
          placeholder={
            selectedAgentIds.length > 0
              ? "輸入訊息，指定代理會回覆…"
              : "輸入訊息，沒有點名時由主管代理（Claude）回覆…"
          }
          className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sendMessage.isPending || !content.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          送出
        </button>
      </div>
    </form>
  );
}
