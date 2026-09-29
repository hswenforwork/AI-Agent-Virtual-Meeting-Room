import { format } from "date-fns";
import { PlayCircle } from "lucide-react";
import { useKnowledgeAuditReports, useRunKnowledgeAudit } from "./useKnowledge";
import type { KnowledgeAuditFinding } from "../../types/database";

const SEVERITY_LABEL: Record<string, { label: string; className: string }> = {
  confirmed: { label: "已確認", className: "bg-red-50 text-red-600" },
  needs_review: { label: "待覆核", className: "bg-amber-50 text-amber-700" },
  suggestion: { label: "建議", className: "bg-slate-100 text-slate-500" },
};

// 稽核（借鏡 /audit）：依證據列出問題，不是看知識筆數（docs/AI-Partner借鏡對照.md 第 5 項）。
// 只能手動觸發；要排程執行的話見 README「共享知識系統」章節的 pg_cron 設定方式，
// 這個 PR 不會幫你直接打開排程。
export function AuditTab() {
  const { data: reports, isLoading } = useKnowledgeAuditReports();
  const runAudit = useRunKnowledgeAudit();
  const latest = reports?.[0];

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">共享知識稽核</h2>
        <button
          onClick={() => runAudit.mutate()}
          disabled={runAudit.isPending}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <PlayCircle size={14} /> {runAudit.isPending ? "檢查中…" : "立即檢查"}
        </button>
      </div>

      {isLoading && <div className="text-sm text-slate-400">載入中…</div>}
      {!isLoading && !latest && <div className="text-sm text-slate-400">還沒有任何稽核報告，按「立即檢查」跑第一次。</div>}

      {latest && (
        <div className="mb-4">
          <div className="mb-2 text-xs text-slate-400">
            最近一次：{format(new Date(latest.run_at), "yyyy/MM/dd HH:mm")}（{latest.triggered_by === "manual" ? "手動" : "排程"}）
          </div>
          <div className="mb-2 text-sm">{latest.summary}</div>
          <div className="mb-3 grid grid-cols-3 gap-1 text-center text-[10px]">
            <div className="rounded bg-slate-50 p-1">
              <div className="text-sm font-semibold">{latest.stats.knowledge_items_active ?? 0}</div>
              有效知識
            </div>
            <div className="rounded bg-slate-50 p-1">
              <div className="text-sm font-semibold">{latest.stats.decisions_active ?? 0}</div>
              有效決策
            </div>
            <div className="rounded bg-slate-50 p-1">
              <div className="text-sm font-semibold">{latest.stats.proposals_pending ?? 0}</div>
              待確認提案
            </div>
          </div>
          {latest.findings.length === 0 ? (
            <div className="text-sm text-emerald-600">沒有發現需要處理的問題。</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {latest.findings.map((f: KnowledgeAuditFinding) => (
                <div key={f.finding_id} className="rounded border border-slate-100 p-2 text-xs">
                  <span className={`rounded px-1 text-[10px] ${SEVERITY_LABEL[f.severity]?.className ?? ""}`}>
                    {SEVERITY_LABEL[f.severity]?.label ?? f.severity}
                  </span>{" "}
                  <span className="text-slate-400">[{f.category}]</span>
                  <div className="mt-1">{f.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {reports && reports.length > 1 && (
        <div className="border-t border-slate-100 pt-2">
          <h3 className="mb-1 text-xs font-semibold text-slate-400">歷史報告</h3>
          {reports.slice(1).map((r) => (
            <div key={r.id} className="mb-1 text-[10px] text-slate-400">
              {format(new Date(r.run_at), "yyyy/MM/dd HH:mm")} — {r.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
