# 修正：工作型代理委派 Gemini 失敗、輸出檔案宣稱跟實際不符
日期：2026-09-23 · 目標：修正使用者回報「AI沒辦法正確呼叫其他AI執行工作」「呼叫其他代理得到的答案沒有真的放進記事本內」
狀態：完成（部分是 best-effort，見下方限制；記事本/待辦真正的寫回能力是未解決的架構缺口，見下方）

## 使用者回報的原始現象

1. 請 Claude（一般聊天）「指派其他代理計算 123*5，並記錄在記事本內」→ 任務卡片顯示
   「已委派計算代理處理任務」，但算出的答案是「1×2×3×5 = 30」（完全誤解了 123*5 這個算式）。
2. 改成明確 `@Gemini`（工作型代理裡卡住時會呼叫的 `consult_other_ai` 工具）→ 摘要說
   「嘗試呼叫 Gemini 代理協助計算時發生連線錯誤，已依系統指示自行判斷完成計算」，
   代理自己算出正確答案（615）後接手完成。
3. 兩次摘要都宣稱「已將結果...記錄到記事本中」「輸出檔案為 /mnt/session/outputs/記事本.md」，
   但記事本分頁跟檔案夾都完全沒有這則資料/檔案。

## 根因拆解（這其實是三個各自獨立的問題疊在一起）

### 問題 1：`consult_other_ai` 呼叫 Gemini 失敗
`_shared/providers/gemini.ts` 的 `consultGemini()` 是一份完全獨立、手刻的 `fetch()`
呼叫（非串流的 `generateContent`），跟聊天室主要使用、這次稍早已經修過的
`_shared/providers/google.ts`（`brainstorms/2026-09-23-gemini-empty-response-fix.md`）
完全沒有共用任何邏輯。也就是說，那次「-flash 模型思考吃光額度」的修正只套用在
一般聊天／分類呼叫，`consult_other_ai` 這條路徑完全沒有受惠，繼續帶著同樣的隱患。

**修正**：把 `consultGemini()` 改成直接呼叫 `createGoogleProvider(apiKey).generate()`，
不再維護第二份重複邏輯——兩邊（包含之後任何修正）自動保持一致。

### 問題 2：摘要宣稱寫了檔案，但檔案夾完全沒有
`finalizeTask()` 的 `summary` 是沙盒裡的模型自己寫的最後一則 `SUMMARY:` 訊息，程式碼
從頭到尾沒有拿它跟 `filesToArtifacts()`（真的去 Managed Agents 的 Files API 查詢、
下載、上傳進 Supabase Storage、登記進 `files` 表）比對過——模型說有寫檔案，不代表
`/mnt/session/outputs/` 底下真的有這個檔案，也不代表上傳/登記真的成功（沙盒模型看不到
這整條後續的上傳流程，它只知道自己「打算」寫了什麼、然後直接樂觀narrating成功）。

**修正**：`finalizeTask()` 在 `outputs.length === 0` 但摘要文字看起來提到了輸出檔案
（關鍵字比對 `/mnt/session/outputs/`／「輸出檔案」／「產出檔案」）時，明確在摘要後面
補一句提醒使用者「檔案夾裡找不到、可能沒有真的寫入或上傳成功」，不讓使用者誤信一段
沒有實際對照證據的宣稱。這是**偵測與誠實揭露**，不是真正解決「為什麼檔案沒寫進去」
——沙盒模型本身有沒有確實呼叫寫檔工具、或上傳/登記那幾步是否真的失敗，這個環境沒有
使用者的 Managed Agents session 紀錄可以查，無法進一步根因分析。

### 問題 3：「記錄在記事本內」講的是聊天室的真記事本，但工作型代理完全沒有這個能力
**這是最核心、也是使用者實際期待落空的原因**：工作型代理（Managed Agents 沙盒）
只有兩種工具——`agent_toolset_20260401`（沙盒檔案/bash 操作）跟自訂的 `consult_other_ai`
（求助另一位 AI）。它完全沒有任何管道能寫進這個 app 真正的 `notes`/`tasks` 資料表——
它的「記事本.md」只是沙盒裡的一個普通檔案，走 `filesToArtifacts()` 流程最多只會變成
「檔案夾」裡的一個檔案（假設上傳成功），跟聊天室右側真正的「記事本」分頁是完全不同的
兩個東西。模型不知道這個區別，被要求「記進記事本」時只能用它唯一有的能力（寫檔案）
模擬，然後自信地用使用者聽得懂的說法（「記事本」）描述它做的事，造成錯覺。

**目前的修正（部分緩解，非真正解法）**：更新工作型代理的 system prompt（
`_shared/managedAgents.ts` 的 `createManagedAgent()`），明確告知模型「沒有工具能寫進
聊天室的記事本/待辦事項，只能輸出檔案」，要求摘要誠實描述成「已輸出成檔案」而不是
「已寫進記事本」。**這個修正只對之後第一次使用工作型代理的新使用者生效**——每個使用者
的 Managed Agents agent 是第一次觸發時建立、之後重複使用的物件（`user_managed_agents`
表 + `getOrCreateUserManagedAgent()`），沒有機制會對已經建立過 agent 的既有使用者
（包含回報這個問題的使用者）套用新的 system prompt，除非之後手動或另外寫一個遷移
腳本呼叫 Managed Agents 的「更新 agent」API（`updateManagedAgentModel()` 目前只更新
`model` 欄位，可以擴充成也能更新 `system`，但這次沒有做，因為每次呼叫都會建立新版本，
需要謹慎設計什麼時候觸發，不屬於這次修正範圍）。

**真正解決「委派任務時要求記進記事本，最後真的出現在記事本分頁」需要新增一個結構性能力**：
讓工作型代理能像 `consult_other_ai` 一樣，呼叫一個新的自訂工具（例如
`write_to_notebook`／`write_to_tasks`），由這個工具在 Edge Function 端直接呼叫
`applyWorkspaceWrite()`（`workspaceWrite.ts`，跟一般聊天的 workspace_write 快速路徑
共用同一套邏輯）寫進真正的 `notes`/`tasks` 表。這是一個新功能，還沒有實作，需要先確認
設計方向（例如：要不要讓工作型代理自己判斷什麼時候該用這個工具、要不要跟一般聊天一樣
支援修改既有項目、寫入前要不要跟一般聊天一樣有「保守判斷、不確定就不要亂寫」的把關）。

## 限制

這個環境沒有使用者的 Gemini/Anthropic key，也連不到使用者實際的 Managed Agents session
紀錄或 Supabase 專案，問題 1、2 都是根據程式碼走查跟已知的失敗模式做的 best-effort 修正，
無法直接重現、實測驗證。
