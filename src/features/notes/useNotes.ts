// 記事本：低風險寫入，直接透過 SDK + RLS CRUD，不需要確認卡（訪談 Q12）。
// brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1：記事本跨聊天室共用，
// 不再依 room_id 篩選列表（RLS 已經把可見範圍限制在「使用者自己名下所有房間」），
// 只有新增時還需要 roomId 當作這筆記事的「來源房間」（room_id 欄位本身沒有拿掉）。
// brainstorms/2026-09-23-workspace-realtime-refresh.md：AI（用 service_role）直接寫入
// notes 表時，前端完全不知道——原本只有使用者自己在這個分頁操作的 mutation 才會
// invalidateQueries，AI 代寫的新增/修改要等使用者切走分頁再切回來（React Query 重新
// mount 才重新 fetch）才會出現。補上 Realtime 訂閱，比照 useMessages() 的做法。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { NoteRow } from "../../types/database";

export interface NoteWithRoom extends NoteRow {
  roomName: string | null;
}

export function useNotes() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
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

  useEffect(() => {
    if (!user) return;

    // 列表查詢有 join rooms(name)，收到的 payload 沒有這個欄位，直接整批重新 fetch
    // 比自己拼湊、還要另外查一次房間名稱簡單，記事本筆數不多，重新查詢的成本可忽略。
    const channel = supabase
      .channel(`notes-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `owner_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  return query;
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
