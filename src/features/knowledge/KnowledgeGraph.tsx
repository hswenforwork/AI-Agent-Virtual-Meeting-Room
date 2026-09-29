import { useMemo, useState } from "react";
import { LinkIcon, List, Network as NetworkIcon } from "lucide-react";
import { useCreateKnowledgeLink, useDecisions, useKnowledgeItems, useKnowledgeLinks } from "./useKnowledge";
import type { DecisionRow, KnowledgeItemRow, KnowledgeRelation } from "../../types/database";

type NodeType = "knowledge_item" | "decision";

interface GraphNode {
  id: string;
  type: NodeType;
  title: string;
  preview: string;
  active: boolean;
  x: number;
  y: number;
}

const RELATION_LABEL: Record<KnowledgeRelation, string> = {
  related: "相關",
  supports: "支持",
  depends_on: "依賴",
  contradicts: "矛盾",
  supersedes: "取代",
};

const RELATION_COLOR: Record<KnowledgeRelation, string> = {
  related: "#94a3b8",
  supports: "#16a34a",
  depends_on: "#2563eb",
  contradicts: "#dc2626",
  supersedes: "#a855f7",
};

const WIDTH = 320;
const HEIGHT = 320;
const ITERATIONS = 200;

// 純手刻的簡易 2D 力導向佈局：不新增第三方圖形套件（docs/AI-Partner借鏡對照.md「尚未
// 涵蓋、刻意留白的部分」第 3 點）——節點數量不多（知識/決策的規模），O(n²) 排斥力
// 加彈簧吸引力跑固定迭代次數就夠用，不需要真的做四叉樹加速。
function layoutNodes(nodes: GraphNode[], edges: { source: string; target: string }[]): GraphNode[] {
  if (nodes.length === 0) return nodes;
  const positioned = nodes.map((n, i) => {
    // 用 id 算一個穩定的初始角度，不用 Math.random()，同一份資料每次排版結果一致
    const hash = Array.from(n.id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const angle = ((hash % 360) / 360) * Math.PI * 2 + i * 0.13;
    const radius = Math.min(WIDTH, HEIGHT) * 0.32;
    return { ...n, x: WIDTH / 2 + radius * Math.cos(angle), y: HEIGHT / 2 + radius * Math.sin(angle) };
  });

  const indexById = new Map(positioned.map((n, i) => [n.id, i]));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = positioned.map(() => ({ dx: 0, dy: 0 }));

    // 節點互相排斥
    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i];
        const b = positioned[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const force = 900 / distSq;
        const dist = Math.sqrt(distSq);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        forces[i].dx += dx;
        forces[i].dy += dy;
        forces[j].dx -= dx;
        forces[j].dy -= dy;
      }
    }

    // 有關聯的節點互相吸引（像彈簧）
    for (const e of edges) {
      const i = indexById.get(e.source);
      const j = indexById.get(e.target);
      if (i === undefined || j === undefined || i === j) continue;
      const a = positioned[i];
      const b = positioned[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = 90;
      const force = (dist - targetDist) * 0.02;
      forces[i].dx += (dx / dist) * force;
      forces[i].dy += (dy / dist) * force;
      forces[j].dx -= (dx / dist) * force;
      forces[j].dy -= (dy / dist) * force;
    }

    // 往中心拉一點，避免整體飄出畫面
    for (let i = 0; i < positioned.length; i++) {
      forces[i].dx += (WIDTH / 2 - positioned[i].x) * 0.004;
      forces[i].dy += (HEIGHT / 2 - positioned[i].y) * 0.004;
    }

    for (let i = 0; i < positioned.length; i++) {
      positioned[i].x = Math.min(WIDTH - 20, Math.max(20, positioned[i].x + forces[i].dx));
      positioned[i].y = Math.min(HEIGHT - 20, Math.max(20, positioned[i].y + forces[i].dy));
    }
  }

  return positioned;
}

function buildNodes(items: KnowledgeItemRow[], decisions: DecisionRow[]): GraphNode[] {
  const itemNodes: GraphNode[] = items.map((i) => ({
    id: `knowledge_item:${i.id}`,
    type: "knowledge_item",
    title: i.title,
    preview: i.body.slice(0, 80),
    active: i.status === "active",
    x: 0,
    y: 0,
  }));
  const decisionNodes: GraphNode[] = decisions.map((d) => ({
    id: `decision:${d.id}`,
    type: "decision",
    title: d.title,
    preview: d.decision_text.slice(0, 80),
    active: d.status === "active",
    x: 0,
    y: 0,
  }));
  return [...itemNodes, ...decisionNodes];
}

// 手機優先：預設用可捲動的文字清單（相關、支持、依賴、矛盾、取代 各自一段），
// 圖只是輔助檢視，按鈕切換即可看到 2D 關聯圖。
export function KnowledgeGraph() {
  const { data: items } = useKnowledgeItems();
  const { data: decisions } = useDecisions();
  const { data: links } = useKnowledgeLinks();
  const [view, setView] = useState<"list" | "graph">("list");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const createLink = useCreateKnowledgeLink();

  const nodes = useMemo(() => buildNodes(items ?? [], decisions ?? []), [items, decisions]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const confirmedEdges = useMemo(
    () =>
      (links ?? [])
        .filter((l) => l.status === "confirmed")
        .map((l) => ({ link: l, source: `${l.from_type}:${l.from_id}`, target: `${l.to_type}:${l.to_id}` }))
        .filter((e) => nodeById.has(e.source) && nodeById.has(e.target)),
    [links, nodeById],
  );

  const positioned = useMemo(() => layoutNodes(nodes, confirmedEdges), [nodes, confirmedEdges]);
  const positionedById = useMemo(() => new Map(positioned.map((n) => [n.id, n])), [positioned]);

  const keyword = search.trim().toLowerCase();
  const matches = (n: GraphNode) => !keyword || n.title.toLowerCase().includes(keyword) || n.preview.toLowerCase().includes(keyword);

  const selectedNode = selectedId ? nodeById.get(selectedId) : null;
  const selectedEdges = selectedId ? confirmedEdges.filter((e) => e.source === selectedId || e.target === selectedId) : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 p-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋知識/決策標題…"
          className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs"
        />
        <button
          onClick={() => setView(view === "list" ? "graph" : "list")}
          className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200"
          title="切換檢視"
        >
          {view === "list" ? <NetworkIcon size={13} /> : <List size={13} />}
          {view === "list" ? "看關聯圖" : "看清單"}
        </button>
        <button
          onClick={() => setLinking((v) => !v)}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800"
          title="新增關聯"
        >
          <LinkIcon size={13} /> 新增關聯
        </button>
      </div>

      {linking && (
        <NewLinkForm
          nodes={nodes}
          onCancel={() => setLinking(false)}
          onSubmit={(input) => createLink.mutate(input, { onSuccess: () => setLinking(false) })}
          pending={createLink.isPending}
        />
      )}

      <p className="border-b border-slate-100 px-2 py-1 text-[10px] text-slate-400">
        線代表你已確認的知識關聯（相關／支持／依賴／矛盾／取代），節點位置只是排版方便閱讀，不代表時間先後。
      </p>

      {nodes.length === 0 ? (
        <div className="flex-1 p-3 text-sm text-slate-400">還沒有任何知識或決策，先到「背景」「決策」分頁建立內容。</div>
      ) : view === "graph" ? (
        <div className="flex-1 overflow-auto">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" style={{ minHeight: 260 }}>
            {confirmedEdges.map((e) => {
              const a = positionedById.get(e.source);
              const b = positionedById.get(e.target);
              if (!a || !b) return null;
              return (
                <line
                  key={e.link.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={RELATION_COLOR[e.link.relation]}
                  strokeWidth={selectedId && (e.source === selectedId || e.target === selectedId) ? 2.5 : 1}
                  opacity={keyword && !(matches(a) && matches(b)) ? 0.15 : 0.7}
                />
              );
            })}
            {positioned.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}
                style={{ cursor: "pointer" }}
                opacity={keyword && !matches(n) ? 0.25 : 1}
              >
                <circle
                  r={selectedId === n.id ? 9 : 7}
                  fill={n.type === "decision" ? "#2563eb" : "#0f172a"}
                  opacity={n.active ? 1 : 0.35}
                  stroke={selectedId === n.id ? "#f59e0b" : "none"}
                  strokeWidth={2}
                />
                <text x={10} y={4} fontSize={8} fill="#334155">
                  {n.title.length > 12 ? `${n.title.slice(0, 12)}…` : n.title}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {positioned.filter(matches).map((n) => (
            <button
              key={n.id}
              onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}
              className="block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${n.type === "decision" ? "bg-blue-600" : "bg-slate-900"}`} />
                <span className="text-sm font-medium">{n.title}</span>
                {!n.active && <span className="text-[10px] text-slate-400">（已取代/封存）</span>}
              </div>
              <div className="truncate text-xs text-slate-400">{n.preview}</div>
            </button>
          ))}
        </div>
      )}

      {selectedNode && (
        <div className="max-h-40 overflow-y-auto border-t border-slate-200 p-2 text-xs">
          <div className="mb-1 font-semibold">{selectedNode.title}</div>
          <div className="mb-1 text-slate-500">{selectedNode.preview}</div>
          {selectedEdges.length === 0 ? (
            <div className="text-slate-400">還沒有任何關聯。</div>
          ) : (
            selectedEdges.map((e) => {
              const other = nodeById.get(e.source === selectedId ? e.target : e.source);
              const direction = e.source === selectedId ? "→" : "←";
              return (
                <div key={e.link.id} className="text-slate-500">
                  <span style={{ color: RELATION_COLOR[e.link.relation] }}>{RELATION_LABEL[e.link.relation]}</span> {direction}{" "}
                  {other?.title ?? "（未知）"}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function NewLinkForm({
  nodes,
  onCancel,
  onSubmit,
  pending,
}: {
  nodes: GraphNode[];
  onCancel: () => void;
  onSubmit: (input: {
    fromType: NodeType;
    fromId: string;
    toType: NodeType;
    toId: string;
    relation: KnowledgeRelation;
    reasoning?: string;
  }) => void;
  pending: boolean;
}) {
  const [fromNodeId, setFromNodeId] = useState(nodes[0]?.id ?? "");
  const [toNodeId, setToNodeId] = useState(nodes[1]?.id ?? nodes[0]?.id ?? "");
  const [relation, setRelation] = useState<KnowledgeRelation>("related");
  const [reasoning, setReasoning] = useState("");

  function parse(nodeId: string): { type: NodeType; id: string } {
    const [type, id] = nodeId.split(":");
    return { type: type as NodeType, id };
  }

  function handleSubmit() {
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
    const from = parse(fromNodeId);
    const to = parse(toNodeId);
    onSubmit({ fromType: from.type, fromId: from.id, toType: to.type, toId: to.id, relation, reasoning });
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-slate-200 bg-slate-50 p-2 text-xs">
      <select value={fromNodeId} onChange={(e) => setFromNodeId(e.target.value)} className="rounded border border-slate-200 px-1.5 py-1">
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
      <select value={relation} onChange={(e) => setRelation(e.target.value as KnowledgeRelation)} className="rounded border border-slate-200 px-1.5 py-1">
        {(Object.keys(RELATION_LABEL) as KnowledgeRelation[]).map((r) => (
          <option key={r} value={r}>
            {RELATION_LABEL[r]}
          </option>
        ))}
      </select>
      <select value={toNodeId} onChange={(e) => setToNodeId(e.target.value)} className="rounded border border-slate-200 px-1.5 py-1">
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
      <input
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
        placeholder="理由（選填）"
        className="rounded border border-slate-200 px-1.5 py-1"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={pending || !fromNodeId || !toNodeId || fromNodeId === toNodeId}
          className="rounded-md bg-slate-900 px-2 py-1 text-white hover:bg-slate-800 disabled:opacity-50"
        >
          確認建立
        </button>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-700">
          取消
        </button>
      </div>
    </div>
  );
}
