import { useState } from "react";
import { useParams } from "react-router-dom";
import { LayoutGrid, MessageSquare, LogOut } from "lucide-react";
import { ChatPanel } from "../features/messages/ChatPanel";
import { WorkspaceTabs } from "../components/workspace/WorkspaceTabs";
import { supabase } from "../lib/supabase";

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");

  if (!roomId) return null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <h1 className="text-sm font-semibold">AI 協作室</h1>
        <div className="flex items-center gap-3">
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
