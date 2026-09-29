// 項目 7 修正（孤兒 queued 紀錄）：chat-dispatch 原本只在「同一次呼叫真的執行到
// dispatchAgentRuns()／進入 waitUntil()」之後才會替失敗的觸發把 agent_run 標成 failed。
// 如果執行環境在 insert agent_runs 成功之後、這段程式碼還沒開始跑之前就被中止
// （例如平台在回應送出之前就直接回收 isolate），這筆紀錄會永遠卡在 queued，
// 沒有任何程式碼路徑會再碰到它——使用者看到的是訊息永遠停在「OOO 回覆中…」。
//
// 這裡不是等一個獨立排程才處理，而是讓每一次 chat-dispatch 被呼叫時，先「順手」
// 清掃一次全域（不限同一個房間/訊息）逾時仍卡在 queued 的紀錄。理由：chat-dispatch
// 幾乎每次使用者發訊息都會被呼叫，是全站呼叫頻率最高的入口，靠它順手清掃比等一個
// 獨立排程更快讓卡住的訊息被標成 failed；agent-run-reaper（見同目錄的
// supabase/functions/agent-run-reaper）則是給「完全沒人發訊息」的房間準備的
// pg_cron 備援，見 README「附加設定：孤兒 queued 紀錄排程復原」。
//
// 門檻刻意設定得比 chat-dispatch 自己的逾時重試機制（AGENT_RUN_FETCH_TIMEOUT_MS
// * AGENT_RUN_FETCH_MAX_ATTEMPTS + 重試間隔，預設情境下大約 30 秒內就會有結果）
// 大很多，避免把一筆「其實还在正常重試中，只是還沒到時限」的紀錄誤判成孤兒。

import type { supabaseAdmin } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

export const STALE_QUEUED_AGENT_RUN_MS = Number(
  Deno.env.get("STALE_QUEUED_AGENT_RUN_MS") ?? String(5 * 60 * 1000),
);

export interface ReapResult {
  reapedIds: string[];
}

// 把逾時仍是 queued 的 agent_runs 標成 failed（error_code=orphaned_before_dispatch）。
// 用條件式 UPDATE（status='queued' 才會被改動）而不是先 SELECT 再 UPDATE，
// 避免跟真的還在跑的 dispatchAgentRuns() 之間出現競態、蓋掉剛好同時完成的狀態。
export async function reapStaleQueuedAgentRuns(
  admin: AdminClient,
  staleMs: number = STALE_QUEUED_AGENT_RUN_MS,
): Promise<ReapResult> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const { data, error } = await admin
    .from("agent_runs")
    .update({
      status: "failed",
      error_code: "orphaned_before_dispatch",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "queued")
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    console.error("reapStaleQueuedAgentRuns 查詢失敗", error);
    return { reapedIds: [] };
  }
  return { reapedIds: (data ?? []).map((row) => row.id as string) };
}
