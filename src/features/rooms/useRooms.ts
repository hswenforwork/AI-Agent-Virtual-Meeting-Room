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
      // owner_id 不從前端傳入，交給資料庫欄位預設值 auth.uid() 帶入，
      // 避免前端持有的 user.id 跟伺服器端評估當下的 auth.uid() 有落差時被 RLS 擋下。
      const { data, error } = await supabase.from("rooms").insert({ name }).select("*").single();
      if (error) throw error;
      return data as RoomRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", user?.id] });
    },
  });
}
