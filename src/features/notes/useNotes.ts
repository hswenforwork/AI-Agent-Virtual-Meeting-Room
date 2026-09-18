// 記事本：低風險寫入，直接透過 SDK + RLS CRUD，不需要確認卡（訪談 Q12）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { NoteRow } from "../../types/database";

export function useNotes(roomId: string) {
  return useQuery({
    queryKey: ["notes", roomId],
    queryFn: async (): Promise<NoteRow[]> => {
      const { data, error } = await supabase
        .from("notes")
        .select("*")
        .eq("room_id", roomId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateNote(roomId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("notes")
        .insert({ room_id: roomId, title: "未命名記事", content: "", created_by: user?.id })
        .select("*")
        .single();
      if (error) throw error;
      return data as NoteRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes", roomId] }),
  });
}

export function useUpdateNote(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, title, content }: { id: string; title: string; content: string }) => {
      const { error } = await supabase
        .from("notes")
        .update({ title, content, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes", roomId] }),
  });
}

export function useDeleteNote(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes", roomId] }),
  });
}
