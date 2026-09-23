-- 記事本／待辦事項／檔案夾 Realtime：對應 brainstorms/2026-09-23-workspace-realtime-refresh.md
--
-- 使用者回報：AI 新增記事本/待辦事項時畫面不會自動更新，要切到別的分頁再切回來才看得到。
-- 前端 useNotes()/useTasks()/useFiles() 這次補上了 postgres_changes 訂閱（比照
-- useMessages() 的做法），但 Supabase 預設不會把任何表加進 supabase_realtime
-- publication——notes/tasks/files 從來沒有被加進去過（跟 0006_enable_realtime.sql
-- 當初只加了 messages/agent_runs 是同一種遺漏），沒有這段話，前端訂閱了也永遠收不到
-- 任何事件，光補訂閱程式碼是不夠的。

alter publication supabase_realtime add table public.notes;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.files;
