// 依供應商代號建立對應的 Provider Adapter，agent-run／save-api-key／
// refresh-provider-models 都用同一個入口，不要各自重寫一次 switch。

import { createAnthropicProvider } from "./anthropic.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createGoogleProvider } from "./google.ts";
import type { AIProvider } from "./types.ts";
import type { ProviderSlug } from "../vault.ts";

export function createProviderAdapter(provider: ProviderSlug, apiKey: string): AIProvider {
  switch (provider) {
    case "anthropic":
      return createAnthropicProvider(apiKey);
    case "openai":
      return createOpenAIProvider(apiKey);
    case "google":
      return createGoogleProvider(apiKey);
  }
}
