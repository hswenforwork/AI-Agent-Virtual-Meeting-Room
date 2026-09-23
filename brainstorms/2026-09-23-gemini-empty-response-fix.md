# 修正：@Gemini 一律顯示「（沒有回應內容）」或「（回覆中斷）」
日期：2026-09-23 · 目標：修正使用者回報「@Gemini 請它自我介紹，都顯示沒有回應內容/回覆中斷」
狀態：完成（best-effort，無法直接連線使用者的 Gemini key 實測，見下方限制）

## 問題

使用者點名 `@Gemini` 請它自我介紹（單純測試 API key 有沒有串接成功），得到的回覆內容
一律是 `（沒有回應內容）`（`agent-run/index.ts` 的 `finalText` 兜底文字，代表串流結束時
`accumulatedText` 是空字串、也沒有 loop-in）或 `（回覆中斷，請稍後重試或重新發問）`
（`generateStream()` 丟出例外）。

## 已知線索

- `save-api-key` 存金鑰前會先用**非串流**的 `generate()`（`maxOutputTokens: 16`、
  極短且極度限制格式的測試 prompt「只需要回覆『測試成功』四個字」）測試一次金鑰，
  成功才會真的把金鑰存進 Vault。使用者既然能點名 `@Gemini`（`MessageComposer` 會擋掉
  沒設定金鑰的供應商），代表這次測試呼叫當初一定成功過——問題不在金鑰本身無效，而是
  **只有真正聊天這條路徑**（會先跑 `classifyMessage()`，接著用**串流**版本的
  `generateStream()` 產生看得到的回覆）會出問題。
- 直接從這個環境對 Gemini API 端點發一次帶假金鑰的請求，能正常收到 Google 的
  `API_KEY_INVALID` 錯誤（400），證實端點本身可從這個網路環境連得到，不是網路層完全
  不通（只是沒有使用者真正的金鑰，沒辦法用來重現真正的串流回應內容）。

## 找到並修正的兩個高機率成因

### 1. Gemini「-flash」系列模型預設會啟用思考（thinking），思考的 token 跟輸出算同一包額度
較新一代的 Gemini（包含這個專案預設用的 `gemini-3.8-flash`，延續 2.5 世代 Flash 模型的
已知行為）預設會啟用內部思考，而思考消耗的 token **算在同一個 `maxOutputTokens` 額度裡**。
「自我介紹」這種開放式提問比起金鑰測試那句「只回覆四個字」的高度限制指令，容易讓模型
多花不少 token 在思考上——如果思考就把 600（分類呼叫）或 1024（真正回覆）的額度整個
用完，`finishReason` 會是 `MAX_TOKENS`，完全沒有剩餘額度留給看得到的文字，回應內容
就會是空的。這可以解釋「短指令的金鑰測試會成功，但開放式的自我介紹卻一直失敗」這個
落差。

**修正**：`providers/google.ts` 新增 `buildGeminiGenerationConfig()`，模型名稱包含
「flash」時附上 `thinkingConfig: { thinkingBudget: 0 }` 關閉思考——這個專案目前對
Anthropic／OpenAI 也都沒有主動要求延伸思考，這裡讓 Gemini 行為跟另外兩家一致，額度
全部留給看得到的回覆內容。`-pro` 系列的思考沒辦法完全關閉（設 0 會被拒絕），所以只
針對名稱包含「flash」的模型套用；沒有其他 flash/lite 以外的型號會被誤觸。

### 2. SSE 解析器（`_shared/sse.ts`）沒有處理「連線結束前最後一個事件沒有補上結尾空行」的情況
共用的 `readSseStream()` 只在 buffer 裡找到 `"\n\n"`（事件之間的空行）時才會把累積的
`data:` 內容送給呼叫端；如果供應商把整段（或最後一段）回覆內容放進**沒有補上結尾空行
就直接斷線**的最後一個 frame，這段內容會一直卡在 buffer 裡，直到連線關閉、函式回傳，
從頭到尾都沒有被送出去——外部看起來就是「完全沒有任何內容」，即使 API 本身確實有回傳
文字。

**修正**：讀取迴圈結束後（連線關閉、不會再有新資料）多補一次處理，把 buffer 裡剩餘、
還沒送出的內容當作最後一個事件處理掉，不會再被吃掉。同時把 CRLF（`\r\n\r\n`）正規化成
LF（`\n\n`）再比對分隔符，避免某些供應商用 CRLF 分隔事件時，逐字比對 `"\n\n"` 永遠
找不到而卡住。這兩個修正都套用在共用的 SSE 解析器，Anthropic／OpenAI 也會受惠（對它們
目前運作正常的串流沒有影響，純粹是額外處理原本會被吃掉的邊界情況）。

### 順便補上的診斷 log
`google.ts` 的 `generate()`／`generateStream()` 現在只要回應完全沒有文字、也沒有呼叫
工具，就會把 `finishReason`／`safetyRatings` 印進 log——如果上面兩個修正還是沒有完全
解決問題，之後從 Supabase Dashboard 的 Edge Functions → `agent-run` → Logs 就能直接
看到真正的原因（額度被思考吃光、被安全機制擋下、還是其他狀況），不用再憑空猜測。

## 限制／後續

這個環境沒有使用者的 Gemini API key，也連不到使用者實際的 Supabase 專案（無法查看
Edge Function 執行紀錄），沒辦法直接重現、實測驗證。以上是根據程式碼走查、Gemini
官方文件已知行為，以及對照「金鑰測試呼叫成功、真正聊天呼叫失敗」這個落差所做的
best-effort 修正。部署後如果 `@Gemini` 還是有問題，麻煩：
1. 到 Supabase Dashboard → Edge Functions → `agent-run` → Logs，找「Gemini 回應沒有
   任何文字內容」這行 log，把 `finishReason` 的值告訴我（新增的診斷 log 就是為了這個）。
2. 或者直接把當時的錯誤訊息／log 貼給我，會比繼續憑空猜測有效很多。
