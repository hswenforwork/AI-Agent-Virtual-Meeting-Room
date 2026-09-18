import { createClient } from "npm:@supabase/supabase-js@2";

// service_role client：只在 Edge Function（後端）使用，絕不可暴露給前端。
export function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase service role 環境變數未設定");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 以呼叫端帶來的 JWT 建立 client，用來驗證使用者身分與房間權限（走 RLS）。
export function supabaseAsUser(authHeader: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("Supabase anon 環境變數未設定");
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
