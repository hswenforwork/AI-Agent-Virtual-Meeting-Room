import { useState } from "react";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { useCreateNote, useDeleteNote, useNotes, useUpdateNote, type NoteWithRoom } from "./useNotes";

// 記事本現在跨聊天室共用（brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1），
// roomId 只在「新增」時用來當這筆記事的來源房間，列表本身不再依房間篩選。
export function NotesPanel({ roomId }: { roomId: string }) {
  const { data: notes, isLoading } = useNotes();
  const createNote = useCreateNote(roomId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedNote = notes?.find((n) => n.id === selectedId) ?? null;

  if (selectedNote) {
    return <NoteEditor note={selectedNote} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold">記事本</h2>
        <button
          type="button"
          onClick={() => createNote.mutate(undefined, { onSuccess: (note) => setSelectedId(note.id) })}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800"
        >
          <Plus size={14} /> 新增
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-slate-400">載入中…</div>}
        {notes?.length === 0 && <div className="p-3 text-sm text-slate-400">還沒有記事</div>}
        {notes?.map((note) => (
          <button
            key={note.id}
            onClick={() => setSelectedId(note.id)}
            className="block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
          >
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1 truncate text-sm font-medium">{note.title || "未命名記事"}</div>
              <span className="shrink-0 text-[10px] text-slate-400">
                {format(new Date(note.updated_at), "MM/dd HH:mm")}
              </span>
            </div>
            <div className="truncate text-xs text-slate-400">{note.content || "（沒有內容）"}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function NoteEditor({ note, onBack }: { note: NoteWithRoom; onBack: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();

  function handleSave() {
    updateNote.mutate({ id: note.id, title, content });
  }

  function handleDelete() {
    if (!window.confirm("確定要刪除這則記事嗎？")) return;
    deleteNote.mutate(note.id, { onSuccess: onBack });
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-700">
          ← 返回列表
        </button>
        <div className="flex items-center gap-2">
          {note.roomName && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
              來自：{note.roomName}
            </span>
          )}
          <button onClick={handleDelete} className="text-slate-400 hover:text-red-500">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleSave}
        className="mb-2 border-b border-slate-200 pb-1 text-sm font-semibold focus:outline-none"
        placeholder="標題"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={handleSave}
        className="flex-1 resize-none text-sm focus:outline-none"
        placeholder="內容…"
      />
    </div>
  );
}
