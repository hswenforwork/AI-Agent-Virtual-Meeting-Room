import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  useRooms,
  useCreateRoom,
  useRenameRoom,
  useArchiveRoom,
  useUnarchiveRoom,
  useDeleteRoom,
} from "./useRooms";
import { RoomListItem } from "./RoomListItem";
import { DeleteRoomDialog } from "./DeleteRoomDialog";
import type { RoomRow } from "../../types/database";

export function RoomSidebar({ onNavigate, collapsed }: { onNavigate?: () => void; collapsed?: boolean }) {
  const { data: rooms, isLoading } = useRooms();
  const createRoom = useCreateRoom();
  const renameRoom = useRenameRoom();
  const archiveRoom = useArchiveRoom();
  const unarchiveRoom = useUnarchiveRoom();
  const deleteRoom = useDeleteRoom();
  const navigate = useNavigate();

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RoomRow | null>(null);

  const { activeRooms, archivedRooms } = useMemo(() => {
    const all = rooms ?? [];
    return {
      activeRooms: all.filter((r) => !r.archived_at),
      archivedRooms: all.filter((r) => r.archived_at),
    };
  }, [rooms]);

  const handleNewChat = async () => {
    const room = await createRoom.mutateAsync(undefined);
    navigate(`/rooms/${room.id}`);
    onNavigate?.();
  };

  const handleDeleteConfirm = async () => {
    if (!pendingDelete) return;
    await deleteRoom.mutateAsync(pendingDelete.id);
    setPendingDelete(null);
    navigate("/");
    onNavigate?.();
  };

  // 收合成窄 icon 列：只留「新對話」跟每個房間的圓形頭像（房間名稱首字），
  // 重新命名／封存／刪除要展開側欄才能操作（brainstorms/2026-09-22-sidebar-resize-ai-context.md Q3）。
  if (collapsed) {
    return (
      <div className="flex h-full w-full flex-col items-center gap-1 bg-slate-50 py-3">
        <button
          onClick={handleNewChat}
          disabled={createRoom.isPending}
          title="新對話"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <Plus size={16} />
        </button>
        <div className="min-h-0 w-full flex-1 space-y-1 overflow-y-auto px-2 pt-1">
          {activeRooms.map((room) => (
            <NavLink
              key={room.id}
              to={`/rooms/${room.id}`}
              title={room.name}
              className={({ isActive }) =>
                `mx-auto flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold ${
                  isActive
                    ? "bg-slate-900 text-white"
                    : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                }`
              }
            >
              {room.name.trim().charAt(0).toUpperCase() || "?"}
            </NavLink>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <div className="p-3">
        <button
          onClick={handleNewChat}
          disabled={createRoom.isPending}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <Plus size={15} /> 新對話
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && <div className="px-2 py-1 text-xs text-slate-400">載入中…</div>}

        <div className="space-y-0.5">
          {activeRooms.map((room) => (
            <RoomListItem
              key={room.id}
              room={room}
              archived={false}
              onNavigate={() => onNavigate?.()}
              onRename={(name) => renameRoom.mutate({ roomId: room.id, name })}
              onArchive={() => archiveRoom.mutate(room.id)}
              onUnarchive={() => unarchiveRoom.mutate(room.id)}
              onDeleteRequest={() => setPendingDelete(room)}
            />
          ))}
          {!isLoading && activeRooms.length === 0 && (
            <div className="px-2 py-2 text-xs text-slate-400">還沒有聊天室，點上面「新對話」開始吧。</div>
          )}
        </div>

        {archivedRooms.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100"
            >
              {archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              已封存（{archivedRooms.length}）
            </button>
            {archivedOpen && (
              <div className="mt-0.5 space-y-0.5">
                {archivedRooms.map((room) => (
                  <RoomListItem
                    key={room.id}
                    room={room}
                    archived
                    onNavigate={() => onNavigate?.()}
                    onRename={(name) => renameRoom.mutate({ roomId: room.id, name })}
                    onArchive={() => archiveRoom.mutate(room.id)}
                    onUnarchive={() => unarchiveRoom.mutate(room.id)}
                    onDeleteRequest={() => setPendingDelete(room)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {pendingDelete && (
        <DeleteRoomDialog
          roomName={pendingDelete.name}
          isDeleting={deleteRoom.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  );
}
