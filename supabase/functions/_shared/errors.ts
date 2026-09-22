// 對應 docs/MVP規劃-v2.md 與原始規劃文件第 14 章：錯誤一律轉成繁體中文摘要，
// 技術細節只留在後端日誌（console.error），不回傳給前端。

export type FriendlyError = {
  code: string;
  message: string;
};

export function friendlyProviderError(status: number): FriendlyError {
  if (status === 401 || status === 403) {
    return { code: "provider_auth_failed", message: "AI 供應商金鑰設定有誤，請聯絡管理員。" };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "已達 API 速率或額度上限，請稍後重試。" };
  }
  if (status >= 500) {
    return { code: "provider_unavailable", message: "AI 供應商暫時無法回應，請稍後重試。" };
  }
  return { code: "provider_error", message: "AI 供應商回傳錯誤，請稍後重試。" };
}

// extraHeaders 一定要帶進呼叫端已經算好的 CORS headers（含 Access-Control-Allow-Origin）——
// 少了這個，瀏覽器會把這個回應當成 CORS 失敗直接擋掉，前端的 fetch 連狀態碼、body 都讀不到，
// supabase-js 只會回傳一個內容是網路層錯誤的 FunctionsFetchError，看不到這裡寫的訊息本身。
export function jsonError(
  message: string,
  status = 400,
  code = "bad_request",
  extraHeaders: HeadersInit = {},
) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
