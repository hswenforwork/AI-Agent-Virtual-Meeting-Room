import { useState } from "react";
import { NotesPanel } from "../../features/notes/NotesPanel";
import { TasksPanel } from "../../features/tasks/TasksPanel";
import { FilesPanel } from "../../features/files/FilesPanel";

type Tab = "notes" | "tasks" | "files";

const TABS: { key: Tab; label: string }[] = [
  { key: "notes", label: "記事本" },
  { key: "tasks", label: "待辦事項" },
  { key: "files", label: "檔案夾" },
];

export function WorkspaceTabs({ roomId }: { roomId: string }) {
  const [tab, setTab] = useState<Tab>("notes");

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
