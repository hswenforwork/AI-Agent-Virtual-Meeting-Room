// 訊息泡泡顯示 token 用量（brainstorms/2026-09-23-message-token-usage-display.md 訪談 Q2）：
// 只顯示一個合計數字，不分輸入/輸出、不顯示模型名稱；MessageBubble 跟 TaskCardMessage
// 都用得到，抽成共用函式。
export function formatTokenUsage(inputTokens: number | null, outputTokens: number | null): string | null {
  if (inputTokens == null || outputTokens == null) return null;
  return `${(inputTokens + outputTokens).toLocaleString()} tokens`;
}
