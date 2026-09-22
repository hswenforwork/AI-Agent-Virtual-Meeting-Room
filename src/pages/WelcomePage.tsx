import { useNavigate } from "react-router-dom";
import { Menu, LogOut, Plus } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useCreateRoom } from "../features/rooms/useRooms";
import { useLayoutContext } from "./AppLayout";

export function WelcomePage() {
  const { openDrawer } = useLayoutContext();
  const createRoom = useCreateRoom();
  const navigate = useNavigate();

  const handleNewChat = async () => {
    const room = await createRoom.mutateAsync(undefined);
    navigate(`/rooms/${room.id}`);
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <button onClick={openDrawer} className="text-slate-400 hover:text-slate-700 md:hidden" title="聊天室清單">
            <Menu size={18} />
          </button>
          <h1 className="text-sm font-semibold">AI 協作室</h1>
        </div>
        <button onClick={() => supabase.auth.signOut()} className="text-slate-400 hover:text-slate-700" title="登出">
          <LogOut size={16} />
        </button>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <h2 className="text-lg font-medium text-slate-700">選一間聊天室繼續，或開始新的對話</h2>
        <p className="max-w-sm text-sm text-slate-400">
          左側是你的聊天室歷史紀錄；還沒有聊天室的話，點下面按鈕開始第一則對話。
        </p>
        <button
          onClick={handleNewChat}
          disabled={createRoom.isPending}
          className="flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <Plus size={15} /> 新對話
        </button>
      </div>
    </div>
  );
}
