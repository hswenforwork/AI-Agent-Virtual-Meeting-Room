import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY，請確認 .env 設定（參考 .env.example）。",
  );
}

export const supabase = createClient<Database>(url, anonKey);
