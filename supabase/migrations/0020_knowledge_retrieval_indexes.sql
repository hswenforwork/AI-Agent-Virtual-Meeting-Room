-- 17 項修正計劃 B 階段、項目 13：知識檢索不能只在「最近更新的 30 筆」裡找關鍵字。
-- 原本 buildKnowledgeContext() 先撈 owner 名下最近更新的 30 筆知識/決策當候選池，
-- 才在 Edge Function 裡用關鍵字重疊比對——帳號用久了，任何超過這 30 筆範圍、但其實
-- 跟這次對話相關的舊知識，永遠不會被檢索到（見 supabase/functions/_shared/
-- knowledgeContext.ts 這次的修正，改成用 ILIKE 直接查整個帳號範圍）。
--
-- 這裡加 pg_trgm 的 GIN 索引，讓 title/body（knowledge_items）與 title/decision_text
-- （decisions）的 `ILIKE '%關鍵字%'` 查詢可以用索引、不用整表循序掃描——這是「全文檢索
-- 或等效的可索引候選策略」裡的「等效」那個選項：中文內容用 PostgreSQL 內建的全文檢索
-- （to_tsvector）沒有斷詞字典（zhparser/pg_jieba 不在 Supabase 預設可用的延伸套件），
-- trigram 索引不需要斷詞、天然支援子字串比對，跟現有 Edge Function 裡「標題/內容包含
-- 這個詞」的比對邏輯語意一致，只是把「掃全表」換成「用索引查」。

create extension if not exists pg_trgm;

create index if not exists knowledge_items_title_trgm_idx
  on public.knowledge_items using gin (title gin_trgm_ops);
create index if not exists knowledge_items_body_trgm_idx
  on public.knowledge_items using gin (body gin_trgm_ops);

create index if not exists decisions_title_trgm_idx
  on public.decisions using gin (title gin_trgm_ops);
create index if not exists decisions_text_trgm_idx
  on public.decisions using gin (decision_text gin_trgm_ops);
