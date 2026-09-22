// 極簡 SSE 逐行解析器：把 fetch() Response.body 這個 ReadableStream 解析成一則則
// data: 內容（多行 data: 會用換行接起來），呼叫端自己決定每個 data 內容代表什麼（例如
// 直接 JSON.parse 後看 type 欄位）。同樣的手刻邏輯已經在 _shared/managedAgents.ts 的
// streamSessionEvents() 驗證過可用，這裡抽成共用版本給三個供應商的串流呼叫重複使用。
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;

        onData(dataLines.join("\n"));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
