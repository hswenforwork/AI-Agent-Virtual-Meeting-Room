// 極簡 Gemini 呼叫：只給「工作型代理卡住時，透過 consult_other_ai 自訂工具求助」這個情境用，
// 不是完整的 Provider Adapter（聊天室主要的多供應商比較功能仍走 _shared/providers/anthropic.ts）。
// 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q1/Q2：卡住時自動詢問另一位 AI，
// 使用者已有 Gemini 免費 API key（見同一份文件「原本標記的矛盾已解決」）。

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

export async function consultGemini(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Gemini API error", res.status, body);
    return "（詢問 Gemini 時發生錯誤，請依自己的判斷繼續嘗試。）";
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: { text?: string }) => p.text ?? "")
    .join("\n");
  return text || "（Gemini 沒有回傳內容，請依自己的判斷繼續嘗試。）";
}
