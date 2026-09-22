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

export function jsonError(message: string, status = 400, code = "bad_request") {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
