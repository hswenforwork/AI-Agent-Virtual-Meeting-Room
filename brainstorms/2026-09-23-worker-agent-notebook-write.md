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
- 已記錄：（待訪談）

## 待釐清事項
（隨訪談持續更新）
