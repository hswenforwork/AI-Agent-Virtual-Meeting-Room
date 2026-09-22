import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LayoutGrid, MessageSquare, LogOut, Menu, Settings } from "lucide-react";
import { ChatPanel } from "../features/messages/ChatPanel";
import { WorkspaceTabs } from "../components/workspace/WorkspaceTabs";
import { supabase } from "../lib/supabase";
import { useRooms } from "../features/rooms/useRooms";
import { useLayoutContext } from "./AppLayout";

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const { openDrawer } = useLayoutContext();
  const { data: rooms } = useRooms();

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
          <ChatPanel roomId={roomId} />
        </div>
        <div
          className={`min-h-0 w-full md:w-[360px] ${
            mobileView === "chat" ? "hidden md:block" : "block"
          }`}
        >
          <WorkspaceTabs roomId={roomId} />
        </div>
      </div>
    </div>
  );
}
