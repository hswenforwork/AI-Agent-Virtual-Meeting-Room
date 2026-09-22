# 階段 1：Fork 專案到使用者帳號

## 目標
在使用者自己的 GitHub 帳號下，建立一份這個專案的 fork，之後所有部署動作都在這份 fork 上進行。

## 步驟

1. 呼叫 `mcp__github__get_me` 確認目前 GitHub 工具是連到哪個帳號（這就是待會的 fork 目的地）。跟使用者確認一句：「確認要 fork 到 `<username>` 這個帳號下嗎？」不需要每次都問，除非帳號名稱看起來不像使用者本人（例如組織帳號），才特別確認一下。

2. 判斷來源 repo：
   - 如果目前工作目錄是這個 repo 的 git checkout，用 `git remote get-url origin` 取得目前的 owner/repo。
   - 如果偵測不到，預設用 `hswenforwork/AI-Agent-Virtual-Meeting-Room`（這個 Skill 的原始出處，確保永遠 fork 自正確版本，避免 fork 鏈越拉越長、追不到最新修復）。

3. 呼叫 `mcp__github__fork_repository`，`owner`/`repo` 填來源 repo。

4. Fork 建立後可能要幾秒鐘才會真的可用。用 `mcp__github__get_file_contents` 讀 fork 後 repo 的 `README.md`（或任何檔案）當作健康檢查，讀不到就等幾秒重試，最多重試 5 次。

5. 記下這次部署會一直用到的三個值，之後每個階段都要用：
   - `target_owner`＝使用者的 GitHub 帳號
   - `target_repo`＝fork 出來的 repo 名稱（預設跟來源同名）
   - `pages_url`＝`https://<target_owner>.github.io/<target_repo>/`（等一下 Phase 3 會需要，也是最終網站網址）

## 完成判斷
能用 GitHub API 讀到 `target_owner/target_repo` 底下的檔案，就算這階段完成。

## 跟使用者說的話（範例）
> 已經把專案複製到你的帳號下了：`https://github.com/<target_owner>/<target_repo>`。接下來要幫你建立資料庫（Supabase），這步大部分我可以自己做，但需要你先去申請一把權限比較高的金鑰讓我能操作——這是整個過程中第一個需要你動手的地方。

接著進入 `references/02-supabase-project.md`。
