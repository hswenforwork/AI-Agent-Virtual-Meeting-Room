import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { AgentRunStatus } from "../../types/database";

// 顯示代理狀態（對應原始規劃文件 MVP 必須完成 #8），MVP 簡化為「是否正在工作中」。
// brainstorms/2026-09-23-gpt-audit-followups.md Q9：掛載時先查一次現有的 queued/running
// 紀錄，再接上 Realtime 訂閱後續變化——原本只訂閱事件，重新整理頁面時如果剛好有代理正在
// 回覆中，會因為錯過了那個事件而完全不知道，「OOO 回覆中…」的提示就不會出現。
// 停止功能（brainstorms/2026-09-23-stop-generation.md）：改回傳 agentId -> runId 的
// Map（原本只是 Set<agentId>），前端才知道要停止哪一個 run。
export function useAgentRunStatus(roomId: string) {
  const [runningRuns, setRunningRuns] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    supabase
      .from("agent_runs")
      .select("id, agent_id, status")
      .eq("room_id", roomId)
      .in("status", ["queued", "running"])
      .then(({ data }) => {
        if (cancelled || !data) return;
        setRunningRuns(new Map(data.map((row) => [row.agent_id as string, row.id as string])));
      });

    const channel = supabase
      .channel(`room-${roomId}-agent-runs`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_runs", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as { id: string; agent_id: string; status: AgentRunStatus };
          setRunningRuns((prev) => {
            const next = new Map(prev);
            if (row.status === "queued" || row.status === "running") {
              next.set(row.agent_id, row.id);
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

  return runningRuns;
}

// 停止代理回覆：呼叫 agent-run-stop，只下「請求停止」的旗標，實際中止呼叫中的供應商
// 請求是 agent-run 自己在串流過程中偵測到 cancel_requested 後做的（見該函式內註解）。
export function useStopAgentRun() {
  return useMutation({
    mutationFn: async (runId: string) => {
      const { error } = await supabase.functions.invoke("agent-run-stop", { body: { runId } });
      if (error) throw error;
    },
  });
}
