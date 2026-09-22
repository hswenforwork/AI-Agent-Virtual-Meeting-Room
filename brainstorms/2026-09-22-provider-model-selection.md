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

### Q1：模型選擇要套用在哪個層級？
- 問題：(a) 跟金鑰綁在一起，使用者層級（建議） (b) 房間層級，沿用現有的 `agents.model_config` (c) 兩者都要——使用者層級設預設模型，房間層級可以覆蓋
- 已記錄：使用者選 **(c) 兩者都要**。
- 影響：複雜度變高，需要兩層資料：
  1. 使用者層級的預設模型選擇（跟 BYOK 金鑰一樣，存在使用者、供應商維度）
  2. 房間層級的覆蓋（沿用既有的 `agents.model_config` 欄位，目前有欄位但沒有 UI）
  `agent-run` 目前解析模型的順序是 `agent.model_config.model ?? DEFAULT_MODEL_BY_PROVIDER[provider]`（寫死的環境變數預設值）；這次要改成三層優先順序：房間覆蓋 → 使用者預設 → 寫死的環境變數兜底（避免使用者完全沒設定時整個掛掉）。
  前端也要有兩個 UI 入口：「設定」頁的使用者層級預設模型選擇，跟房間內某個地方（待下一題確認位置）的房間層級覆蓋選擇。
