// 使用範圍主要是自己一個人用（訪談 Q7），MVP 不做房間列表選擇畫面：
// 沒有房間就自動建立一間預設協作室，有房間就直接進第一間。

import { useEffect, useRef } from "react";
import { Navigate } from "react-router-dom";
import { useRooms, useCreateRoom } from "./useRooms";

export function RoomGate() {
  const { data: rooms, isLoading, error: roomsError } = useRooms();
  const createRoom = useCreateRoom();
  const hasTriggeredCreate = useRef(false);

  useEffect(() => {
    if (!isLoading && rooms && rooms.length === 0 && !hasTriggeredCreate.current) {
      hasTriggeredCreate.current = true;
      createRoom.mutate("我的協作室");
    }
  }, [isLoading, rooms, createRoom]);

  const error = roomsError ?? createRoom.error;
  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-4 text-center text-slate-500">
        <p>建立協作室失敗，請重新整理再試一次。</p>
        <p className="max-w-md text-xs text-red-500">{error instanceof Error ? error.message : String(error)}</p>
      </div>
    );
  }

  if (isLoading || createRoom.isPending) {
    return <div className="flex h-screen items-center justify-center text-slate-500">準備協作室中…</div>;
  }

  const targetRoom = rooms?.[0] ?? createRoom.data;
  if (targetRoom) {
    return <Navigate to={`/rooms/${targetRoom.id}`} replace />;
  }

  return <div className="flex h-screen items-center justify-center text-slate-500">準備協作室中…</div>;
}
