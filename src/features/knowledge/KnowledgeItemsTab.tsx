import { useState } from "react";
import { format } from "date-fns";
import { Plus, Archive } from "lucide-react";
import {
  useArchiveKnowledgeItem,
  useCreateKnowledgeItem,
  useKnowledgeItems,
  useKnowledgeSources,
  useUpdateKnowledgeItem,
} from "./useKnowledge";
import type { KnowledgeCategory, KnowledgeItemRow } from "../../types/database";

const CATEGORY_LABEL: Record<KnowledgeCategory, string> = {
  goal: "目標",
  project: "專案",
  term: "用語",
  rule: "工作規則",
  fact: "事實",
  other: "其他",
};

function isExpired(item: KnowledgeItemRow) {
  return !!item.expires_at && new Date(item.expires_at).getTime() < Date.now();
}

export function KnowledgeItemsTab({ roomId }: { roomId: string }) {
  const { data: items, isLoading } = useKnowledgeItems();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const active = items?.filter((i) => i.status === "active") ?? [];
  const selected = active.find((i) => i.id === selectedId) ?? null;

  if (selected) {
    return <KnowledgeItemDetail item={selected} onBack={() => setSelectedId(null)} />;
  }

  if (creating) {
    return (
      <NewKnowledgeItemForm
        roomId={roomId}
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
        <h2 className="text-sm font-semibold">共享背景（由你確認）</h2>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800"
        >
          <Plus size={14} /> 新增
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-slate-400">載入中…</div>}
        {active.length === 0 && !isLoading && (
          <div className="p-3 text-sm text-slate-400">
            還沒有任何背景知識。你可以自己新增，或等代理在聊天中提出草稿後到「提案」分頁確認。
          </div>
        )}
        {active.map((item) => (
          <button
            key={item.id}
            onClick={() => setSelectedId(item.id)}
            className="block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
          >
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">
                {CATEGORY_LABEL[item.category]}
              </span>
              <div className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</div>
              {isExpired(item) && <span className="shrink-0 text-[10px] text-red-500">已過期</span>}
            </div>
            <div className="truncate text-xs text-slate-400">{item.body || "（沒有內容）"}</div>
            <div className="text-[10px] text-slate-300">更新於 {format(new Date(item.updated_at), "yyyy/MM/dd HH:mm")}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewKnowledgeItemForm({
  roomId,
  onCancel,
  onCreated,
}: {
  roomId: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const createItem = useCreateKnowledgeItem();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<KnowledgeCategory>("fact");
  const [expiresAt, setExpiresAt] = useState("");

  function handleSubmit() {
    if (!title.trim()) return;
    createItem.mutate(
      { title: title.trim(), body, category, expiresAt: expiresAt || null, sourceRoomId: roomId },
      { onSuccess: (item) => onCreated(item.id) },
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
        placeholder="標題"
        className="rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as KnowledgeCategory)}
        className="rounded border border-slate-200 px-2 py-1 text-sm"
      >
        {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="內容"
        rows={6}
        className="flex-1 resize-none rounded border border-slate-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
      />
      <label className="text-xs text-slate-500">
        過期日（選填）
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="mt-1 block w-full rounded border border-slate-200 px-2 py-1 text-sm"
        />
      </label>
      <button
        onClick={handleSubmit}
        disabled={!title.trim() || createItem.isPending}
        className="rounded-md bg-slate-900 px-2 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
      >
        確認新增
      </button>
    </div>
  );
}

function KnowledgeItemDetail({ item, onBack }: { item: KnowledgeItemRow; onBack: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const updateItem = useUpdateKnowledgeItem();
  const archiveItem = useArchiveKnowledgeItem();
  const { data: sources } = useKnowledgeSources("knowledge_item", item.id);

  function handleSave() {
    if (title === item.title && body === item.body) return;
    updateItem.mutate({ id: item.id, title, body });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-700">
          ← 返回列表
        </button>
        <button
          onClick={() => {
            if (window.confirm("確定要封存這則知識嗎？封存後不會再進入代理檢索範圍。")) {
              archiveItem.mutate(item.id, { onSuccess: onBack });
            }
          }}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500"
        >
          <Archive size={13} /> 封存
        </button>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleSave}
        className="mb-2 border-b border-slate-200 pb-1 text-sm font-semibold focus:outline-none"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={handleSave}
        rows={8}
        className="mb-3 resize-none text-sm focus:outline-none"
      />
      <div className="border-t border-slate-100 pt-2">
        <h3 className="mb-1 text-xs font-semibold text-slate-500">
          來源（{sources?.length ?? 0} 筆）——區分「知道存在」與「已驗證內容」
        </h3>
        {sources?.length === 0 && <div className="text-xs text-slate-400">還沒有任何來源。</div>}
        {sources?.map((s) => (
          <div key={s.id} className="mb-1 rounded border border-slate-100 p-1.5 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-slate-100 px-1 text-[10px]">{s.source_type}</span>
              <span
                className={`rounded px-1 text-[10px] ${
                  s.status === "valid" ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500"
                }`}
              >
                {s.status === "valid" ? "有效" : s.status === "invalid" ? "來源已失效" : "待覆核"}
              </span>
              <span className={`rounded px-1 text-[10px] ${s.verified ? "bg-blue-50 text-blue-600" : "bg-slate-50 text-slate-400"}`}>
                {s.verified ? "已驗證內容" : "僅標記存在"}
              </span>
            </div>
            {s.content_snapshot && <div className="mt-1 truncate text-slate-500">{s.content_snapshot}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
