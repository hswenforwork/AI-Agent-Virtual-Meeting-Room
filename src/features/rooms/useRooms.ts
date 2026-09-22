import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { RoomRow } from "../../types/database";

const DEFAULT_ROOM_NAME = "新對話";

export function useRooms() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["rooms", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<RoomRow[]> => {
      // 依最新活動時間排序（brainstorms/2026-09-22-room-sidebar-history.md Q5），
      // 不是建立時間——last_message_at 由 0008 migration 的 trigger 在新訊息進來時自動更新。
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .order("last_message_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// 訂閱要在整個應用程式裡只掛載一次（AppLayout），不能放進 useRooms() 本體——
// useRooms() 現在同時被 RoomSidebar 跟 RoomPage 呼叫，如果訂閱邏輯留在 hook 裡，
// 每多一個呼叫端就會多開一個 channel name 完全相同的 Supabase Realtime channel，
// 對同一個 topic 重複 subscribe 會出錯，而這個 app 沒有 Error Boundary，
// 一出錯就會把整棵 React tree 都卸載掉，變成整頁空白（連 sidebar、登出按鈕都不見）。
export function useRoomsRealtimeSync() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`user-${user.id}-rooms`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        (payload) => {
          queryClient.setQueryData<RoomRow[]>(["rooms", user.id], (prev) => {
            const next = prev ?? [];
            if (payload.eventType === "DELETE") {
              const deletedId = (payload.old as { id?: string }).id;
              return next.filter((r) => r.id !== deletedId);
            }
            const row = payload.new as RoomRow;
            const withoutRow = next.filter((r) => r.id !== row.id);
            return [...withoutRow, row].sort(
              (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(),
            );
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);
}

export function useCreateRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name?: string) => {
      if (!user) throw new Error("尚未登入");
      const roomName = name?.trim() || DEFAULT_ROOM_NAME;
      // 明確帶入 owner_id（跟資料庫欄位預設值 auth.uid() 雙重保險），
      // 兩者理論上應該一致，明確帶入可以在資料庫端預設值行為異常時仍然成功。
      const { data, error } = await supabase
        .from("rooms")
        .insert({ owner_id: user.id, name: roomName })
        .select("*")
        .single();
      if (error) throw error;
      return data as RoomRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}

export function useRenameRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ roomId, name }: { roomId: string; name: string }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("名稱不能是空的");
      // 使用者手動重新命名後，就不要再讓 AI 自動標題蓋掉這個名稱。
      const { error } = await supabase
        .from("rooms")
        .update({ name: trimmed, title_generated: true })
        .eq("id", roomId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}

export function useArchiveRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (roomId: string) => {
      const { error } = await supabase
        .from("rooms")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", roomId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}

export function useUnarchiveRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (roomId: string) => {
      const { error } = await supabase.from("rooms").update({ archived_at: null }).eq("id", roomId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}

export function useDeleteRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (roomId: string) => {
      const { error } = await supabase.from("rooms").delete().eq("id", roomId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}
