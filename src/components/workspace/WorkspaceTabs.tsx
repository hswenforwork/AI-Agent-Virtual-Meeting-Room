import { useState } from "react";
import { NotebookPen, ListTodo, Folder } from "lucide-react";
import { NotesPanel } from "../../features/notes/NotesPanel";
import { TasksPanel } from "../../features/tasks/TasksPanel";
import { FilesPanel } from "../../features/files/FilesPanel";

type Tab = "notes" | "tasks" | "files";

const TABS: { key: Tab; label: string; icon: typeof NotebookPen }[] = [
  { key: "notes", label: "記事本", icon: NotebookPen },
  { key: "tasks", label: "待辦事項", icon: ListTodo },
  { key: "files", label: "檔案夾", icon: Folder },
];

export function WorkspaceTabs({
  roomId,
  collapsed,
  onExpand,
}: {
  roomId: string;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("notes");

  // 收合成窄 icon 列：點哪個分頁圖示就切換到哪個分頁，並自動展開回完整寬度
  // （brainstorms/2026-09-22-sidebar-resize-ai-context.md 待釐清事項）。
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 border-l border-slate-200 bg-white py-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            title={t.label}
            onClick={() => {
              setTab(t.key);
              onExpand?.();
            }}
            className={`rounded-md p-2 ${
              tab === t.key ? "bg-slate-900 text-white" : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            }`}
          >
            <t.icon size={16} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-slate-200 bg-white">
      <div className="flex border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 px-3 py-2 text-sm font-medium ${
              tab === t.key
                ? "border-b-2 border-slate-900 text-slate-900"
                : "text-slate-400 hover:text-slate-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "notes" && <NotesPanel roomId={roomId} />}
        {tab === "tasks" && <TasksPanel roomId={roomId} />}
        {tab === "files" && <FilesPanel roomId={roomId} />}
      </div>
    </div>
  );
}
