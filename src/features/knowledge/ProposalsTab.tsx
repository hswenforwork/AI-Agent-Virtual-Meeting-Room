import { useState } from "react";
import { format } from "date-fns";
import { Check, X } from "lucide-react";
import { useAcceptProposal, useKnowledgeProposals, useRejectProposal } from "./useKnowledge";
import type { KnowledgeProposalRow } from "../../types/database";

const TYPE_LABEL: Record<string, string> = {
  knowledge: "新知識",
  decision: "決策",
  correction: "修正",
  question: "待確認問題",
  link: "關聯",
};

// 提案確認（借鏡 /grill-me：代理的推論先落在這裡，不是正式知識，要使用者自己確認、
// 修改或拒絕，見 docs/AI-Partner借鏡對照.md 第 4 項）。edit 只提供最基本的「調整標題/
// 內容後再確認」，複雜的合併留給使用者自己之後去「背景」／「決策」分頁編輯。
export function ProposalsTab() {
  const { data: proposals, isLoading } = useKnowledgeProposals();
  const accept = useAcceptProposal();
  const reject = useRejectProposal();
  const [editingId, setEditingId] = useState<string | null>(null);

  const pending = (proposals ?? []).filter((p) => p.status === "pending");
  const resolved = (proposals ?? []).filter((p) => p.status !== "pending").slice(0, 20);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <h2 className="mb-2 text-sm font-semibold">待確認提案（{pending.length}）</h2>
      {isLoading && <div className="text-sm text-slate-400">載入中…</div>}
      {pending.length === 0 && !isLoading && (
        <div className="mb-4 text-sm text-slate-400">目前沒有待確認的提案。代理在聊天中判斷值得記住的事時會出現在這裡。</div>
      )}
      {pending.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          editing={editingId === p.id}
          onToggleEdit={() => setEditingId(editingId === p.id ? null : p.id)}
          onAccept={(edits) => accept.mutate({ proposalId: p.id, edits })}
          onReject={() => reject.mutate({ proposalId: p.id })}
          pending={accept.isPending || reject.isPending}
        />
      ))}

      {resolved.length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-xs font-semibold text-slate-400">最近處理過的提案</h3>
          {resolved.map((p) => (
            <div key={p.id} className="mb-1 rounded border border-slate-100 p-2 text-xs text-slate-400">
              <span className="rounded bg-slate-100 px-1 text-[10px]">{TYPE_LABEL[p.proposal_type]}</span>{" "}
              {(p.payload.title as string) ?? "（無標題）"} —{" "}
              <span className={p.status === "accepted" ? "text-emerald-600" : "text-slate-400"}>
                {p.status === "accepted" ? "已確認" : p.status === "rejected" ? "已拒絕" : p.status}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  editing,
  onToggleEdit,
  onAccept,
  onReject,
  pending,
}: {
  proposal: KnowledgeProposalRow;
  editing: boolean;
  onToggleEdit: () => void;
  onAccept: (edits?: Record<string, unknown>) => void;
  onReject: () => void;
  pending: boolean;
}) {
  const payload = proposal.payload;
  const [title, setTitle] = useState((payload.title as string) ?? "");
  const [body, setBody] = useState((payload.body as string) ?? "");
  const hasConflict = !!payload.potential_conflict_with;

  return (
    <div className="mb-2 rounded-md border border-slate-200 p-2 text-sm">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="rounded bg-blue-50 px-1 text-[10px] text-blue-600">{TYPE_LABEL[proposal.proposal_type]}</span>
        <span className="text-[10px] text-slate-300">{format(new Date(proposal.created_at), "MM/dd HH:mm")}</span>
      </div>
      {hasConflict && (
        <div className="mb-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
          ⚠ 代理提醒可能與既有決策衝突：{payload.potential_conflict_with as string}
          ，請自行判斷要不要取代。
        </div>
      )}
      {editing ? (
        <div className="flex flex-col gap-1">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="rounded border border-slate-200 px-1.5 py-1 text-xs" />
          {proposal.proposal_type !== "link" && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="resize-none rounded border border-slate-200 px-1.5 py-1 text-xs"
            />
          )}
        </div>
      ) : (
        <>
          <div className="font-medium">{(payload.title as string) ?? "（無標題）"}</div>
          {proposal.proposal_type !== "link" && <div className="text-xs text-slate-500">{(payload.body as string) ?? ""}</div>}
          {proposal.proposal_type === "link" && (
            <div className="text-xs text-slate-500">
              {String(payload.from_type)}:{String(payload.from_id).slice(0, 8)}… —{String(payload.relation)}→{" "}
              {String(payload.to_type)}:{String(payload.to_id).slice(0, 8)}…
            </div>
          )}
        </>
      )}
      <div className="mt-1 text-xs italic text-slate-400">理由：{proposal.reasoning || "（未提供）"}</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={pending}
          onClick={() => onAccept(editing ? { title, body } : undefined)}
          className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <Check size={12} /> 確認
        </button>
        <button
          disabled={pending}
          onClick={onReject}
          className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 disabled:opacity-50"
        >
          <X size={12} /> 拒絕
        </button>
        <button onClick={onToggleEdit} className="ml-auto text-xs text-slate-400 hover:text-slate-600">
          {editing ? "取消編輯" : "編輯後確認"}
        </button>
      </div>
    </div>
  );
}
