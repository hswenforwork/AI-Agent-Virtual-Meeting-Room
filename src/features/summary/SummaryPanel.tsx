import { useConversationSummary } from "./useConversationSummary";

// 對話摘要查看入口（brainstorms/2026-09-23-gpt-audit-followups.md Q13）：純顯示，
// 不能編輯——摘要是後端在 agent-run 裡自動產生/更新的，前端只是給使用者一個
// 「AI 到底記得什麼」的透明度入口。
export function SummaryPanel({ roomId }: { roomId: string }) {
  const { summary, isLoading } = useConversationSummary(roomId);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold">對話摘要</h2>
        <p className="mt-1 text-xs text-slate-400">
          AI 自動整理更早之前的對話重點，累積到一定訊息量才會更新；只是背景參考，不影響你看得到的完整對話紀錄。
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {isLoading && <div className="text-sm text-slate-400">載入中…</div>}
        {!isLoading && !summary && (
          <div className="text-sm text-slate-400">目前還沒有摘要，對話累積到一定長度後會自動產生。</div>
        )}
        {summary && <div className="whitespace-pre-wrap text-sm text-slate-700">{summary}</div>}
      </div>
    </div>
  );
}
