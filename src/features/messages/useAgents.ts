import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { AgentRow } from "../../types/database";

export function useAgents(roomId: string) {
  return useQuery({
    queryKey: ["agents", roomId],
    queryFn: async (): Promise<AgentRow[]> => {
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}
