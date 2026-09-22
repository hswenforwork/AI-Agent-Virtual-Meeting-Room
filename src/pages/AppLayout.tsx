import { useState } from "react";
import { Outlet, useOutletContext } from "react-router-dom";
import { RoomSidebar } from "../features/rooms/RoomSidebar";
import { useRoomsRealtimeSync } from "../features/rooms/useRooms";

export interface LayoutContext {
  openDrawer: () => void;
}

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 整個已登入畫面只掛載一次 AppLayout，房間列表的 Realtime 訂閱掛在這裡，
  // 不要放進 useRooms() 本體——見 useRooms.ts 裡 useRoomsRealtimeSync 的說明。
  useRoomsRealtimeSync();

  return (
    <div className="flex h-screen">
      {/* 桌面版：常駐側欄 */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 md:flex">
        <RoomSidebar />
      </aside>

      {/* 手機版：滑出式抽屜（brainstorms/2026-09-22-room-sidebar-history.md Q6） */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="relative z-10 h-full w-72 max-w-[80vw] border-r border-slate-200 bg-slate-50 shadow-xl">
            <RoomSidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1">
        <Outlet context={{ openDrawer: () => setDrawerOpen(true) } satisfies LayoutContext} />
      </div>
    </div>
  );
}
