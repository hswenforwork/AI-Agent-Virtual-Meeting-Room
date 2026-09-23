import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { AgentRunStatus } from "../../types/database";

// 顯示代理狀態（對應原始規劃文件 MVP 必須完成 #8），MVP 簡化為「是否正在工作中」。
// brainstorms/2026-09-23-gpt-audit-followups.md Q9：掛載時先查一次現有的 queued/running
// 紀錄，再接上 Realtime 訂閱後續變化——原本只訂閱事件，重新整理頁面時如果剛好有代理正在
// 回覆中，會因為錯過了那個事件而完全不知道，「OOO 回覆中…」的提示就不會出現。
export function useAgentRunStatus(roomId: string) {
  const [runningAgentIds, setRunningAgentIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    supabase
      .from("agent_runs")
      .select("agent_id, status")
      .eq("room_id", roomId)
      .in("status", ["queued", "running"])
      .then(({ data }) => {
        if (cancelled || !data) return;
        setRunningAgentIds(new Set(data.map((row) => row.agent_id as string)));
      });

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
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  return runningAgentIds;
}
