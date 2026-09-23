// 記事本：低風險寫入，直接透過 SDK + RLS CRUD，不需要確認卡（訪談 Q12）。
// brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1：記事本跨聊天室共用，
// 不再依 room_id 篩選列表（RLS 已經把可見範圍限制在「使用者自己名下所有房間」），
// 只有新增時還需要 roomId 當作這筆記事的「來源房間」（room_id 欄位本身沒有拿掉）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { NoteRow } from "../../types/database";

export interface NoteWithRoom extends NoteRow {
  roomName: string | null;
}

export function useNotes() {
  return useQuery({
    queryKey: ["notes"],
    queryFn: async (): Promise<NoteWithRoom[]> => {
      const { data, error } = await supabase
        .from("notes")
        .select("*, rooms(name)")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(({ rooms, ...note }) => ({
        ...note,
        roomName: (rooms as { name: string } | null)?.name ?? null,
      }));
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
}

export function useUpdateNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, title, content }: { id: string; title: string; content: string }) => {
      const { error } = await supabase
        .from("notes")
        .update({ title, content, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
}

export function useDeleteNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
}
