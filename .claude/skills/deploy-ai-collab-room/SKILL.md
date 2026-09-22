---
name: deploy-ai-collab-room
description: Use this skill when the user wants to deploy, set up, install, fork, or get their own working copy of "AI 協作室" (AI Agent Virtual Meeting Room) — the chatroom project this skill ships inside. Trigger on requests like "幫我部署這個工具", "我要一份自己的 AI 協作室", "把這個專案架起來給我用", "deploy this project for me", or any request to stand up a personal instance of this specific repo end to end (Supabase, GitHub, Edge Functions, and optionally the Managed Agents worker-agent feature). Do NOT use for general Supabase/GitHub Actions questions unrelated to this project, and do not use to develop new features in an already-deployed instance.
---

# 部署「AI 協作室」給使用者自己用

把這個 repo（`AI 協作室` / AI Agent Virtual Meeting Room）完整 fork、部署成使用者自己的一份可運作的網站。
設計依據：`brainstorms/2026-09-22-package-deployment-skill.md`（這份訪談紀錄記錄了每個決策的理由，遇到本文件沒講清楚的情況可以回去查）。

## 這個 Skill 的性格：假設使用者完全不懂技術

**目標使用者可能連「API key」是什麼都不知道。** 每一步都要：
- 用最白話的中文說明「現在要做什麼、為什麼」，不要丟術語不解釋
- 只在真的需要使用者做某個具體動作時才停下來問；能自己做的絕不假手於人
- 一次只交代**一個**動作，講清楚「去哪裡、點什麼、複製什麼貼回來給我」，做完才繼續下一個動作
- 錯誤訊息要翻譯成「發生了什麼事、接下來我會怎麼處理」，不要原樣丟技術錯誤堆給使用者

## 核心原則（不可違反）

1. **能自動化就自動化，人工步驟壓到最少、最簡單。** 這是這次訪談定案最重要的一條：使用者明確說「我要全自動」「所有可以用 API 的都用 API」。每個階段開始前，先假設「這步能不能用工具做」，只有真的不行才開口請使用者操作。
2. **一次一步，等確認才繼續**（訪談 Q3），但**同一個人工步驟裡要一次講清楚所有要複製貼上的東西**，不要來回好幾輪（訪談 Q9）。
3. **金鑰／Token 絕對不能寫進任何會被 commit 的檔案。** 只能作為工具呼叫的參數、或當次指令的環境變數使用；用完即忘，不記錄在 `brainstorms/`、不 log 出明碼。
4. **能查證就查證，不要憑印象猜 API 規格。** 這個技能撰寫時，作者對 Supabase Management API 的網路存取被擋住，所以本文件裡凡標記「⚠️ 執行前先驗證」的地方，代表寫的是「最後一次確認過的樣子」，執行時要先用 WebFetch 抓官方文件或該 API 自己的 OpenAPI spec 核對一次，不要照抄本文件就送出真正的請求。
5. **每個階段結束都要有一個可驗證的「完成」訊號**（workflow 跑綠、API 回傳 200、查得到剛建立的資源），不要憑感覺說「應該好了」。

## Supabase 操作優先用官方 MCP 工具，不是手刻 curl

這個 repo 根目錄已經有 `.mcp.json`，宣告了 Supabase 官方的 MCP Server（`@supabase/mcp-server-supabase`）。**每次要對 Supabase 做任何操作之前，先用 `ToolSearch` 查一次 `supabase`**：

- **查得到 `mcp__supabase__*` 工具**：全部改用這些工具，不要再手刻 curl 呼叫 Management API。這樣不用自己猜欄位名稱、不用處理加密／分頁，也不會因為記錯規格而送出錯誤的請求——本文件裡所有「⚠️ 執行前先驗證」加「照抄本文件的 curl 規格」的段落，只在**查不到這些 MCP 工具時**才適用，當作備援手段。
- **查不到**：代表這個 session 還沒連上 Supabase MCP Server，通常是因為環境變數 `SUPABASE_ACCESS_TOKEN` 沒設定，或使用者的 Claude Code 還沒信任／啟用 `.mcp.json` 裡的這個 server。跟使用者說明一次（不用每個階段都重複問）：

  > 這個專案設定了 Supabase 官方的自動化工具，能讓我操作得更準確、更不容易出錯，但需要你設定一個環境變數 `SUPABASE_ACCESS_TOKEN`（到 https://supabase.com/dashboard/account/tokens 申請一組 Personal Access Token，設定成這個環境變數）並讓 Claude Code 信任這個 repo 裡的 MCP 設定。設定好之後跟我說一聲，我會重新檢查一次；沒有的話我還是可以直接用 curl 呼叫 Supabase 的 API 完成，只是可靠度稍微低一點。

  使用者選擇不設定，或這個環境本來就連不上外部 MCP Server（例如作者撰寫這份技能時的環境），就照本文件各階段寫的 curl／WebFetch 查證流程走，不要卡住不動。

### ⚠️ curl 備援路線在 Claude Code on the web／雲端環境會被網路政策擋住

實測發現：在 Claude Code 的雲端 session（claude.ai/code）裡，即使 `SUPABASE_ACCESS_TOKEN` 已經設定好、Bash 也讀得到這個環境變數，直接用 `curl` 打 `api.supabase.com` 還是會被這個環境自己的網路存取政策擋下來（`CONNECT tunnel failed, response 403`，是政策拒絕，不是暫時連不上）——雲端環境預設的 **Trusted** 網路等級只放行套件庫、GitHub、雲端 SDK 這些網域，`api.supabase.com`不在預設清單裡。

判斷方式：curl 打 Management API 任何端點，如果錯誤訊息提到 `CONNECT tunnel failed` 或 `agent proxy` 相關字樣，代表是這個網路政策擋住，不是 token 或 API 規格的問題，不要浪費時間重試或懷疑 token 錯誤。

兩條路都試過還是不行的話，跟使用者說明兩個選項（一次講清楚，不要來回問）：

> curl 呼叫 Supabase 這條備援路線在目前這個雲端環境被網路政策擋住了——你的環境目前只允許連到套件庫、GitHub 這些預設網域。有兩個選擇：
> 1. 到環境設定把 Network access 從 Trusted 改成 Custom，加一行 `api.supabase.com` 到 Allowed domains（記得勾選「Also include default list of common package managers」保留原本能連的東西），存檔後開新 session 生效；MCP 工具本身的連線不受這個清單限制，如果 MCP 工具連得上，不需要做這步
> 2. 這次先手動貼 SQL 到 Supabase Dashboard 的 SQL Editor 執行——對單一 migration 來說通常比重新設定網路政策快，我可以把 SQL 內容整段印出來給你複製

沒有強制要走選項 1，使用者選 2 也完全可以，不要因為想要「全自動」就卡住不繼續。

## 前置條件

執行這個 Skill 之前，Claude 所在的 session 必須：
- 有 GitHub 工具存取權（`mcp__github__*`），並且已經連上這個原始 repo（`hswenforwork/AI-Agent-Virtual-Meeting-Room`，或它的某個 fork）
- 有 Bash 工具（用來跑 curl／node 做 Supabase Management API 呼叫、跑 migration，在拿不到 Supabase MCP 工具時使用）
- 有 WebFetch 或等效工具（用來執行前查證 API 規格，在拿不到 Supabase MCP 工具時使用）

Supabase MCP 工具是加分項，不是前置條件——有就用，沒有就退回 curl，不要因為沒有就中止整個部署。
如果 GitHub 工具或 Bash 都不滿足，才需要先如實告訴使用者缺什麼，不要硬著頭皮做到一半才發現卡住。

## 流程總覽

| 階段 | 檔案 | 做什麼 | 主要靠誰 |
|---|---|---|---|
| 0 | 本文件 | 確認起點、跟使用者說明接下來會發生什麼 | AI |
| 1 | `references/01-fork-repo.md` | Fork repo 到使用者帳號下 | AI（GitHub API） |
| 2 | `references/02-supabase-project.md` | 建立 Supabase 專案、跑 3 個 migration | AI 優先（Supabase MCP，其次 Management API curl），都拿不到才退化成引導使用者手動貼 SQL |
| 3 | `references/03-github-config.md` | 設定 GitHub repo 的 Variables/Secrets、開 Pages | AI（GitHub API），Pages 來源切換視 API 支援情況 |
| 4 | `references/04-edge-function-secrets.md` | 設定 Supabase Edge Function 的 secrets（Anthropic key 等） | AI 優先（Supabase MCP，其次 Management API curl） |
| 5 | `references/05-verify-basic-deploy.md` | 確認三個 GitHub Actions 都跑綠、請使用者實際打開網站測試 | AI 查狀態 + 使用者最後手動驗收 |
| 6 | `references/06-managed-agents.md` | 「工作型代理」完整設定（Managed Agents beta、Gemini 求助、GitHub 存取） | 這關最依賴使用者帳號權限，AI 盡量自動、人工步驟本身要極簡化 |
| 7 | `references/07-wrap-up.md` | 最終驗收、交付使用手冊 | AI 查狀態 + 使用者最後測試 |

參考資料：`references/troubleshooting.md`（這個專案過去踩過、跟「重新部署一份新的」還相關的坑）。

**依序做完 1→7，不要跳過 6**（訪談 Q5：工作型代理跟基礎功能一起做完，不是選用附加項）。但 6 裡面「Managed Agents beta 權限」這個最不確定的關卡，安排在使用者已經有一個能用的聊天室之後才處理（訪談 Q6）——如果卡在等 Anthropic 審核，不影響使用者先用基礎功能。

## 開始之前，跟使用者說的第一句話

用類似這樣的話開場（依對話語氣調整，但意思要涵蓋）：

> 我會把整個部署過程拆成幾個階段，大部分我自己就能做完，中間大概只有 4-6 次需要你去某個網站申請一組金鑰、複製貼給我——每一次我都會講清楚要去哪裡、點什麼。準備好了就開始第一步：把這個專案複製一份到你自己的 GitHub 帳號下。

然後開始 `references/01-fork-repo.md`。
