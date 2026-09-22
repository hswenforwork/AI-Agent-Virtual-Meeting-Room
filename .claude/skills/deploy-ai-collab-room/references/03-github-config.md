# 階段 3：設定 GitHub repo（Variables／Secrets／Pages）

## 目標
把 Phase 2 拿到的 `project_url`／`anon_key` 寫進 fork 出來的 repo，開啟 GitHub Pages，讓 `deploy-pages.yml` 能跑起來。

## 要設定的東西

| 名稱 | 種類 | 值 | 用途 |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Variable（不是 Secret） | `project_url` | 前端建置用，會被打包進公開的 JS，本來就不是機密（安全性靠資料庫的 RLS，不靠藏這個網址） |
| `VITE_SUPABASE_ANON_KEY` | Variable（不是 Secret） | `anon_key` | 同上 |
| `SUPABASE_ACCESS_TOKEN` | Secret | 一組新的 Supabase Personal Access Token（可以沿用 Phase 2 的 Management API token，也可以另外申請一組專門給 Actions 用） | 讓 `deploy-functions.yml` 能部署 Edge Function |
| `SUPABASE_PROJECT_REF` | Secret | `project_ref` | 同上 |

（`VITE_APP_BASE_PATH` 不用手動設，`deploy-pages.yml` 會自動用 repo 名稱算出來。）

## 怎麼設定：三種方式依序嘗試

**方式一：`gh` CLI（如果目前環境裝了、也登入了）**

```bash
gh variable set VITE_SUPABASE_URL --repo "<target_owner>/<target_repo>" --body "<project_url>"
gh variable set VITE_SUPABASE_ANON_KEY --repo "<target_owner>/<target_repo>" --body "<anon_key>"
gh secret set SUPABASE_ACCESS_TOKEN --repo "<target_owner>/<target_repo>" --body "<token>"
gh secret set SUPABASE_PROJECT_REF --repo "<target_owner>/<target_repo>" --body "<project_ref>"
```

`gh` 會自動處理 Secrets 需要的加密，不用自己動手。先用 `gh auth status` 確認有登入、`--repo` 有沒有寫對權限。

**方式二：GitHub REST API（如果 Bash 環境有可用的 GitHub token，但沒有 `gh`）**

- Variables 是明文 API，直接 `POST /repos/{owner}/{repo}/actions/variables`，body `{"name": "...", "value": "..."}`。
- Secrets 需要先 `GET /repos/{owner}/{repo}/actions/secrets/public-key` 拿到 `key_id` 和 `key`（base64），用 libsodium 的 sealed box 把值加密後 base64，再 `PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}`，body `{"encrypted_value": "...", "key_id": "..."}`。Node 環境可以用 `tweetnacl` 或 `libsodium-wrappers`；Python 環境用 `PyNaCl` 的 `SealedBox`。⚠️ 執行前用 WebFetch 核對 `https://docs.github.com/en/rest/actions/secrets` 目前的確切用法。

**方式三：兩者都不可用時（例如目前這個作者撰寫時的環境——只有 GitHub MCP 工具、沒有 `gh` CLI、沒有原始 API 存取）**

老實跟使用者說這一步目前這個環境沒辦法完全自動，但**把四個值一次講清楚**，讓使用者一趟做完：

> 這四個值麻煩你去 GitHub 貼一下（我目前的環境沒辦法直接幫你填，抱歉）：打開 `https://github.com/<target_owner>/<target_repo>/settings/secrets/actions`，
> - 上面 **Variables** 分頁新增兩個：`VITE_SUPABASE_URL` = `<project_url>`、`VITE_SUPABASE_ANON_KEY` = `<anon_key>`
> - 上面 **Secrets** 分頁新增兩個：`SUPABASE_ACCESS_TOKEN` = `<token>`、`SUPABASE_PROJECT_REF` = `<project_ref>`
>
> 四個都貼好之後跟我說一聲。

## 開啟 GitHub Pages（Source 設為 GitHub Actions）

先試 API：`POST /repos/{owner}/{repo}/pages`，body 帶 `{"build_type": "workflow"}`（⚠️ 執行前用 WebFetch 核對 `https://docs.github.com/en/rest/pages/pages` 目前欄位名稱是否還是這個）。這個 repo 目前用的 GitHub MCP 工具清單裡沒有直接對應的 Pages 設定工具，所以這步通常要靠方式二（原始 API）或 `gh api` 才能做，方式一的 `gh` CLI 沒有專門子指令，可以用 `gh api repos/{owner}/{repo}/pages -X POST -f build_type=workflow`。

三種方式都不可行的話，退回人工，但只問這一個動作：

> 麻煩到 `https://github.com/<target_owner>/<target_repo>/settings/pages`，Source 選成 **GitHub Actions**，存檔後跟我說一聲。

## 觸發部署

Variables/Secrets/Pages 都設定好之後，用 `mcp__github__actions_run_trigger`（method: `run_workflow`）分別觸發：
- `check.yml`
- `deploy-pages.yml`
- `deploy-functions.yml`（這個要等 Phase 4 的 Edge Function secrets 也設定好，Function 才有辦法正常運作，但先部署上去不會壞——沒有 `ANTHROPIC_API_KEY` 之前，代理只會回覆「尚未設定」，不影響其他功能）

## 完成判斷
四個 Variables/Secrets 都查得到（GitHub API 可以確認「有沒有這個名字」但看不到 Secret 值本身，這是正常的）、Pages 設定為 `workflow` 來源、三個 workflow 都被觸發。

## 跟使用者說的話（範例）
> GitHub 這邊也設定好了，我剛觸發了自動部署。接下來要設定後端用的金鑰（讓 AI 真的能回覆訊息），這步需要你去申請一把 Anthropic 的 API key。

接著進入 `references/04-edge-function-secrets.md`。
