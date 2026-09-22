# 階段 7：最終驗收與交付

## 目標
確認整個系統（含工作型代理，如果 Phase 6 有完成）真的堪用，交給使用者一份清楚的總結。

## 最終檢查

1. 再查一次三個 GitHub Actions（`check`／`deploy-pages`／`deploy-functions`）都是最新一次成功。
2. 如果 Phase 6 完成了 Managed Agents 設定，請使用者做最後一次實測：

   > 麻煩在聊天室發一句明顯是「任務」的話，例如「幫我在 README 加一行測試用的說明文字」。應該會跳出一張任務卡片、有「開始執行」按鈕，按下去過一陣子狀態會變成「已完成」。跟我說結果如何。

   如果卡在「執行中」不動或按鈕沒反應，先查 `references/troubleshooting.md`。
3. 如果 Phase 6 因為 beta 權限卡住沒完成，這裡不用再測，跳到總結，如實告知這部分還沒完成。

## 交付總結（範例，依實際完成狀況調整）

> 🎉 部署完成！這是你自己的一份「AI 協作室」：
>
> - 網站：`<pages_url>`
> - GitHub 專案：`https://github.com/<target_owner>/<target_repo>`
> - Supabase 專案：`<project_url>`（管理後台在 supabase.com/dashboard）
>
> 已經可以用的功能：聊天室（Claude）、記事本、待辦事項、檔案夾{{、工作型代理（任務卡片）——視 Phase 6 是否完成}}。
>
> 還沒設定的部分：{{GPT／Gemini 純聊天功能要另外申請對應的 API key 才會啟用；工作型代理如果卡在 Managed Agents beta 權限，等申請到權限再跟我說一聲，我可以接著做完}}。
>
> 之後想再改這個專案（例如加功能、換設計），直接在這個對話裡跟我說就可以，不需要重新跑一次這個部署流程。

## 完成判斷
使用者收到清楚的總結，知道網站在哪裡、什麼能用、什麼還沒設定。到這裡整個 Skill 結束。
