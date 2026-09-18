import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { AgentRunStatus } from "../../types/database";

// 顯示代理狀態（對應原始規劃文件 MVP 必須完成 #8），MVP 簡化為「是否正在工作中」。
export function useAgentRunStatus(roomId: string) {
  const [runningAgentIds, setRunningAgentIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const channel = supabase
      .channel(`room-${roomId}-agent-runs`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_runs", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as { agent_id: string; status: AgentRunStatus };
          setRunningAgentIds((prev) => {
            const next = new Set(prev);
            if (row.status === "queued" || row.status === "running") {
              next.add(row.agent_id);
            } else {
              next.delete(row.agent_id);
            }
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  return runningAgentIds;
}
