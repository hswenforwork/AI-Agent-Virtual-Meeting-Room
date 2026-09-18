import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY，請確認 .env 設定（參考 .env.example）。",
  );
}

// 不帶 Database 泛型：手寫的表格型別（見 src/types/database.ts）只用來標註應用程式碼裡的
// row 形狀，不接進 supabase-js 的查詢建構器泛型，避免手寫型別跟實際 schema 有落差時
// 靜默退化成 `never` 掩蓋掉真正的型別錯誤。之後接上真實專案後可用
// `supabase gen types typescript` 產生正式型別再接回這裡。
export const supabase = createClient(url, anonKey);
