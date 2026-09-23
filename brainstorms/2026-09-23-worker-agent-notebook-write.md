# 工作型代理真正寫進記事本/待辦事項：腦力激盪／探索紀錄
日期：2026-09-23 · 目標：讓工作型代理（Managed Agents 沙盒）能真正寫進聊天室的 notes/tasks 資料表，不再只能輸出成沙盒裡的檔案
狀態：進行中
背景來源：`brainstorms/2026-09-23-worker-agent-delegation-fixes.md`（問題 3：架構缺口說明）、
`supabase/functions/_shared/workspaceWrite.ts`、`supabase/functions/_shared/managedAgents.ts`、
`supabase/functions/worker-task-start/index.ts`、`brainstorms/2026-09-23-workspace-write-cross-room-overwrite.md`

## 已知既有系統事實（訪談前已確認，不重問）
- 工作型代理目前只有兩種工具：`agent_toolset_20260401`（沙盒檔案/bash 操作）跟自訂的
  `consult_other_ai`（卡住時求助另一位 AI）。完全沒有能力寫進 `notes`/`tasks` 表。
- 一般聊天（`agent-run`）已經有成熟的 `applyWorkspaceWrite()`（`workspaceWrite.ts`），支援
  `create_note`/`create_task`/`update_note`/`update_task`/`clarify`，直接用 service_role
  寫資料庫，不需要使用者額外確認（低風險寫入，既有決策）。
- 今天稍早才因為「跨聊天室記事被誤判覆蓋」修過一次分類 prompt：現在的原則是只有訊息
  明確在講修改既有項目時才能 update，不確定一律 create 或 clarify 反問。
- notes/tasks 是 owner_id（房間擁有者）歸屬；`resolveWorkspaceOwnerId(admin, roomId)`
  換算，worker-task-start 的 `SessionContext` 已經有 `roomId`，換算方式相同。
- `consult_other_ai` 的架構模式可參考：worker agent 自己判斷何時呼叫（不是外部分類器
  決定）→ `worker-task-start` 事件迴圈收到 `agent.custom_tool_use` → 執行對應邏輯 →
  `sendCustomToolResult()` 把結果回傳給 session 讓它繼續跑。新工具會是同一種模式。

## 問答紀錄
### Q1：觸發方式——模型自主判斷，還是只在使用者明確要求時才給這個能力？
- 問題：要讓工作型代理自己判斷「這個任務需要記進記事本/待辦」就主動呼叫新工具（跟
  `consult_other_ai` 同一種模式，模型自主決定），還是只有使用者在原始訊息裡明確要求
  （例如「記進記事本」這幾個字）時才附帶這個工具、其他任務完全不給這個能力？
- 已記錄：只有使用者在原始訊息裡明確要求（例如提到「記進記事本」這幾個字）時，才附帶
  這個工具給工作型代理；其他任務完全不給這個能力。
- 技術實作方向（不需要另外確認，記錄下來供實作時參考）：判斷「使用者是否明確要求」
  這件事，比對照 `applyWorkspaceWrite()` 分類 prompt 的既有原則，用 LLM 判斷意圖會比
  正規表示式關鍵字比對更準確（今天稍早修覆蓋 bug 時也是往「讓模型判斷、不要用死板
  規則」的方向調整）。最自然的接法：`classifyMessage()` 判斷出 `kind: "task"` 時，
  順便讓同一次分類呼叫多回傳一個欄位（例如 `needsNotebookTool: boolean`），不需要
  額外一次 API 呼叫。

### Q2：範圍——記事本跟待辦事項都要支援，還是先只做記事本？
- 問題：新工具要同時支援記事本與待辦事項（工具輸入就像 `applyWorkspaceWrite()` 一樣
  支援 `create_note`/`create_task`），還是先只做記事本、待辦事項之後再說？
- 已記錄：同時支援記事本與待辦事項。

### Q3：新增 vs 修改既有項目
- 問題：要不要也支援「修改/更新既有記事本/待辦」（比對既有清單、不確定就 create 或
  clarify），還是先只支援「新增一則」，不處理修改既有項目（風險較低）？
- 已記錄：先只支援新增（`create_note`/`create_task`），不支援修改既有項目。理由：
  工作型代理是長時間執行、使用者可能沒有全程盯著，而且今天稍早才修過一次「跨房間記事
  被誤判成更新既有項目而覆蓋」的 bug，新工具先不碰修改路徑可以避免同一類風險再發生
  一次；之後真的有需要再另外評估。

### Q4：要不要確認機制
- 問題：工作型代理寫進記事本/待辦前，要不要先讓使用者確認（例如寫進任務卡片、使用者
  按確認才真的實行寫入），還是延續一般聊天的「低風險寫入不需確認」原則直接寫？
- 已記錄：不需確認，直接寫入。跟一般聊天的既有決策一致，加上 Q3 已經限定只能新增、
  不能改既有項目，風險已經進一步降低。

## 待釐清事項
（隨訪談持續更新）
