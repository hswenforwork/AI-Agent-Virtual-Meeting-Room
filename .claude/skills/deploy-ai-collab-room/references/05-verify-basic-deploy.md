# 階段 5：確認基礎功能部署成功

## 目標
不要憑感覺說「應該部署好了」——實際查 GitHub Actions 的執行結果，紅燈自己先嘗試看懂原因，最後才請使用者實際打開網站操作一次（這步是 AI 唯一真的做不到的事：沒有瀏覽器可以幫使用者登入）。

## 查 Actions 狀態

用 `mcp__github__actions_list`（method: `list_workflow_runs`）分別查 `check`、`deploy-pages`、`deploy-functions` 三個 workflow 最新一次執行的狀態。

- 還在跑（`in_progress`／`queued`）：等一下再查，不要每幾秒就查一次，抓合理的間隔（例如每 20-30 秒查一次），跑完自然會有結果，不用一直催。
- 全部成功（`success`）：進下一步。
- 有失敗：用 `mcp__github__actions_get`（method: `get_workflow_run_logs_url` 或 `get_workflow_job`）拉失敗的 log，自己先讀一次，看是不是能對上 `references/troubleshooting.md` 列的已知狀況（例如 Variables/Secrets 名稱打錯、Pages 來源沒設對）；能自己修就直接修正重跑，修不了才把具體錯誤訊息（翻譯成白話）告訴使用者，而不是整包技術 log 丟過去。

## 請使用者實際測試（唯一必要的人工確認）

三個 workflow 都綠燈之後，跟使用者說：

> 網站已經部署好了：`<pages_url>`。麻煩你實際打開來看看——
> 1. 點「以訪客身分繼續」（或註冊帳號）
> 2. 應該會自動建立一間「我的協作室」
> 3. 在聊天室隨便發一則訊息，等 Claude 回覆
>
> 都正常的話跟我說一聲「可以了」，我們再繼續設定工作型代理（讓 AI 能自己動手寫程式、修檔案的進階功能）。如果哪一步怪怪的，把畫面上看到的訊息告訴我，我來看。

**這一步一定要等使用者實際回報，不要自己假設沒問題就往下走。** 如果使用者回報異常，先查 `references/troubleshooting.md` 有沒有對得上的已知狀況；查不到才展開一般除錯（跟這個專案過去除錯時一樣的做法：查證，不要瞎猜）。

## 完成判斷
使用者明確回報基礎功能（登入、建房間、發訊息、收到回覆）正常。

接著進入 `references/06-managed-agents.md`。
