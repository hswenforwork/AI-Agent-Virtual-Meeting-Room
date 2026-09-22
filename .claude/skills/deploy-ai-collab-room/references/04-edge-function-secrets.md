# 階段 4：設定 Supabase Edge Function Secrets

## 目標
讓後端（Edge Functions）真的能呼叫 Anthropic API 回覆訊息。

## 要設定的四個值

```
ANTHROPIC_API_KEY=<使用者的 Anthropic API key>
ALLOWED_ORIGINS=<pages_url，Phase 1 算出來的那個 https://<username>.github.io/<repo>/ 網址，去掉結尾斜線>
DEFAULT_CLAUDE_MODEL=claude-sonnet-5
MAX_AGENT_RUNS_PER_MESSAGE=4
```

`ALLOWED_ORIGINS`、`DEFAULT_CLAUDE_MODEL`、`MAX_AGENT_RUNS_PER_MESSAGE` 三個不需要使用者提供，AI 自己算、自己填。真正需要使用者的只有 `ANTHROPIC_API_KEY`。

## 引導使用者申請 Anthropic API key（一次講完）

> 接下來需要一把 Anthropic 的 API key，讓聊天室裡的 Claude 真的能回覆訊息：
> 1. 打開 https://console.anthropic.com 註冊／登入
> 2. 左側找到 **API Keys**，點 **Create Key**，複製那串（通常長得像 `sk-ant-...`）貼給我
> 3. 這把 key 需要先儲值一點額度才會真的能用（Console 裡的 **Billing** 頁面加值卡）——先加個幾美金測試沒問題

拿到之後只在工具呼叫裡使用，不寫進任何 commit 的檔案。

## 設定 secrets：MCP 優先，curl 次之，手動貼最後

1. 先 `ToolSearch` 查 `supabase`，有 `mcp__supabase__*` 工具的話用它設定 secrets（通常會有直接對應的工具），跳過下面兩點。
2. 沒有的話用 Management API：`POST /v1/projects/{project_ref}/secrets`（⚠️ 執行前用 WebFetch 核對 `https://supabase.com/docs/reference/api/v1-create-a-secret` 或跟 Phase 2 一樣打 `/api/v1-json` 核對欄位名稱），依過去理解，body 是一個陣列，每個元素 `{"name": "...", "value": "..."}`，可以一次把四組全送出去。
3. 都不行才請使用者到 Supabase Dashboard 的 **Edge Functions → Secrets** 頁面手動貼——但一樣要**一次把四組名稱／值都列出來**，不要一個一個問。

## 完成判斷
四個 secrets 都設定成功（Management API 回應正常，或使用者回報已經貼完）。

## 跟使用者說的話（範例）
> 後端金鑰也設定好了。我現在幫你確認一下網站有沒有真的部署成功——這步不需要你做什麼，等我一下。

接著進入 `references/05-verify-basic-deploy.md`。
