import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { MessageRow } from "../../types/database";

export function useMessages(roomId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["messages", roomId],
    queryFn: async (): Promise<MessageRow[]> => {
      // 抓「最新 200 則」再反轉成舊到新顯示；原本用 ascending+limit 抓到的是「最早 200 則」，
      // 房間訊息一旦超過 200 則，畫面就永遠卡在最舊的那一批，看不到新對話。
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []).reverse();
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel(`room-${roomId}-messages`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          queryClient.setQueryData<MessageRow[]>(["messages", roomId], (prev) => {
            const next = prev ?? [];
            if (next.some((m) => m.id === (payload.new as MessageRow).id)) return next;
            return [...next, payload.new as MessageRow];
          });
        },
      )
      .on(
        // 任務卡片（worker-task-start）靠 UPDATE 這張訊息本身來推送狀態／進度變化，
        // 只訂閱 INSERT 的話，卡片建立後的所有後續更新（包含 workerTaskId 補上、執行中進度、
        // 完成/失敗結果）都不會顯示，「開始執行」按鈕也會因為讀不到 workerTaskId 而點了沒反應。
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          queryClient.setQueryData<MessageRow[]>(["messages", roomId], (prev) => {
            const next = prev ?? [];
            const updated = payload.new as MessageRow;
            if (!next.some((m) => m.id === updated.id)) return next;
            return next.map((m) => (m.id === updated.id ? updated : m));
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, queryClient]);

  return query;
}

// 往上捲動載入更舊訊息（brainstorms/2026-09-23-gpt-audit-followups.md Q10）：畫面固定只抓
// 最新 200 則，超過的訊息還在資料庫裡、只是預設看不到，這個 hook 補上「向前翻一頁」的能力。
export function useLoadOlderMessages(roomId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<{ loaded: number }> => {
      const current = queryClient.getQueryData<MessageRow[]>(["messages", roomId]) ?? [];
      const oldest = current[0];
      if (!oldest) return { loaded: 0 };

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("room_id", roomId)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      const older = (data ?? []).reverse();
      if (older.length === 0) return { loaded: 0 };

      queryClient.setQueryData<MessageRow[]>(["messages", roomId], (prev) => {
        const prevList = prev ?? [];
        const existingIds = new Set(prevList.map((m) => m.id));
        return [...older.filter((m) => !existingIds.has(m.id)), ...prevList];
      });

      return { loaded: older.length };
    },
  });
}

export function useSendMessage(roomId: string) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ content, mentionAgentIds }: { content: string; mentionAgentIds: string[] }) => {
      if (!user) throw new Error("尚未登入");

      const clientId = crypto.randomUUID();
      const { data: message, error: insertErr } = await supabase
        .from("messages")
        .insert({
          room_id: roomId,
          sender_type: "user",
          sender_user_id: user.id,
          content,
          status: "completed",
          client_id: clientId,
        })
        .select("*")
        .single();
      if (insertErr) throw insertErr;

      if (mentionAgentIds.length > 0) {
        const { error: mentionErr } = await supabase
          .from("message_mentions")
          .insert(mentionAgentIds.map((agentId) => ({ message_id: message.id, agent_id: agentId })));
        if (mentionErr) throw mentionErr;
      }

      queryClient.setQueryData<MessageRow[]>(["messages", roomId], (prev) => {
        const next = prev ?? [];
        if (next.some((m) => m.id === message.id)) return next;
        return [...next, message as MessageRow];
      });

      const { error: dispatchErr } = await supabase.functions.invoke("chat-dispatch", {
        body: { messageId: message.id },
      });
      if (dispatchErr) throw dispatchErr;

      return message as MessageRow;
    },
  });
}
