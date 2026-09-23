# 修正「卡在回覆中」+ 新增停止功能：設計紀錄
日期：2026-09-23 · 目標：修正對話卡在「OOO 回覆中…」不會消失的問題，並讓使用者能主動停止 AI 正在生成的回覆
狀態：完成

## 問題

使用者回報：目前對話都卡在「Claude 回覆中…」，而且沒有辦法讓 AI 停止回覆。

## 根因（卡住的 bug）

`agent-run/index.ts` 最外層的 `catch` 區塊，原本只有例外是 `ProviderHttpError`（供應商
API 回傳非 2xx）時才會呼叫 `failRun()` 把 `agent_runs.status` 標成 `failed`：

```ts
} catch (err) {
  if (err instanceof ProviderHttpError) {
    ...
    await failRun(admin, runId, ...);
  }
  return jsonError(...);  // 其他類型的例外完全沒有更新 agent_runs.status
}
```

任何其他型別的例外（DB 寫入失敗、`JSON.parse` 失敗、非預期的 `undefined` 存取等——例如
`worker_tasks`/`messages` insert 失敗時目前是 `throw workerTaskErr ?? new Error(...)`，
丟出的不是 `ProviderHttpError`）都只會被 `console.error` 記錄下來，`agent_runs.status`
永遠停在 `queued`／`running`。前端 `useAgentRunStatus` 是靠這個欄位判斷要不要顯示
「OOO 回覆中…」，run 卡住，這個提示就永遠不會消失，使用者也完全看不到任何錯誤訊息或
系統提示——表現起來就是「卡住不動」。

**修正**：不管例外是什麼型別，只要拿得到 `runId` 就一律呼叫 `failRun()` 收尾（差別只在
`ProviderHttpError` 才用 `friendlyProviderError()` 轉成對應的錯誤訊息，其他一律是
「系統暫時發生錯誤，請稍後重試」）。

## 停止功能設計

### 已記錄
- `agent_runs.status` 的 check 約束（`0001_init.sql`）本來就已經包含 `'cancelled'`，只是
  從來沒有任何程式碼會寫入這個值——等於 schema 早就預留好了，只差機制。
- Edge Function 是無狀態的 HTTP 呼叫，前端沒有辦法直接「打斷」一個正在執行中的
  `agent-run` invocation；唯一可行的作法是讓 `agent-run` 自己在執行過程中定期檢查
  一個「使用者要求停止」的旗標，偵測到後自己 `AbortController.abort()` 掉呼叫中的
  供應商 fetch。
- 只針對**串流輸出**（`generateStream`，也就是真正組成聊天回覆、耗時最長、使用者最有感的
  那段）加上可中止能力；意圖分類（`classifyMessage`，maxOutputTokens 600）、房間標題
  產生、對話摘要都是低 token 上限、一次性的短呼叫，不特別加中止支援，避免整個變更範圍
  過度膨脹。

### 機制
1. Migration `0015_agent_run_cancel.sql`：`agent_runs` 新增 `cancel_requested boolean
   not null default false`。
2. 新 Edge Function `agent-run-stop`：使用者呼叫（帶自己的 JWT），驗證房間成員身分後，
   把指定 `runId` 的 `cancel_requested` 標成 `true`。只下旗標，不直接碰供應商 API。
3. `agent-run/index.ts`：
   - 拿到 run 資料的當下（都還沒轉成 `running` 之前）先看一次 `cancel_requested`，
     使用者在代理都還沒真正開始跑之前就按停止的話，直接標 `cancelled`、不呼叫任何供應商。
   - 意圖分類跑完、正要建立串流訊息卡片之前，再查一次最新的 `cancel_requested`
     （分類呼叫本身可能花了一段時間，這段期間使用者也可能已經按了停止）。
   - 真正開始 `generateStream()` 前建立一個 `AbortController`，並用 `setInterval`
     每 700ms 查一次 `cancel_requested`——不能只在 `onDelta` 裡檢查，因為供應商在吐出
     第一個字之前可能安靜一段時間（模型思考中），那段期間 `onDelta` 完全不會被呼叫。
     偵測到旗標為真就 `abortController.abort()`。
   - 三家供應商的 `generateStream()` 都補上 `signal?: AbortSignal` 參數，直接傳進
     `fetch()` 的 `signal` 選項；`fetch` 被 abort 時會丟出 `AbortError`，`readSseStream`
     沒有吞掉這個例外，會原封不動往上傳到 `agent-run` 的 catch 區塊。
   - catch 到的例外如果是 abort（`abortController.signal.aborted` 為真，或例外本身是
     `DOMException` 且 `name === "AbortError"`），視為「使用者主動停止」：訊息內容補上
     「（已停止回覆）」、`messages.status` 設 `failed`（`messages.status` 的 check 約束
     沒有專門的 cancelled 值，沿用既有的 `failed`）、`agent_runs.status` 設 `cancelled`。
     跟「回覆中斷，請稍後重試或重新發問」（真正的供應商/系統錯誤）分開處理，文案不同。
4. 前端：
   - `useAgentRunStatus` 從回傳 `Set<agentId>` 改成 `Map<agentId, runId>`，UI 才知道
     停止哪一個 run（一次可能同時有多位代理在跑）。
   - `ChatPanel` 每個「OOO 回覆中…」旁邊補一顆「停止」按鈕，呼叫新增的
     `useStopAgentRun()`（打 `agent-run-stop`）。按鈕點擊後不用等 `agent-run` 真的中止，
     Realtime 訂閱本來就有在聽 `agent_runs` 的 `UPDATE`，`status` 一變成 `cancelled`
     這個 agent 就會自動從「回覆中」列表移除。

### 已知取捨
- 停止是「盡力而為」，最長會有一次輪詢間隔（700ms）+ 一次網路來回的延遲，不是瞬間生效。
- Edge Function 真的整個當掉／被平台強制回收（跟停止功能無關的極端狀況，例如超過執行時間
  上限）目前還是沒有機制能救回卡住的 run；這次只解決「函式本身正常執行、但拋出例外」
  這種目前已知會發生、也已經修好的情境。之後如果還有 run 卡住的回報，下一步可以考慮加
  一個定期清理「running 超過 N 分鐘」的排程來兜底。
