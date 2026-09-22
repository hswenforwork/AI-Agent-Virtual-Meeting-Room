# AI 供應商模型選擇清單：腦力激盪／探索紀錄
日期：2026-09-22 · 目標：讓使用者能在「設定」頁快速挑選每個供應商要用哪個模型，不用再靠後端寫死的預設值
狀態：進行中
背景來源：
- 目前架構：模型完全由後端 Edge Function 的環境變數決定——`DEFAULT_CLAUDE_MODEL`／`DEFAULT_GPT_MODEL`／`DEFAULT_GEMINI_MODEL`，使用者在前端完全看不到、也不能選
- `agents` 表其實已經有一個 `model_config jsonb not null default '{}'::jsonb` 欄位（`supabase/migrations/0001_init.sql`），`agent-run` 也已經會讀 `agent.model_config.model` 優先於環境變數預設值——但目前完全沒有任何 UI 寫入這個欄位，所以永遠是空的，永遠退回環境變數預設值
- 今天才剛修好一個真實 bug：Gemini 的預設模型 `gemini-2.5-flash` 已經被 Google 淘汰、寫死的字串過期導致 API 404，改成 `gemini-3.8-flash` 才修好。使用者看到這個 bug 之後提出這個功能構想
- BYOK（`brainstorms/2026-09-22-user-api-key-settings.md`）已經讓金鑰變成「每個使用者、每個供應商各自一把」，不再是房間層級或部署者層級的設定

## 使用者原話
「AI API Key因該要有各供應商最新模型選擇清單，以便使用找快速套用模型。」

## 摘要／重要決策
（隨訪談持續更新）

## 問答紀錄
