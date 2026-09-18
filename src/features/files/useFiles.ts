// 檔案夾：上傳／登記屬低風險，直接走 Storage + file-register；
// 刪除屬高風險（訪談 Q12），走 approval_requests → approval-decide，保留稽核紀錄。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { FileRow } from "../../types/database";

export function useFiles(roomId: string) {
  return useQuery({
    queryKey: ["files", roomId],
    queryFn: async (): Promise<FileRow[]> => {
      const { data, error } = await supabase
        .from("files")
        .select("*")
        .eq("room_id", roomId)
        .eq("status", "active")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files", roomId] }),
  });
}

export function useRequestDeleteFile(roomId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (fileId: string) => {
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["files", roomId] }),
  });
}

export async function getFileDownloadUrl(objectPath: string) {
  const { data, error } = await supabase.storage
    .from("room-files")
    .createSignedUrl(objectPath, 60);
  if (error) throw error;
  return data.signedUrl;
}
