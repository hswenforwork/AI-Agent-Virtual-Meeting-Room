// 對話自動摘要（brainstorms/2026-09-23-gpt-audit-followups.md Q11-Q13）：摘要存在
// rooms.conversation_summary，直接沿用 useRooms() 既有的查詢快取跟 Realtime 訂閱
// （AppLayout 裡的 useRoomsRealtimeSync 已經訂閱了 rooms 表所有欄位的變化），
// 不需要再開一個新的查詢或訂閱。

import { useRooms } from "../rooms/useRooms";

export function useConversationSummary(roomId: string) {
  const { data: rooms, isLoading } = useRooms();
  const room = rooms?.find((r) => r.id === roomId);
  return { summary: room?.conversation_summary ?? "", isLoading };
}
