import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { LayoutGrid, MessageSquare, LogOut, Menu, Settings, ChevronLeft, ChevronRight } from "lucide-react";
import { ChatPanel } from "../features/messages/ChatPanel";
import { WorkspaceTabs } from "../components/workspace/WorkspaceTabs";
import { supabase } from "../lib/supabase";
import { useRooms } from "../features/rooms/useRooms";
import { useLayoutContext } from "./AppLayout";
import { useIsDesktop, useResizablePanel } from "../lib/useResizablePanel";

const COLLAPSED_WIDTH = 56;

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  // 共享知識來源連結（?highlight=messageId，見 knowledgeContext.ts）用來跳到並高亮特定訊息。
  const [searchParams] = useSearchParams();
  const highlightMessageId = searchParams.get("highlight");
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const { openDrawer } = useLayoutContext();
  const { data: rooms } = useRooms();
  const isDesktop = useIsDesktop();
  const workspace = useResizablePanel("ai-collab-room:workspace", {
    defaultWidth: 360,
    minWidth: 280,
    maxWidth: 560,
    direction: "right",
  });

  if (!roomId) return null;

  const roomName = rooms?.find((r) => r.id === roomId)?.name ?? "AI 協作室";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={openDrawer} className="shrink-0 text-slate-400 hover:text-slate-700 md:hidden" title="聊天室清單">
            <Menu size={18} />
          </button>
          <h1 className="truncate text-sm font-semibold">{roomName}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex rounded-md border border-slate-200 md:hidden">
            <button
              onClick={() => setMobileView("chat")}
              className={`px-2 py-1 ${mobileView === "chat" ? "bg-slate-900 text-white" : "text-slate-500"}`}
            >
              <MessageSquare size={16} />
            </button>
            <button
              onClick={() => setMobileView("workspace")}
              className={`px-2 py-1 ${mobileView === "workspace" ? "bg-slate-900 text-white" : "text-slate-500"}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
          <Link to="/settings" className="text-slate-400 hover:text-slate-700" title="設定">
            <Settings size={16} />
          </Link>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-slate-400 hover:text-slate-700"
            title="登出"
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className={`min-h-0 flex-1 ${mobileView === "workspace" ? "hidden md:block" : "block"}`}>
          <ChatPanel roomId={roomId} highlightMessageId={highlightMessageId} />
        </div>
        <div
          className={`relative min-h-0 w-full shrink-0 md:w-auto ${
            mobileView === "chat" ? "hidden md:block" : "block"
          }`}
          style={isDesktop ? { width: workspace.collapsed ? COLLAPSED_WIDTH : workspace.width } : undefined}
        >
          {isDesktop && !workspace.collapsed && (
            <div
              onPointerDown={workspace.startResize}
              className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-slate-300"
            />
          )}
          {isDesktop && (
            <button
              onClick={() => workspace.setCollapsed((v) => !v)}
              title={workspace.collapsed ? "展開工作區" : "收合工作區"}
              className="absolute -left-3 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-slate-300 bg-white p-0.5 text-slate-400 hover:text-slate-700 md:flex"
            >
              {workspace.collapsed ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          <WorkspaceTabs
            roomId={roomId}
            collapsed={isDesktop && workspace.collapsed}
            onExpand={() => workspace.setCollapsed(false)}
          />
        </div>
      </div>
    </div>
  );
}
