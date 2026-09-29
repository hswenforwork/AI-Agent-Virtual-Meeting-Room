import { useState } from "react";
import { BookMarked, Gavel, Inbox, ShieldCheck, Network } from "lucide-react";
import { KnowledgeItemsTab } from "./KnowledgeItemsTab";
import { DecisionsTab } from "./DecisionsTab";
import { ProposalsTab } from "./ProposalsTab";
import { AuditTab } from "./AuditTab";
import { KnowledgeGraph } from "./KnowledgeGraph";
import { useKnowledgeProposals } from "./useKnowledge";

type SubTab = "items" | "decisions" | "proposals" | "audit" | "graph";

const SUB_TABS: { key: SubTab; label: string; icon: typeof BookMarked }[] = [
  { key: "items", label: "背景", icon: BookMarked },
  { key: "decisions", label: "決策", icon: Gavel },
  { key: "proposals", label: "提案", icon: Inbox },
  { key: "audit", label: "稽核", icon: ShieldCheck },
  { key: "graph", label: "關聯圖", icon: Network },
];

// 跨聊天室共享知識系統的入口（docs/AI-Partner借鏡對照.md）：knowledge_items/decisions/
// knowledge_links/knowledge_proposals 都是依帳號（owner_id）存放，不依房間篩選——
// 任何聊天室打開這個分頁，看到的都是同一份資料，這就是「跨聊天室共用」的實作方式，
// 不需要額外的「同步」邏輯。roomId 只在新增知識/決策時當作「來源房間」參考欄位。
export function KnowledgePanel({ roomId }: { roomId: string }) {
  const [tab, setTab] = useState<SubTab>("items");
  const { data: proposals } = useKnowledgeProposals();
  const pendingCount = proposals?.filter((p) => p.status === "pending").length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-slate-200 text-xs">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`relative flex flex-1 flex-col items-center gap-0.5 px-1 py-2 ${
              tab === t.key ? "border-b-2 border-slate-900 text-slate-900" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            <t.icon size={14} />
            {t.label}
            {t.key === "proposals" && pendingCount > 0 && (
              <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-semibold text-white">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "items" && <KnowledgeItemsTab roomId={roomId} />}
        {tab === "decisions" && <DecisionsTab roomId={roomId} />}
        {tab === "proposals" && <ProposalsTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "graph" && <KnowledgeGraph />}
      </div>
    </div>
  );
}
