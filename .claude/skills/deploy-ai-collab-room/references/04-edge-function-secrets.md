# 階段 4：設定 Supabase Edge Function Secrets

## 目標
讓後端（Edge Functions）能正常運作。BYOK 上線後，AI 供應商的金鑰是每個使用者自己到「設定」頁輸入、
加密存進 Supabase Vault（migration `0009_byok_api_keys.sql` 已經建好對應的表跟函式），**這個階段完全
不需要向使用者要任何 AI 金鑰**，AI 自己算好、自己填就好。

## 要設定的三個值

```
ALLOWED_ORIGINS=<pages_url，Phase 1 算出來的那個 https://<username>.github.io/<repo>/ 網址，去掉結尾斜線>
DEFAULT_CLAUDE_MODEL=claude-sonnet-5
MAX_AGENT_RUNS_PER_MESSAGE=4
```

三個都不需要使用者提供，AI 自己算、自己填。

`DEFAULT_GPT_MODEL`（預設 `gpt-5.1`）、`DEFAULT_GEMINI_MODEL`（預設 `gemini-2.5-flash`）是選用的，
不填就用程式內建的預設值，一般部署不需要特別設定。

## 設定 secrets：MCP 優先，curl 次之，手動貼最後

1. 先 `ToolSearch` 查 `supabase`，有 `mcp__supabase__*` 工具的話用它設定 secrets（通常會有直接對應的工具），跳過下面兩點。
2. 沒有的話用 Management API：`POST /v1/projects/{project_ref}/secrets`（⚠️ 執行前用 WebFetch 核對 `https://supabase.com/docs/reference/api/v1-create-a-secret` 或跟 Phase 2 一樣打 `/api/v1-json` 核對欄位名稱），依過去理解，body 是一個陣列，每個元素 `{"name": "...", "value": "..."}`，可以一次把三組全送出去。
3. 都不行才請使用者到 Supabase Dashboard 的 **Edge Functions → Secrets** 頁面手動貼——但一樣要**一次把三組名稱／值都列出來**，不要一個一個問。

## 完成判斷
三個 secrets 都設定成功（Management API 回應正常，或使用者回報已經貼完）。這個階段不需要任何使用者互動也能完成的話，直接完成、不用停下來問。

## 跟使用者說的話（範例）
> 後端的環境變數也設定好了，這步完全不需要你做什麼。接下來我幫你確認一下網站有沒有真的部署成功。

接著進入 `references/05-verify-basic-deploy.md`。
