// 待辦事項：低風險寫入，直接透過 SDK + RLS CRUD（訪談 Q12）。
// brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1：待辦跨聊天室共用，
// 不再依 room_id 篩選列表（RLS 已經把可見範圍限制在「使用者自己名下所有房間」），
// 只有新增時還需要 roomId 當作這筆待辦的「來源房間」（room_id 欄位本身沒有拿掉）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { TaskRow, TaskStatus } from "../../types/database";

export interface TaskWithRoom extends TaskRow {
  roomName: string | null;
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: async (): Promise<TaskWithRoom[]> => {
      const { data, error } = await supabase
        .from("tasks")
        .select("*, rooms(name)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(({ rooms, ...task }) => ({
        ...task,
        roomName: (rooms as { name: string } | null)?.name ?? null,
      }));
    },
  });
}

export function useCreateTask(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (title: string) => {
      const { error } = await supabase.from("tasks").insert({ room_id: roomId, title });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: TaskStatus }) => {
      const { error } = await supabase
        .from("tasks")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
