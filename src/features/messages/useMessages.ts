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
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, queryClient]);

  return query;
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
