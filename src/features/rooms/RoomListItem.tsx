import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { RoomRow } from "../../types/database";

export function RoomListItem({
  room,
  archived,
  onNavigate,
  onRename,
  onArchive,
  onUnarchive,
  onDeleteRequest,
}: {
  room: RoomRow;
  archived: boolean;
  onNavigate: () => void;
  onRename: (name: string) => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDeleteRequest: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(room.name);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const submitRename = () => {
    setRenaming(false);
    if (draftName.trim() && draftName.trim() !== room.name) onRename(draftName);
    else setDraftName(room.name);
  };

  if (renaming) {
    return (
      <div className="px-2 py-1">
        <input
          autoFocus
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitRename();
            if (e.key === "Escape") {
              setDraftName(room.name);
              setRenaming(false);
            }
          }}
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
        />
      </div>
    );
  }

  return (
    <div className="group relative">
      <NavLink
        to={`/rooms/${room.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          `flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-sm ${
            isActive && !archived ? "bg-slate-200 font-medium text-slate-900" : "text-slate-600 hover:bg-slate-100"
          }`
        }
      >
        <span className="truncate">{room.name}</span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="invisible shrink-0 rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 group-hover:visible"
          title="更多選項"
        >
          <MoreHorizontal size={14} />
        </button>
      </NavLink>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
            onClick={() => {
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            <Pencil size={13} /> 重新命名
          </button>
          {archived ? (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setMenuOpen(false);
                onUnarchive();
              }}
            >
              <ArchiveRestore size={13} /> 取消封存
            </button>
          ) : (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setMenuOpen(false);
                onArchive();
              }}
            >
              <Archive size={13} /> 關閉（封存）
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
            onClick={() => {
              setMenuOpen(false);
              onDeleteRequest();
            }}
          >
            <Trash2 size={13} /> 刪除
          </button>
        </div>
      )}
    </div>
  );
}
