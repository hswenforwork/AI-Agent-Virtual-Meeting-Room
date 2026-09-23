// 極簡 Gemini 呼叫：只給「工作型代理卡住時，透過 consult_other_ai 自訂工具求助」這個情境用。
// 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q1/Q2：卡住時自動詢問另一位 AI，
// 使用者已有 Gemini 免費 API key（見同一份文件「原本標記的矛盾已解決」）。
//
// 對應 brainstorms/2026-09-23-worker-agent-delegation-fixes.md：這裡原本是一份完全獨立、
// 手刻的 fetch 呼叫，沒有套用 google.ts 那邊已經修過的「-flash 模型關閉思考避免額度被吃光
// 導致空回應」那個修正，是「@Gemini 呼叫其他代理失敗」的其中一個成因。改成直接重用
// createGoogleProvider()，兩邊行為（包含之後任何修正）自動保持一致，不用維護兩份邏輯。
import { createGoogleProvider } from "./google.ts";

const CONSULT_MODEL = Deno.env.get("DEFAULT_GEMINI_MODEL") ?? "gemini-3.8-flash";
const CONSULT_MAX_OUTPUT_TOKENS = 2048;

export interface ConsultGeminiResult {
  text: string;
  // brainstorms/2026-09-23-task-cross-ai-independent-reply.md 訪談 Q5：Gemini 的回答會
  // 額外變成聊天室裡它自己的一則獨立訊息，跟其他 AI 回覆一樣要顯示 token 用量，所以這裡
  // 也要把用量帶出去（失敗或沒有內容時是零用量，呼叫端不會因此把訊息寫成一段假數字）。
  usage: { inputTokens: number; outputTokens: number };
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

export async function consultGemini(apiKey: string, prompt: string): Promise<ConsultGeminiResult> {
  try {
    const result = await createGoogleProvider(apiKey).generate({
      systemPrompt: "",
      messages: [{ role: "user", content: prompt }],
      model: CONSULT_MODEL,
      maxOutputTokens: CONSULT_MAX_OUTPUT_TOKENS,
    });
    return {
      text: result.text || "（Gemini 沒有回傳內容，請依自己的判斷繼續嘗試。）",
      usage: result.usage,
    };
  } catch (err) {
    console.error("詢問 Gemini 失敗", err);
    return { text: "（詢問 Gemini 時發生錯誤，請依自己的判斷繼續嘗試。）", usage: ZERO_USAGE };
  }
}
