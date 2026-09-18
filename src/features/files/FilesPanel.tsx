import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Trash2, Upload } from "lucide-react";
import { useFiles, useRequestDeleteFile, useUploadFile, getFileDownloadUrl } from "./useFiles";
import type { FileRow } from "../../types/database";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPanel({ roomId }: { roomId: string }) {
  const { data: files, isLoading } = useFiles(roomId);
  const uploadFile = useUploadFile(roomId);
  const requestDelete = useRequestDeleteFile(roomId);
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

  async function handleDownload(file: FileRow) {
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

  async function handleDelete(file: FileRow) {
    if (!window.confirm(`確定要刪除「${file.name}」嗎？這是難復原的操作，需要再次確認。`)) return;
    try {
      await requestDelete.mutateAsync(file.id);
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
              <div className="truncate text-sm">{file.name}</div>
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
