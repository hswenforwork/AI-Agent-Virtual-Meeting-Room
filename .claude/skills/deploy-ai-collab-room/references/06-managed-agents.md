# 階段 6：（選用）讓工作型代理能修改專案自己的 GitHub repo

## 目標
BYOK 上線後（`brainstorms/2026-09-22-user-api-key-settings.md` Q9/Q10），「工作型代理」背後的
Anthropic Managed Agents（CMA）agent／environment，是每個使用者自己在「設定」頁輸入 Anthropic
API key 之後，第一次按任務卡片的「開始執行」時，由後端自動建立並重複使用（邏輯見
`supabase/functions/_shared/managedAgents.ts` 的 `createManagedAgent()`/`createManagedEnvironment()`）。
**這個階段不需要部署者提供任何 Anthropic 或 Gemini 金鑰、不需要呼叫 Managed Agents API 幫使用者建立
任何資源**——那些事情使用者自己用網站就會觸發。

這個階段唯一還需要部署者決定的，是**要不要讓工作型代理有權限修改這個專案自己的 GitHub repo**
（例如使用者請代理「幫我在這個專案加個功能」時，代理能不能直接 commit）。這是選用項目，不設定
也完全不影響聊天、記事本、待辦事項、檔案夾，也不影響工作型代理修改其他一般任務（寫檔案、整理資料等）。

## 引導使用者提供 GitHub Token（選用，一次講完）

> 工作型代理如果要能直接修改你剛剛 fork 出來的這個專案本身（例如「幫我加個功能」直接幫你 commit），
> 需要一個 GitHub Personal Access Token：到 `https://github.com/settings/personal-access-tokens/new`，
> Repository access 選「Only select repositories」→ 選 `<target_owner>/<target_repo>`，Permissions 裡的
> **Contents** 選 **Read and write**，建立後複製貼給我。
>
> 這是選用的，沒有也完全不影響其他功能，只是工作型代理沒辦法直接改這個專案自己的原始碼。要跳過的話
> 直接跟我說「跳過」就好。

## 設定 Supabase secrets（使用者有提供 token 才需要）

跟 Phase 4 一樣的優先順序（Supabase MCP 工具優先，其次 Management API curl，最後才手動貼），設定：

```
GITHUB_REPO_URL=https://github.com/<target_owner>/<target_repo>
GITHUB_TOKEN=<使用者提供的 token>
GITHUB_REPO_BRANCH=（留空，讓它用預設分支）
```

使用者選擇跳過的話，這個階段直接算完成，不設定任何東西。

## 完成判斷
使用者選擇提供 token 的話，三個 secrets 都設定成功；選擇跳過的話，直接視為完成。
兩種情況都不需要卡住等待，也不需要測試 Managed Agents API（那是使用者自己第一次用工作型代理時才會發生的事）。

## 跟使用者說的話（範例）
> 這部分也處理好了。最後我幫你確認一下所有部署狀態，整理一份總結給你。

接著進入 `references/07-wrap-up.md`。
