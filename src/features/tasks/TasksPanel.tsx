import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { useCreateTask, useDeleteTask, useTasks, useUpdateTaskStatus } from "./useTasks";
import type { TaskStatus } from "../../types/database";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待辦",
  in_progress: "進行中",
  done: "已完成",
};

export function TasksPanel({ roomId }: { roomId: string }) {
  const { data: tasks, isLoading } = useTasks(roomId);
  const createTask = useCreateTask(roomId);
  const updateStatus = useUpdateTaskStatus(roomId);
  const deleteTask = useDeleteTask(roomId);
  const [title, setTitle] = useState("");

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createTask.mutate(trimmed);
    setTitle("");
  }

  return (
    <div className="flex h-full flex-col">
      <form onSubmit={handleCreate} className="flex gap-2 border-b border-slate-200 p-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新增待辦事項…"
          className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1 text-xs text-white hover:bg-slate-800"
        >
          新增
        </button>
      </form>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-slate-400">載入中…</div>}
        {tasks?.length === 0 && <div className="p-3 text-sm text-slate-400">還沒有待辦事項</div>}
        {tasks?.map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div
                className={`truncate text-sm ${task.status === "done" ? "text-slate-400 line-through" : "text-slate-900"}`}
              >
                {task.title}
              </div>
            </div>
            <select
              value={task.status}
              onChange={(e) =>
                updateStatus.mutate({ id: task.id, status: e.target.value as TaskStatus })
              }
              className="rounded-md border border-slate-200 px-1 py-0.5 text-xs"
            >
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (window.confirm("確定要刪除這個待辦事項嗎？")) deleteTask.mutate(task.id);
              }}
              className="text-slate-400 hover:text-red-500"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
