import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

export type ProviderSlug = "anthropic" | "openai" | "google";

export interface ModelOption {
  id: string;
  label: string;
}

export interface ApiKeyStatus {
  provider: ProviderSlug;
  updatedAt: string;
  selectedModel: string | null;
  cachedModels: ModelOption[];
  modelsFetchedAt: string | null;
}

async function extractErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (typeof body?.error?.message === "string") return body.error.message;
    } catch {
      // 解析失敗就用預設訊息，不讓解析錯誤蓋掉原本的錯誤
    }
  }
  return fallback;
}

// 只查「有沒有設定」，不會、也不可能查到明碼金鑰本身
// （migrations/0009_byok_api_keys.sql：明碼只能透過 service_role 專用的
// SECURITY DEFINER 函式讀取，這裡的 RLS 只允許看到自己的 provider/updated_at）。
export function useApiKeyStatus() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["api-key-status", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<ApiKeyStatus[]> => {
      const { data, error } = await supabase
        .from("user_provider_keys")
        .select("provider, updated_at, selected_model, cached_models, models_fetched_at");
      if (error) throw error;
      return (data ?? []).map((row) => ({
        provider: row.provider as ProviderSlug,
        updatedAt: row.updated_at,
        selectedModel: row.selected_model,
        cachedModels: (row.cached_models ?? []) as ModelOption[],
        modelsFetchedAt: row.models_fetched_at,
      }));
    },
  });
}

export function useSaveApiKey() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ provider, apiKey }: { provider: ProviderSlug; apiKey: string }) => {
      const { error } = await supabase.functions.invoke("save-api-key", {
        body: { provider, apiKey },
      });
      if (error) throw new Error(await extractErrorMessage(error, "儲存金鑰失敗，請稍後重試"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-status", user?.id] });
    },
  });
}

export function useSelectModel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ provider, model }: { provider: ProviderSlug; model: string }) => {
      const { error } = await supabase.functions.invoke("select-provider-model", {
        body: { provider, model },
      });
      if (error) throw new Error(await extractErrorMessage(error, "儲存模型偏好失敗，請稍後重試"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-status", user?.id] });
    },
  });
}

export function useRefreshModels() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (provider: ProviderSlug) => {
      const { error } = await supabase.functions.invoke("refresh-provider-models", {
        body: { provider },
      });
      if (error) throw new Error(await extractErrorMessage(error, "重新整理模型清單失敗，請稍後重試"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-status", user?.id] });
    },
  });
}

export function useDeleteApiKey() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (provider: ProviderSlug) => {
      const { error } = await supabase.functions.invoke("delete-api-key", {
        body: { provider },
      });
      if (error) throw new Error(await extractErrorMessage(error, "刪除金鑰失敗，請稍後重試"));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-key-status", user?.id] });
    },
  });
}
