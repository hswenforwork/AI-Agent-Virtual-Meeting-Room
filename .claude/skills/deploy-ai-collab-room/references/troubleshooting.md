# 已知狀況對照表

這個專案上線後踩過的坑，大多數已經直接修進程式碼／migration 本體，全新部署不會重現。
這裡只列**部署一份新專案時仍然可能遇到**的狀況（環境設定層級的問題，不是程式碼的 bug）。

| 症狀 | 原因 | 處理方式 |
|---|---|---|
| Supabase secrets 設定 `SUPABASE_URL`／`SUPABASE_ANON_KEY`／`SUPABASE_SERVICE_ROLE_KEY` 時報錯「Name must not start with the SUPABASE_ prefix」 | 這三個是 Supabase 保留字，平台會自動注入給每個 Edge Function，**本來就不能手動設定** | 不要設這三個，本來就不需要 |
| 執行 `0006_enable_realtime.sql` 報錯「already member of publication」 | `0001_init.sql` 已經內含相同的 `alter publication` 語句，全新專案不該再跑 `0003`～`0006` | 全新部署只跑 `0001`／`0002`／`0007`／`0008`，見 `02-supabase-project.md` |
| GitHub Pages 打開網站看到舊內容、404、或整頁空白 | Pages 的 Source 沒設成 **GitHub Actions**（還停在預設的 `Deploy from a branch`），這種情況下 Pages 是直接 serve repo 原始檔案，不是建置後的 `dist/` | 檢查 `https://github.com/<owner>/<repo>/settings/pages`，Source 要是 GitHub Actions；已經在 Phase 3 嘗試用 API 直接設定，失敗才需要人工檢查 |
| 建立房間、發訊息出現「new row violates row-level security policy」 | `0001_init.sql` 目前的版本已經修好 owner_id 預設值與 SELECT 政策；如果還是遇到，代表跑的 `0001` 不是最新版，或中途手動改過 schema | 確認執行的是這個 repo 目前 `main` 分支上的 `0001_init.sql`，不是舊版快取 |
| 訪客登入按鈕點了沒反應、或註冊後收不到驗證信 | Auth 設定的 **Confirm email** 沒關、**Anonymous Sign-ins** 沒開 | 見 `02-supabase-project.md` 的「打開兩個 Auth 設定」；Email 每小時限寄 2 封是 Supabase 免費方案的限制，不是 bug |
| GitHub Actions 建置失敗，log 提到找不到 `VITE_SUPABASE_URL` 或值明顯錯誤（例如結尾多了 `/rest/v1/`） | Variables 設定錯誤 | `VITE_SUPABASE_URL` 只到 `.supabase.co` 結尾，不要帶路徑；重新檢查 Phase 3 設定的值是不是 Phase 2 拿到的 `project_url` 原始值 |
| 工作型代理任務卡片一直停在「執行中」不會變成「已完成」 | 如果是 fork 自這個 repo 目前的 `main`，這個 bug（背景事件迴圈沒有正確跳出）已經修好；如果之後有人改過 `supabase/functions/worker-task-start/index.ts` 的事件迴圈，要注意收到 `session.status_idle`／`session.status_terminated` 後要在同一輪迴圈內立刻 `break`，不能只在下一輪開頭才檢查——session 進入 idle 之後通常不會再有下一個事件，晚一輪檢查等於永遠等不到 | 確認 fork 的版本夠新；自己修改這段程式碼時保留這個行為 |
| 任務卡片「開始執行」按鈕點了沒反應 | 同上，如果是修改過前端 `useMessages.ts` 的 Realtime 訂閱，要注意除了 `INSERT` 也要訂閱 `UPDATE`，否則任務卡片後續補上的 `workerTaskId`／狀態更新收不到 | 確認 fork 的版本夠新，或訂閱時兩種 event 都要 `.on(...)` |
| Managed Agents 的 `POST /v1/environments`／`/v1/agents` 回傳 403 或提到 beta／not enabled | Anthropic 帳號還沒開通 Managed Agents（CMA）beta 權限 | 見 `06-managed-agents.md`「卡關時怎麼辦」，不影響已完成的基礎部署 |
| `ToolSearch` 查 `supabase` 查不到任何 `mcp__supabase__*` 工具 | 這個 repo 的 `.mcp.json` 宣告了 Supabase 官方 MCP Server，但還沒被目前這個 Claude Code session 連上——通常是環境變數 `SUPABASE_ACCESS_TOKEN` 沒設定，或使用者的 Claude Code 還沒信任／啟用這個專案的 `.mcp.json` | 不是必要條件，不用卡住：直接退回各階段文件裡的 curl／手動備援路線繼續做；跟使用者說明一次可以怎麼設定讓下次連得上（見 `SKILL.md`「Supabase 操作優先用官方 MCP 工具」） |
