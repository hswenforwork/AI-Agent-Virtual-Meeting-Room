export function DeleteRoomDialog({
  roomName,
  onConfirm,
  onCancel,
  isDeleting,
}: {
  roomName: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-slate-900">永久刪除聊天室？</h2>
        <p className="mt-2 text-sm text-slate-600">
          「{roomName}」的所有訊息、記事本、待辦事項與檔案都會被永久刪除，無法復原。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            disabled={isDeleting}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isDeleting ? "刪除中…" : "永久刪除"}
          </button>
        </div>
      </div>
    </div>
  );
}
