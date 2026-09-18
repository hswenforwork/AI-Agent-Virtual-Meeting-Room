import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { RoomRow } from "../../types/database";

export function useRooms() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["rooms", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<RoomRow[]> => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateRoom() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("尚未登入");
      // 明確帶入 owner_id（跟資料庫欄位預設值 auth.uid() 雙重保險），
      // 兩者理論上應該一致，明確帶入可以在資料庫端預設值行為異常時仍然成功。
      const { data, error } = await supabase
        .from("rooms")
        .insert({ owner_id: user.id, name })
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
