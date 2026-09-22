# 打包成部署用 Skill：腦力激盪／探索紀錄
日期：2026-09-22 · 目標：把「AI 協作室」從零到有的整個部署流程（Supabase 專案建立、DB migrations、Edge Functions、前端、GitHub Actions、Managed Agents 工作型代理設定）包成一個 Claude Skill，讓 AI 能自動帶著使用者——包含技術程度很低的使用者——從頭到尾把這個工具架設起來
狀態：完成
背景來源：
- `README.md`（目前的手動設定手冊，這次要轉成 skill 引導的內容基礎）
- `docs/MVP規劃-v2.md`、三份 `brainstorms/` 訪談紀錄（專案完整脈絡）
- `scripts/setup-managed-agent.sh`（工作型代理的一次性設定腳本）

## 使用者原話
「請你將我們這個專案所做的所有事，打包成一個SKILL，讓AI可以自動從頭到尾直接架設好這個工具，就算是一位小學生有可以透過這個SKILL完成工具部屬。」

## 摘要／重要決策
（隨訪談持續更新）

## 問答紀錄

### Q1：這個 Skill 執行完之後，應該產生什麼？
- 問題：(a) 複製這個專案本身（建議）——Skill 專門用來把「AI 協作室」這個特定專案完整複製一份、部署到使用者自己的 Supabase/GitHub/Anthropic 帳號下，功能跟現有專案一模一樣 (b) 通用模板，可以改名改用途 (c) 純技術文件／教材，不綁定這個產品本身
- 已記錄：使用者選 **(a) 複製這個專案本身**。
- 影響：Skill 的內容可以直接鎖定這個 repo 的實際檔案結構、migration 順序、Edge Function 清單來寫，不需要處理「使用者想要不同功能組合」的彈性設計，大幅簡化 Skill 的複雜度。後續問題（要不要保留原始碼庫的 git 歷史、要 fork 還是全新 repo）可以在這個前提下繼續問。

### Q2：新專案要怎麼產生在使用者自己的 GitHub 帳號下？
- 問題：(a) GitHub Fork（建議）——保留 git 歷史、之後可拉原專案更新，但頁面會標示 forked from (b) 全新 repo，不帶歷史——乾淨、可自由命名，但拉不到原專案更新
- 已記錄：使用者選 **(a) GitHub Fork**。
- 影響：Skill 的第一步驟可以用 GitHub 的 fork API/操作直接複製，不需要自己重建檔案清單；同時代表 repo 名稱預設會沿用 `AI-Agent-Virtual-Meeting-Room`（GitHub fork 預設同名，使用者可事後自己改名，但 Skill 不用特別處理改名邏輯）。

### Q3：對於必須人工操作的步驟，Skill 應該怎麼引導使用者？
- 問題：(a) 一次一步，做完才繼續（建議）——每次只給一個步驟的指令，等使用者回報完成或貼上結果才繼續下一步 (b) 一次列出所有清單，使用者自己排程完成
- 已記錄：使用者選 **(a) 一次一步，做完才繼續**。
- 影響：Skill 的行為模式要接近這整個專案訪談過程中實際採用的方式（例如給一段 SQL、等回報成功才繼續；給一個連結、等貼上 API key 才繼續）。這代表 Skill 內容不能只是一份靜態文件，而要寫成「互動流程腳本」——明確標出每個關卡是什麼、要等什麼樣的回覆才能判斷可以往下走、失敗時怎麼重試或求助。

### Q4：這個 Skill 要放在哪裡、別人怎麼拿到它來用？
- 問題：(a) 放進這個 repo 的 `.claude/skills/`（建議）——想部署的人先把 Claude Code 接到這個原始 repo（或已 fork 的副本），就能直接叫用 (b) 獨立打包成可攜檔案，不綁定這個 repo
- 已記錄：使用者選 **(a) 放進這個 repo 的 `.claude/skills/`**。
- 影響：Skill 檔案本身要作為這次工作的一部分 commit 進這個 repo（走一樣的 PR → merge 流程）。也代表使用流程確定是：使用者先把 Claude Code（web 或 CLI）接到 `hswenforwork/AI-Agent-Virtual-Meeting-Room` 這個原始 repo → 叫用 skill → skill 第一步驟就是 fork 出屬於使用者自己的副本 → 後續步驟都在使用者的副本上進行。

### Q5：「工作型代理」（Managed Agents）在 Skill 裡應該怎麼安排？
- 問題：(a) 列為選用的最後階段（建議）——基礎功能算部署完成，工作型代理可跳過 (b) 全部一起做完，不分階段
- 已記錄：使用者選 **(b) 全部一起做完，不分階段**——不採納建議選項。整個 Skill 從頭到尾是同一條連續流程，工作型代理（Managed Agents／CMA 設定、`MANAGED_AGENTS_AGENT_ID` 等 secrets）跟基礎聊天室功能一樣都是「部署完成」的必要條件，不當成可略過的附加項。
- 影響：Skill 流程設計上，「Anthropic API key 是否有 Managed Agents beta 權限」這一關（README 附加設定步驟 1）不能只是「有的話才做」的分岔，而要當成主線路徑的必經關卡。因此流程需要明確處理「使用者卡在這一關」的情況——例如查不到開通入口、申請中要等核准——這種等待時間不確定的關卡，Skill 要怎麼陪使用者度過（先做其他不依賴它的步驟、還是整個流程停在這裡等）還沒問，列入待釐清。

### Q6：卡在 Managed Agents beta 權限這關時，Skill 流程應該怎麼處理？
- 問題：(a) 先繼續完成其他不依賴它的步驟（建議）——基礎功能（Supabase、前端、聊天室）先全部做完，最後再回頭處理工作型代理，等核准下來再繼續 (b) 整個流程停在這裡等，確認有權限才繼續
- 已記錄：使用者選 **(a) 先繼續完成其他不依賴它的步驟**。
- 影響：Skill 的步驟順序要刻意把「Managed Agents beta 權限確認」這個最不確定、最可能卡住的關卡往後移——不是第一步就檢查，而是排在基礎部署（fork repo、Supabase 專案、migrations、secrets、Edge Functions、GitHub Pages）都完成、使用者已經能打開網站聊天之後，才進入工作型代理設定。這樣即使卡在 beta 審核，使用者也已經有一個「可以用」的聊天室，不會整個部署過程卡死。

### Q7：Skill 應該盡量用 API 自動化，還是統一手動點選單？
- 問題：(a) 能用 API 就用 API（建議）——GitHub 部分（fork、設 secrets、開 Pages）直接用 GitHub API；Supabase 部分如果使用者願意申請 Management API token，就用 API 建專案、跑 migration、設 secrets，真正無法 API 化的才要人工點選單 (b) 統一手動點選單，跟現在 README 一樣
- 已記錄：使用者選 **(a) 能用 API 就用 API**。
- 影響：這把 Skill 從「一份很詳細的操作手冊」升級成「實際會呼叫工具做事的自動化流程」，複雜度明顯提高，需要涵蓋：
  - GitHub：用既有 GitHub MCP 工具 fork repo、設定 repo secrets（`ALLOWED_ORIGINS` 等前端用的 Pages 環境變數、Actions 用的 `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF`）、確認/開啟 GitHub Pages 來源設定
  - Supabase：引導使用者申請 Management API personal access token（如果他們願意），用來自動建立專案、依序跑 7 個 migration 檔、設定 Edge Function secrets；使用者不想申請 token 的話，退回現有「貼 SQL 到 Dashboard」的手動流程當備援
  - 真正只能人工做的關卡（Supabase 帳號註冊本身、Anthropic/Gemini API key 申請、Managed Agents beta 開通、GitHub Pages 「Deploy from a branch → GitHub Actions」來源切換這種一次性帳號層級設定）維持人工，Skill 給清楚指引＋等待確認
  - 需要處理 Management API token 這種敏感憑證的取得、暫存與使用方式（不能寫進檔案或 commit，只在當次工具呼叫使用）

### Q8：所有步驟都做完之後，Skill 應該怎麼確認部署真的成功了？
- 問題：(a) AI 自己查 GitHub Actions 狀態 + 提醒使用者實際點進網站試試看（建議）——能自動查的自動查，最後一步才需要人實際操作 (b) 只把網址給使用者，讓他自己全部測試
- 已記錄：使用者選 **(a) AI 自己查 GitHub Actions 狀態 + 提醒使用者實際點進網站試試看**。
- 影響：Skill 收尾階段要用 GitHub API 確認 `check`／`deploy-pages`／`deploy-functions` 這幾個 workflow 都跑綠了才跟使用者說「完成」；如果紅燈，要先自己嘗試判斷失敗原因（讀 log）再引導使用者，而不是直接丟一個壞掉的網址給他測試。最後一定還是要請使用者親自打開網站、註冊/訪客登入、發一則訊息，確認整個體驗（AI 沒辦法用瀏覽器操作他的帳號）。

### Q9（收尾補充）：對 Q7「能用 API 就用 API」的加強
- 問題：訪談收尾時問「還有什麼沒談到？」
- 已記錄：使用者主動補充——**「我要該 SKILL 可以達到最大自動化部屬，除了部分真的必須人工作業，人工作業要極簡化。」**
- 影響：這是對 Q7 的加強定調，不是新方向，把「能用 API 就用 API」推到更明確的上限：
  1. **Supabase Management API 不再只是「使用者願意才用」的選用路線**，Skill 應該把它當成預設推薦路徑主動引導使用者申請 token（而不是被動等使用者自己選），只有使用者明確不想給 token 時才退回手動貼 SQL。
  2. **真正無法自動化的人工步驟，要盡量合併、簡化成最少次數、最少認知負擔的動作**——例如同一個人工步驟裡需要的多筆資訊（帳號註冊網址、要點的按鈕、要複製貼上的欄位）一次講清楚，不要拆成好幾輪來回；能用「貼上一個值」取代「跑去某頁面點五下」的，優先設計成貼上一個值。
  3. 這跟 Q3「一次一步、做完才繼續」不衝突：一次一步是指「進度上不要一口氣丟一堆步驟」，這裡是指「每一步本身的操作量要壓到最低」，兩者是不同維度，都要顧到。

## 摘要／重要決策（訪談收尾整理）

1. **產出物**：Skill 專門用來把「AI 協作室」這個特定專案完整複製、部署到使用者自己的帳號下，不是通用模板（Q1）。
2. **Repo 建立**：用 GitHub Fork（Q2）。
3. **互動節奏**：一次一步，做完才繼續下一步（Q3），但每一步本身的操作量要壓到最低（Q9）。
4. **發布位置**：Skill 放進這個 repo 的 `.claude/skills/`，使用者先把 Claude Code 接到原始 repo 才能叫用（Q4）。
5. **範圍**：工作型代理（Managed Agents）跟基礎聊天室功能一起做完，不分階段、不當成選用附加項（Q5）；但流程順序上，Managed Agents beta 權限這個最不確定的關卡要排在基礎部署完成之後，卡關不影響使用者已經有一個能用的聊天室（Q6）。
6. **自動化程度**：能用 API 就用 API——GitHub 全部走 API；Supabase 預設主動引導申請 Management API token 來自動化建專案/跑 migration/設 secrets，使用者不給 token 才退回手動貼 SQL；真正必須人工的步驟（帳號註冊、API key 申請、beta 開通、Pages 來源切換視情況）要合併、簡化到最少次數（Q7、Q9）。
7. **驗收**：Skill 自己用 GitHub API 查 workflow 是否跑綠，紅燈自己先嘗試判斷原因；最後一定還是要請使用者親自打開網站、登入、發訊息確認體驗（AI 沒有瀏覽器操作使用者帳號的能力）（Q8）。

### Q10（收尾追問的兩個小問題）
- 問題 1：使用者不願意提供 Supabase Management API token 時，要不要重新設計一套更簡化的手動備援流程？
  已記錄：**不要**。使用者原話：「我要全自動。」→ Skill 以 Management API token 為唯一主線路徑，不額外投入設計平行的簡化手動備援；README 既有的手動貼 SQL 流程維持原樣、不動它，Skill 不基於它重新設計。
- 問題 2：GitHub Pages 來源設定能不能也用 API 切換？
  已記錄：**所有能用 API 的都要用 API**，以減少人工操作為最高原則。→ 實作時要查證 GitHub API 是否支援直接切換 Pages build_type（`workflow` vs `legacy`），能用就用，不要求人工進 Settings 頁面點。
- 影響：這兩題都是把 Q7/Q9「能用 API 就用 API、人工步驟極簡化」的原則講得更絕對——Skill 設計上不要為了「照顧不給 token 的使用者」而分心去做兩套流程，全力把自動化路徑做好、做對。

## 待釐清事項
（無，訪談完成）
