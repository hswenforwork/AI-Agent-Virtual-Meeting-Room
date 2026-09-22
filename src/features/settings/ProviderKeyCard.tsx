import { useState } from "react";
import { format } from "date-fns";
import { Check, Loader2, RefreshCw } from "lucide-react";
import type { ApiKeyStatus, ProviderSlug } from "./useApiKeys";
import { useDeleteApiKey, useRefreshModels, useSaveApiKey, useSelectModel } from "./useApiKeys";

const PROVIDER_LABEL: Record<ProviderSlug, string> = {
  anthropic: "Claude（Anthropic）",
  openai: "GPT（OpenAI）",
  google: "Gemini（Google）",
};

const PROVIDER_KEY_HINT: Record<ProviderSlug, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
};

export function ProviderKeyCard({ provider, status }: { provider: ProviderSlug; status?: ApiKeyStatus }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saveApiKey = useSaveApiKey();
  const deleteApiKey = useDeleteApiKey();
  const selectModel = useSelectModel();
  const refreshModels = useRefreshModels();

  const configured = !!status;

  async function handleSelectModel(model: string) {
    setError(null);
    try {
      await selectModel.mutateAsync({ provider, model });
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存模型偏好失敗，請稍後重試");
    }
  }

  async function handleRefreshModels() {
    setError(null);
    try {
      await refreshModels.mutateAsync(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新整理模型清單失敗，請稍後重試");
    }
  }

  async function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await saveApiKey.mutateAsync({ provider, apiKey: trimmed });
      setValue("");
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存金鑰失敗，請稍後重試");
    }
  }

  async function handleDelete() {
    setError(null);
    try {
      await deleteApiKey.mutateAsync(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除金鑰失敗，請稍後重試");
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800">{PROVIDER_LABEL[provider]}</div>
          {configured ? (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-green-700">
              <Check size={12} /> 已設定（{format(new Date(status!.updatedAt), "yyyy-MM-dd HH:mm")} 更新）
            </div>
          ) : (
            <div className="mt-0.5 text-xs text-slate-400">尚未設定</div>
          )}
        </div>
        {!editing && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                setEditing(true);
                setError(null);
              }}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-500"
            >
              {configured ? "更新" : "設定"}
            </button>
            {configured && (
              <button
                onClick={handleDelete}
                disabled={deleteApiKey.isPending}
                className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:border-red-400 disabled:opacity-50"
              >
                {deleteApiKey.isPending ? "刪除中…" : "刪除"}
              </button>
            )}
          </div>
        )}
      </div>

      {configured && !editing && (
        <div className="mt-3 flex items-center gap-2">
          <select
            value={status!.selectedModel ?? ""}
            onChange={(e) => handleSelectModel(e.target.value)}
            disabled={selectModel.isPending || status!.cachedModels.length === 0}
            className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none disabled:opacity-50"
          >
            <option value="" disabled>
              {status!.cachedModels.length === 0 ? "尚未取得模型清單" : "選擇要使用的模型"}
            </option>
            {status!.cachedModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleRefreshModels}
            disabled={refreshModels.isPending}
            title="重新整理模型清單"
            className="rounded-md border border-slate-300 p-1.5 text-slate-500 hover:border-slate-500 hover:text-slate-800 disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshModels.isPending ? "animate-spin" : ""} />
          </button>
        </div>
      )}

      {editing && (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={PROVIDER_KEY_HINT[provider]}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saveApiKey.isPending || !value.trim()}
              className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {saveApiKey.isPending && <Loader2 size={12} className="animate-spin" />}
              {saveApiKey.isPending ? "測試並儲存中…" : "測試並儲存"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setValue("");
                setError(null);
              }}
              disabled={saveApiKey.isPending}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
