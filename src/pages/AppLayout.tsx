import { useState } from "react";
import { Outlet, useOutletContext } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { RoomSidebar } from "../features/rooms/RoomSidebar";
import { useRoomsRealtimeSync } from "../features/rooms/useRooms";
import { useResizablePanel } from "../lib/useResizablePanel";

export interface LayoutContext {
  openDrawer: () => void;
}

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

const COLLAPSED_WIDTH = 56;

export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 整個已登入畫面只掛載一次 AppLayout，房間列表的 Realtime 訂閱掛在這裡，
  // 不要放進 useRooms() 本體——見 useRooms.ts 裡 useRoomsRealtimeSync 的說明。
  useRoomsRealtimeSync();

  const sidebar = useResizablePanel("ai-collab-room:sidebar", {
    defaultWidth: 256,
    minWidth: 200,
    maxWidth: 400,
    direction: "left",
  });

  return (
    <div className="flex h-screen">
      {/* 桌面版：常駐側欄，可拖拉調整寬度／收合成窄 icon 列（brainstorms/2026-09-22-sidebar-resize-ai-context.md） */}
      <aside
        className="relative hidden shrink-0 overflow-hidden border-r border-slate-200 md:flex"
        style={{ width: sidebar.collapsed ? COLLAPSED_WIDTH : sidebar.width }}
      >
        <RoomSidebar collapsed={sidebar.collapsed} />
        <button
          onClick={() => sidebar.setCollapsed((v) => !v)}
          title={sidebar.collapsed ? "展開側欄" : "收合側欄"}
          className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-slate-300 bg-white p-0.5 text-slate-400 hover:text-slate-700 md:flex"
        >
          {sidebar.collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
        </button>
        {!sidebar.collapsed && (
          <div
            onPointerDown={sidebar.startResize}
            className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-slate-300"
          />
        )}
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
