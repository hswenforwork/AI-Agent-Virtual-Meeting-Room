# 階段 6：設定「工作型代理」（Managed Agents）

## 目標
讓聊天室裡的任務卡片可以真的執行——建立 Anthropic Managed Agents 的 agent／environment，設定對應的 Supabase secrets。
依訪談 Q5，這不是選用項目，是完整部署的一部分；但依 Q6，這關排在使用者已經有能用的聊天室**之後**才做，卡關不影響已完成的部分。

## 第一步：直接嘗試，不要只是叫使用者自己去 Console 查

Phase 4 已經拿到使用者的 `ANTHROPIC_API_KEY`。**不要**只叫使用者自己去 Console 確認有沒有 Managed Agents 權限——直接用這把 key 呼叫 Managed Agents API 試一次最輕量的動作（例如建立 environment，見下方），從回應判斷：

- 成功（拿到 `env_...` 開頭的 ID）：這把 key 有權限，直接繼續下面的自動設定。
- 失敗且錯誤看起來是「沒有這個 beta 功能的權限」（例如 403、或錯誤訊息提到 beta／not enabled）：跳到「卡關時怎麼辦」。
- 失敗是其他原因（額度不足、key 打錯）：比照一般 API 錯誤處理，翻譯成白話告訴使用者。

## 建立 environment 與 agent（等同 `scripts/setup-managed-agent.sh` 做的事，但由 AI 直接呼叫 API 完成，不需要使用者開 Codespaces 跑腳本）

呼叫 `POST https://api.anthropic.com/v1/environments` 與 `POST https://api.anthropic.com/v1/agents`，帶上 headers：
```
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2023-06-01
anthropic-beta: managed-agents-2026-04-01
```

body 內容直接照抄這個 repo 的 `scripts/setup-managed-agent.sh`（裡面已經寫好完整的 environment 設定、agent 的 system prompt、`agent_toolset_20260401` 工具、`consult_other_ai` 自訂工具 schema）——不要重寫一份不一樣的，兩邊要保持一致，避免之後行為對不起來。

⚠️ 這是 beta API，執行前如果能連網查證，用 WebFetch 核對 `https://docs.claude.com`（或 Anthropic 官方 Managed Agents 文件）目前的端點/欄位是否還是這樣；連不出去才直接照 `setup-managed-agent.sh` 現有內容執行。

拿到回應裡的 `agent_id`、`environment_id`。

## 卡關時怎麼辦（Managed Agents beta 權限還沒開通）

不要卡住整個流程。跟使用者說清楚，然後照 Phase 7 收尾，把這關標記成「之後再完成」：

> 你的 Anthropic 帳號目前還沒有 Managed Agents（工作型代理背後的技術）的使用權限，這個功能需要另外申請開通，我這邊沒辦法幫你點——你可以到 Anthropic Console 找找有沒有申請 beta 功能的入口，或聯絡 Anthropic 詢問。基礎聊天室功能都已經正常運作了，這個進階功能之後申請到權限，隨時可以叫我回來接著做，跟我說「現在有 Managed Agents 權限了」就可以繼續。

## 引導使用者提供剩下兩組值（一次講完，不分次問）

> 工作型代理還需要兩樣東西，麻煩一次幫我準備好：
> 1. **Gemini API key**（讓工作型代理卡住時可以自動求助另一位 AI，不設也能用，只是卡住時求助不到人）：到 https://aistudio.google.com 申請一把免費的 API key
> 2. **一個 GitHub Personal Access Token**（讓工作型代理可以修改你剛剛 fork 出來的這個專案本身）：到 `https://github.com/settings/personal-access-tokens/new`，Repository access 選「Only select repositories」→ 選 `<target_owner>/<target_repo>`，Permissions 裡的 **Contents** 選 **Read and write**，建立後複製貼給我
>
> 兩個都是選用的，沒有也不影響基礎功能，只是工作型代理會少兩個能力。要跳過的話直接跟我說「跳過」就好。

## 設定 Managed Agents 相關的 Supabase secrets

跟 Phase 4 一樣的方式（Management API 優先），設定：

```
MANAGED_AGENTS_AGENT_ID=<agent_id>
MANAGED_AGENTS_ENVIRONMENT_ID=<environment_id>
GEMINI_API_KEY=<使用者提供，若跳過則不設定這條>
GITHUB_REPO_URL=https://github.com/<target_owner>/<target_repo>
GITHUB_TOKEN=<使用者提供，若跳過則不設定這條>
GITHUB_REPO_BRANCH=（留空，讓它用預設分支）
```

## 完成判斷
`MANAGED_AGENTS_AGENT_ID`／`MANAGED_AGENTS_ENVIRONMENT_ID` 設定成功（或明確卡在 beta 權限、已經跟使用者說清楚現況與怎麼接續）。

## 跟使用者說的話（範例，設定成功時）
> 工作型代理也設定好了。最後我幫你確認一下所有部署狀態，整理一份總結給你。

接著進入 `references/07-wrap-up.md`。
