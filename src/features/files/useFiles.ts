// 檔案夾：上傳／登記屬低風險，直接走 Storage + file-register；
// 刪除屬高風險（訪談 Q12），走 approval_requests → approval-decide，保留稽核紀錄。
// brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1：檔案夾跨聊天室共用，
// 不再依 room_id 篩選列表（RLS 已經把可見範圍限制在「使用者自己名下所有房間」）；
// Storage 裡的實際檔案路徑仍然是 {room_id}/... 不變，下載連結不受影響（見 migration 說明）。
// brainstorms/2026-09-23-workspace-realtime-refresh.md：比照 useNotes()，補上 Realtime
// 訂閱——工作型代理執行完成後把產出檔案登記進 files 表（worker-task-start，用
// service_role 寫入）時，前端才會立刻看到新檔案，不用切分頁再切回來。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { FileRow } from "../../types/database";

export interface FileWithRoom extends FileRow {
  roomName: string | null;
}

export function useFiles() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["files"],
    queryFn: async (): Promise<FileWithRoom[]> => {
      const { data, error } = await supabase
        .from("files")
        .select("*, rooms(name)")
        .eq("status", "active")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(({ rooms, ...file }) => ({
        ...file,
        roomName: (rooms as { name: string } | null)?.name ?? null,
      }));
    },
  });

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel(`files-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "files", filter: `owner_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey: ["files"] }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient]);

  return query;
}

function buildObjectPath(roomId: string, filename: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const safeName = filename.replace(/[^\w.\-一-鿿]/g, "_");
  return `${roomId}/${year}/${month}/${crypto.randomUUID()}-${safeName}`;
}

export function useUploadFile(roomId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      if (!user) throw new Error("尚未登入");
      const objectPath = buildObjectPath(roomId, file.name);

      const { error: uploadErr } = await supabase.storage
        .from("room-files")
        .upload(objectPath, file, { contentType: file.type || "application/octet-stream" });
      if (uploadErr) throw uploadErr;

      const { data, error: registerErr } = await supabase.functions.invoke("file-register", {
        body: {
          roomId,
          objectPath,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      });
      if (registerErr) throw registerErr;
      return data as { fileId: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files"] }),
  });
}

// 刪除審核走 approval_requests，room_id 用「這個檔案原本上傳到的房間」（不是使用者目前正在
// 看的房間——共用列表可能是在別的房間檢視這份檔案），呼叫端傳整個 file 物件即可。
export function useRequestDeleteFile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fileId, roomId }: { fileId: string; roomId: string }) => {
      if (!user) throw new Error("尚未登入");

      const { data: approval, error: approvalErr } = await supabase
        .from("approval_requests")
        .insert({
          room_id: roomId,
          requested_by: user.id,
          tool_name: "file.delete",
          arguments_json: { fileId },
          risk_level: "high",
        })
        .select("id")
        .single();
      if (approvalErr) throw approvalErr;

      const { error: decideErr } = await supabase.functions.invoke("approval-decide", {
        body: { approvalId: approval.id, decision: "approved" },
      });
      if (decideErr) throw decideErr;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files"] }),
  });
}

export async function getFileDownloadUrl(objectPath: string) {
  const { data, error } = await supabase.storage
    .from("room-files")
    .createSignedUrl(objectPath, 60);
  if (error) throw error;
  return data.signedUrl;
}
