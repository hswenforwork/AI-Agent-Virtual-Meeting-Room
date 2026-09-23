import { useState } from "react";
import { format } from "date-fns";
import { Plus } from "lucide-react";
import { useCreateDecision, useDecisions, useKnowledgeSources } from "./useKnowledge";
import type { DecisionRow } from "../../types/database";

// 決策清單：active 排前面，superseded 用刪除線＋灰階顯示但不隱藏——「新決策不能悄悄
// 覆蓋舊決策」，舊版本要留著給人看得到取代歷程（docs/AI-Partner借鏡對照.md 第 2 項）。
export function DecisionsTab({ roomId }: { roomId: string }) {
  const { data: decisions, isLoading } = useDecisions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const sorted = [...(decisions ?? [])].sort((a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime());
  const selected = sorted.find((d) => d.id === selectedId) ?? null;

  if (selected) {
    return <DecisionDetail decision={selected} all={sorted} onBack={() => setSelectedId(null)} />;
  }

  if (creating) {
    return (
      <NewDecisionForm
        roomId={roomId}
        activeDecisions={sorted.filter((d) => d.status === "active")}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSelectedId(id);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold">決策紀錄</h2>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800"
        >
          <Plus size={14} /> 新增決策
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-slate-400">載入中…</div>}
        {sorted.length === 0 && !isLoading && <div className="p-3 text-sm text-slate-400">還沒有任何決策紀錄。</div>}
        {sorted.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            className="block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
          >
            <div className="flex items-center gap-1.5">
              <div className={`min-w-0 flex-1 truncate text-sm font-medium ${d.status === "superseded" ? "text-slate-400 line-through" : ""}`}>
                {d.title}
              </div>
              {d.status === "superseded" && <span className="shrink-0 text-[10px] text-slate-400">已取代</span>}
            </div>
            <div className="truncate text-xs text-slate-400">{d.decision_text}</div>
            <div className="text-[10px] text-slate-300">決定於 {format(new Date(d.decided_at), "yyyy/MM/dd")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewDecisionForm({
  roomId,
  activeDecisions,
  onCancel,
  onCreated,
}: {
  roomId: string;
  activeDecisions: DecisionRow[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const createDecision = useCreateDecision();
  const [title, setTitle] = useState("");
  const [decisionText, setDecisionText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [supersedesId, setSupersedesId] = useState("");

  function handleSubmit() {
    if (!title.trim() || !decisionText.trim()) return;
    createDecision.mutate(
      {
        title: title.trim(),
        decisionText: decisionText.trim(),
        reasoning,
        supersedesId: supersedesId || null,
        sourceRoomId: roomId,
      },
      { onSuccess: (d) => onCreated(d.id) },
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <button onClick={onCancel} className="self-start text-xs text-slate-500 hover:text-slate-700">
        ← 取消
      </button>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="決策標題"
        className="rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <textarea
        value={decisionText}
        onChange={(e) => setDecisionText(e.target.value)}
        placeholder="決定了什麼"
        rows={4}
        className="resize-none rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <textarea
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
        placeholder="原因／依據"
        rows={3}
        className="resize-none rounded border border-slate-200 px-2 py-1 text-sm"
      />
      <label className="text-xs text-slate-500">
        取代既有決策（選填）——選了之後，那筆舊決策會自動標成「已取代」，之後代理不會再引用它
        <select
          value={supersedesId}
          onChange={(e) => setSupersedesId(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
        >
          <option value="">（不取代任何決策）</option>
          {activeDecisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={handleSubmit}
        disabled={!title.trim() || !decisionText.trim() || createDecision.isPending}
        className="rounded-md bg-slate-900 px-2 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
      >
        確認新增
      </button>
    </div>
  );
}

function DecisionDetail({ decision, all, onBack }: { decision: DecisionRow; all: DecisionRow[]; onBack: () => void }) {
  const { data: sources } = useKnowledgeSources("decision", decision.id);
  const supersededBy = decision.superseded_by_id ? all.find((d) => d.id === decision.superseded_by_id) : null;
  const supersedes = decision.supersedes_id ? all.find((d) => d.id === decision.supersedes_id) : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <button onClick={onBack} className="mb-2 self-start text-xs text-slate-500 hover:text-slate-700">
        ← 返回列表
      </button>
      <h3 className="mb-1 text-sm font-semibold">{decision.title}</h3>
      {decision.status === "superseded" && supersededBy && (
        <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
          此決策已被「{supersededBy.title}」取代，代理不會再把這筆當成目前依據。
        </div>
      )}
      {supersedes && <div className="mb-2 text-xs text-slate-400">此決策取代了：{supersedes.title}</div>}
      <div className="mb-2 text-sm">{decision.decision_text}</div>
      <div className="mb-2 text-xs text-slate-500">
        <span className="font-medium">原因：</span>
        {decision.reasoning || "（未填寫）"}
      </div>
      <div className="text-[10px] text-slate-300">決定於 {format(new Date(decision.decided_at), "yyyy/MM/dd HH:mm")}</div>

      <div className="mt-3 border-t border-slate-100 pt-2">
        <h4 className="mb-1 text-xs font-semibold text-slate-500">來源（{sources?.length ?? 0} 筆）</h4>
        {sources?.map((s) => (
          <div key={s.id} className="mb-1 rounded border border-slate-100 p-1.5 text-xs">
            <span className="rounded bg-slate-100 px-1 text-[10px]">{s.source_type}</span>{" "}
            <span className={s.status === "valid" ? "text-emerald-600" : "text-red-500"}>
              {s.status === "valid" ? "有效" : "已失效"}
            </span>
            {s.content_snapshot && <div className="mt-1 truncate text-slate-500">{s.content_snapshot}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
