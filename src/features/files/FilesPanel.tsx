import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Trash2, Upload } from "lucide-react";
import { useFiles, useRequestDeleteFile, useUploadFile, getFileDownloadUrl, type FileWithRoom } from "./useFiles";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 檔案夾現在跨聊天室共用（brainstorms/2026-09-23-notes-write-and-shared-workspace.md Q1），
// roomId 只在「新增」時用來當這個檔案的來源房間，列表本身不再依房間篩選。
export function FilesPanel({ roomId }: { roomId: string }) {
  const { data: files, isLoading } = useFiles();
  const uploadFile = useUploadFile(roomId);
  const requestDelete = useRequestDeleteFile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await uploadFile.mutateAsync(file);
      toast.success(`${file.name} 上傳完成`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  async function handleDownload(file: FileWithRoom) {
    setDownloading(file.id);
    try {
      const url = await getFileDownloadUrl(file.object_path);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "取得下載連結失敗");
    } finally {
      setDownloading(null);
    }
  }

  async function handleDelete(file: FileWithRoom) {
    if (!window.confirm(`確定要刪除「${file.name}」嗎？這是難復原的操作，需要再次確認。`)) return;
    try {
      await requestDelete.mutateAsync({ fileId: file.id, roomId: file.room_id });
      toast.success("已刪除");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold">檔案夾</h2>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploadFile.isPending}
          className="flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800 disabled:opacity-50"
        >
          <Upload size={14} /> {uploadFile.isPending ? "上傳中…" : "上傳"}
        </button>
        <input ref={inputRef} type="file" className="hidden" onChange={handleFileSelected} />
      </div>
      <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-400">
        純文字檔（txt/md/csv）會自動擷取內容，之後被點名的代理可以讀到；單檔上限 10MB。
      </p>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-slate-400">載入中…</div>}
        {files?.length === 0 && <div className="p-3 text-sm text-slate-400">還沒有檔案</div>}
        {files?.map((file) => (
          <div
            key={file.id}
            className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="truncate text-sm">{file.name}</div>
                {file.roomName && (
                  <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                    來自：{file.roomName}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">{formatSize(file.size_bytes)}</div>
            </div>
            <button
              onClick={() => handleDownload(file)}
              disabled={downloading === file.id}
              className="text-slate-400 hover:text-slate-700"
            >
              <Download size={14} />
            </button>
            <button onClick={() => handleDelete(file)} className="text-slate-400 hover:text-red-500">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
