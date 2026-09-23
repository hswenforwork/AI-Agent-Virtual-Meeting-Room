# 修正：AI 新增記事本/待辦事項後畫面不會自動更新
日期：2026-09-23 · 目標：修正使用者回報「AI 新增記事本、待辦事項等內容時，不會自動更新頁面，要切到其他分頁再切回來才會出現」
狀態：完成

## 根因

兩個問題疊在一起：

1. **前端完全沒有 Realtime 訂閱**：`useNotes()`／`useTasks()`／`useFiles()`（`src/features/notes/useNotes.ts`
   等）只有單純的 `useQuery`，畫面初次載入抓一次資料，之後只有「使用者自己在這個分頁
   操作」的 mutation（新增/修改/刪除）成功後才會 `invalidateQueries` 重新整理。AI 透過
   `workspaceWrite.ts` 的 `applyWorkspaceWrite()`（用 service_role client 直接寫進資料庫）
   新增或修改記事本/待辦時，前端完全不知道發生了什麼事，畫面不會有任何反應——切到別的
   分頁再切回來能看到最新內容，是因為切回來時 React Query／元件重新掛載，重新跑了一次
   `queryFn`，不是「即時更新」在起作用，是巧合而不是設計。
   對照組：聊天訊息（`useMessages()`）早就有 `postgres_changes` 訂閱（監聽 INSERT/UPDATE），
   AI 的回覆能即時顯示；notes/tasks/files 這三個從來沒有補上同樣的機制。

2. **就算補了訂閱程式碼，notes/tasks/files 也沒有被加進 Supabase 的 Realtime publication**：
   `supabase_realtime` 這個 publication 預設是空的，`0006_enable_realtime.sql` 當初只加了
   `messages`／`agent_runs`（`0008_room_sidebar_history.sql` 後來補了 `rooms`），notes/
   tasks/files 從來沒有被加進去過。沒有這一步，即使前端訂閱了 `postgres_changes`，
   Supabase 也根本不會把任何事件廣播出來，訂閱等於沒接上——這是這次修正裡容易漏掉、
   但缺了就完全無效的一步。

## 修正

1. `useNotes()`／`useTasks()`／`useFiles()` 都補上 `postgres_changes` 訂閱，比照
   `useMessages()` 的模式：`filter` 用 `owner_id=eq.{目前登入的使用者 id}`（notes/
   tasks/files 都已經是 owner_id 歸屬，不分房間）。列表查詢有 join `rooms(name)`
   （顯示「來自：原本的房間名稱」小標籤），收到的 Realtime payload 沒有這個欄位、
   直接用會缺資料，索性收到任何事件就整批 `invalidateQueries` 重新 fetch，筆數通常
   不多，重新查詢的成本可以忽略，不需要為了省一次查詢自己另外拼欄位。
2. 新 migration `0017_workspace_realtime.sql`：把 `notes`／`tasks`／`files` 加進
   `supabase_realtime` publication，補上被遺漏的那一步。

## 已知取捨

- RLS 的 `owner_id = auth.uid()` select 政策本來就會套用在 Realtime 事件的收送上
  （Supabase Realtime 會照訂閱者自己的身分重新驗證 select 政策），AI 用 service_role
  寫入時帶的 `owner_id` 是真正的使用者 id，訂閱者收得到事件不需要額外調整 RLS。
- 檔案夾（files）比較特殊：使用者自己在這個分頁上傳/刪除一樣會透過既有的
  `invalidateQueries`（mutation onSuccess）立即反映，這次補的訂閱主要解決「工作型
  代理執行完成、把產出檔案登記進 files 表」這種前端看不到的寫入路徑；使用者回報的
  是記事本/待辦，但檔案夾是同一種結構性問題，一併修正。
