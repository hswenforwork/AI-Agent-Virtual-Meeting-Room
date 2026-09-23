// 極簡 SSE 逐行解析器：把 fetch() Response.body 這個 ReadableStream 解析成一則則
// data: 內容（多行 data: 會用換行接起來），呼叫端自己決定每個 data 內容代表什麼（例如
// 直接 JSON.parse 後看 type 欄位）。同樣的手刻邏輯已經在 _shared/managedAgents.ts 的
// streamSessionEvents() 驗證過可用，這裡抽成共用版本給三個供應商的串流呼叫重複使用。

function emitEvent(rawEvent: string, onData: (data: string) => void) {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return;
  onData(dataLines.join("\n"));
}

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
      // 保守起見統一換行字元：有些供應商的串流是 CRLF（"\r\n\r\n" 當事件分隔），
      // 逐字比對 "\n\n" 會完全找不到、事件永遠卡在 buffer 裡出不來。
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        emitEvent(rawEvent, onData);
      }
    }
    // 連線關閉前最後一個事件如果沒有補上結尾的空行就直接斷線，會整包留在 buffer
    // 裡沒被送出去——供應商如果把整段（或最後一段）回覆塞在沒有結尾空行的最後一個
    // frame，這裡不補處理的話，該內容就會憑空消失（回覆看起來像完全沒有內容）。
    if (buffer.trim()) emitEvent(buffer, onData);
  } finally {
    reader.releaseLock();
  }
}
