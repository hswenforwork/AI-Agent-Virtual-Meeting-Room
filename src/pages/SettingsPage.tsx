import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ProviderKeyCard } from "../features/settings/ProviderKeyCard";
import { useApiKeyStatus, type ProviderSlug } from "../features/settings/useApiKeys";

const PROVIDERS: ProviderSlug[] = ["anthropic", "openai", "google"];

export function SettingsPage() {
  const { data: statuses, isLoading } = useApiKeyStatus();
  const statusByProvider = new Map((statuses ?? []).map((s) => [s.provider, s]));

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
        <Link to="/" className="text-slate-400 hover:text-slate-700" title="返回">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="text-sm font-semibold">設定</h1>
      </header>

      <div className="mx-auto w-full max-w-xl flex-1 overflow-y-auto px-4 py-6">
        <h2 className="text-sm font-semibold text-slate-700">AI API Key</h2>
        <p className="mt-1 text-xs text-slate-500">
          在這裡輸入你自己的 AI 供應商 API key，聊天室裡點名對應的代理時會用你自己的金鑰呼叫，
          金鑰只會加密存放在後端，這個網頁跟其他使用者都看不到明碼。
        </p>

        <div className="mt-4 space-y-3">
          {isLoading && <div className="text-xs text-slate-400">載入中…</div>}
          {!isLoading &&
            PROVIDERS.map((provider) => (
              <ProviderKeyCard key={provider} provider={provider} status={statusByProvider.get(provider)} />
            ))}
        </div>
      </div>
    </div>
  );
}
