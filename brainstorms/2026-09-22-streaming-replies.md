# AI 回覆改成串流輸出：腦力激盪／探索紀錄
日期：2026-09-22 · 目標：聊天室裡的 AI 回覆從「等整段回完才一次顯示」改成逐字/逐段串流顯示
狀態：完成
背景來源：
- 現況：`chat-dispatch` 用 `EdgeRuntime.waitUntil()` 射後不理觸發 `agent-run`，前端從來不直接跟 `agent-run` 通訊；`agent-run` 呼叫供應商 API（非串流）拿到完整文字後才 `insert` 一則 `messages` 列，前端靠 Realtime 訂閱 `messages` 的 INSERT 事件才「看到」回覆。這個設計讓生成過程跟使用者是否還開著分頁脫鉤（使用者切走、@多個代理平行跑，都不受影響）
- 已經在跑、可以參考的既有模式：工作型代理的任務卡片（`worker_tasks`／`messages.metadata`）就是用「先 insert 一則訊息拿到 id，之後多次 update 同一則訊息」的方式呈現進度，前端 `useMessages.ts` 的 Realtime 訂閱已經同時監聽 INSERT 跟 UPDATE
- 初步技術方向（已經在對話中跟使用者討論過、使用者選 grill-me 前的鋪陳，不是訪談內的正式問答）：`agent-run` 先 insert 一則 `status="streaming"`、內容空白的訊息，收到供應商串流片段時節流 update `content`，最後一次 update 把 `status` 改成 `completed`；三家供應商（Anthropic/OpenAI/Google）都要補上串流呼叫與 SSE 解析邏輯，目前 `AIProvider.generate()` 只有非串流版本
- `agent-run` 現有流程：先跑 `classifyTaskOrQuestion()`（用非串流呼叫判斷這則訊息是「任務」還是「問題」，只有 Claude/Anthropic 這條路徑會做這個判斷），是「問題」才會走到最後產生一般聊天回覆的 `provider.generate()` 呼叫

## 使用者原話
「聊天室的 AI 回覆要改成串流輸出（逐字/逐段顯示），不要像現在這樣等供應商整個回完才一次顯示。」（延續自「這個專案在市場上缺乏什麼功能」的討論，使用者認可「透過 Realtime UPDATE 做準串流」這個推薦方向後選擇 grill-me）

## 摘要／重要決策
- **架構**：Realtime UPDATE 準串流——`agent-run` 先 insert 空白 `status="streaming"` 訊息，收串流片段時每 ~200ms 節流 update `content`，結束時補寫最後一次完整內容並把 `status` 改成 `completed`；前端 `useMessages.ts` 的 Realtime 訂閱要從只聽 INSERT 改成也聽 UPDATE（沿用既有任務卡片的模式）
- **供應商範圍**：Anthropic／OpenAI／Google 三家一次補齊，`AIProvider` 介面新增串流方法，三個 adapter 都要實作；每家的 SSE 格式要各自查證，不能互相套用
- **不變的部分**：Claude 的任務/問題分類呼叫維持現狀、維持非串流，只有確定是「問題」的那次生成呼叫才串流
- **失敗處理**：串流中斷保留已生成的部分內容，加一行「回覆中斷」提示，`status` 設成 `failed`
- **前端顯示**：直接用現有的 react-markdown 渲染累積內容，加閃爍光標／圓點表示還在生成，不另外寫簡化顯示邏輯

## 問答紀錄

### Q1：基礎架構確認
- 問題：(a) 走 Realtime UPDATE 準串流（先 insert 空白訊息、節流 update content）（建議） (b) 改用直接 SSE/fetch 串流（前端直接接供應商）
- 已記錄：使用者選 **(a) 確定走 Realtime UPDATE 準串流**。
- 影響：維持「使用者切走分頁、多代理同時回覆都不受影響」的既有設計，`agent-run` 跟前端 `useMessages.ts` 的修改範圍都在既有模式（任務卡片）延伸，不需要重新設計 `chat-dispatch` 觸發 `agent-run` 的機制。

### Q2：三家供應商的串流呼叫要一次補齊還是分批？
- 問題：(a) 一次全部補齊三家（建議） (b) 先只做 Claude（Anthropic），其他兩家之後再說
- 已記錄：使用者選 **(a) 一次全部補齊三家**。
- 影響：實作前要分別查證 Anthropic／OpenAI／Google 三家目前各自的串流 API 規格（SSE event 格式、`stream: true` 或對應參數的確切欄位名稱），不能只查一家就套用到其他兩家；`AIProvider` 介面要新增一個串流版本的方法（例如 `generateStream()`），三個 provider adapter（`anthropic.ts`／`openai.ts`／`google.ts`）都要實作。

### Q3：節流 update 的頻率
- 問題：(a) 時間節流：每 ~200ms 最多寫一次（建議） (b) 字數節流：累積夠 ~30-40 字才寫一次
- 已記錄：使用者選 **(a) 時間節流，每 ~200ms 最多寫一次**。
- 影響：`agent-run` 收串流片段時用一個計時器／時間戳記判斷「距離上次 update 超過 200ms 才真的寫資料庫」，中間收到的片段先累積在記憶體變數裡；串流結束時不管節流時間到了沒，一定要補寫最後一次完整內容（避免最後一小段卡在節流視窗內沒寫進去）。

### Q4：任務／問題分類呼叫跟串流的順序
- 問題：(a) 保留現狀，先分類再串流（建議） (b) 取消分類步驟，改成邊串流邊判斷
- 已記錄：使用者選 **(a) 保留現狀，先分類再串流**。
- 影響：範圍維持最小——分類呼叫（`classifyTaskOrQuestion`，只有 Claude/Anthropic 這條路徑會做）維持非串流、不變；只有確定是「問題」、真的要產生一般聊天回覆的那個 `provider.generate()` 呼叫才改成串流版本。使用者點名 Claude 後還是會有一小段空等（分類呼叫的時間，通常很短），這是已經確認接受的取捨。

### Q5：串流中斷時，已顯示的部分內容怎麼處理？
- 問題：(a) 保留已生成的部分，後面加一行「回覆中斷」提示（建議） (b) 中斷就整則訊息改成錯誤提示，不保留部分內容
- 已記錄：使用者選 **(a) 保留已生成的部分，後面加一行「回覆中斷」提示**。
- 影響：`agent-run` 串流迴圈外面要包 try/catch，中斷時把目前累積的內容 + 一行「（回覆中斷，請稍後重試或重新發問）」一起 update 進去，`status` 設成 `failed`（沿用既有的 `MessageStatus` 列舉），不要整則清空重寫；`agent_runs` 的失敗記錄／`friendlyProviderError` 錯誤分類邏輯維持不變，只是這次「失敗」不再是訊息完全空白，而是帶著部分內容。

### Q6：串流過程中前端要怎麼顯示部分內容？
- 問題：(a) 直接用 react-markdown 渲染目前累積的內容，加閃爍光標／圓點表示還在生成（建議） (b) 串流過程先顯示純文字，完成後才切換成 markdown 渲染
- 已記錄：使用者選 **(a) 直接用 react-markdown 渲染，加閃爍光標**。
- 影響：`MessageBubble.tsx` 現有的 react-markdown 渲染邏輯不用重寫，`status === "streaming"` 時在內容後面附加一個會閃爍的游標／圓點元素（純 CSS animation，不需要額外套件）；不用另外寫一套「串流專用」的簡化顯示邏輯，實作範圍變小。

## 待釐清事項
（無，訪談完成；以下是實作時直接依既有慣例決定、不需要另外問使用者的細節）
- `usage_json`／`usage_daily` 的用量統計：三家供應商的串流回應通常只在最後一個事件才帶完整用量數字，串流過程中不逐段累計，等串流結束拿到最終用量再一次寫入，跟現有非串流的寫入時機一致
- 現有 `useAgentRunStatus` 的「○○回覆中…」提示：串流訊息本身出現後這個提示會跟串流游標同時存在一小段時間（`agent_runs.status` 整個串流期間都是 `running`），屬於可接受的小重複，不特別處理
- 三家供應商各自的 SSE 事件格式，實作前依這個專案的一貫紀律查證目前規格，不憑印象猜（`api.anthropic.com`／`api.openai.com`／`generativelanguage.googleapis.com` 這類網域在這個 Claude Code session 可能被網路政策擋住，查證備援走官方 SDK 原始碼或既有程式碼模式推斷）
