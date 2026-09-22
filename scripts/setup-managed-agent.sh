#!/usr/bin/env bash
# ⚠️ 已過時：BYOK 上線後（brainstorms/2026-09-22-user-api-key-settings.md Q9/Q10），
# 每個使用者第一次按「開始執行」時，worker-task-start 這個 Edge Function 會自動用該
# 使用者自己的 Anthropic key 建立專屬的 agent/environment（邏輯見
# supabase/functions/_shared/managedAgents.ts 的 createManagedAgent()/createManagedEnvironment()，
# 跟這支腳本的建立邏輯一致），不再需要部署者手動執行這支腳本或設定
# MANAGED_AGENTS_AGENT_ID／MANAGED_AGENTS_ENVIRONMENT_ID 這兩個全域 secrets。
# 留著只是給想了解底層 API 呼叫長怎樣的人參考。
#
# ---- 以下是舊版一次性設定腳本，建立「工作型代理」要用的 Managed Agents agent + environment ----
# 對應 brainstorms/2026-09-18-agentic-sandbox-workers.md Q4（架構修正：改用 Managed Agents）。
#
# 用法：
#   export ANTHROPIC_API_KEY="sk-ant-..."   # 要有 Managed Agents（CMA）beta 權限
#   ./scripts/setup-managed-agent.sh
#
# 執行完成後，把印出來的兩個 ID 存成 Supabase Edge Function secrets：
#   supabase secrets set MANAGED_AGENTS_AGENT_ID=agent_xxx MANAGED_AGENTS_ENVIRONMENT_ID=env_xxx
#
# 注意：這是「設定期」腳本，只需要執行一次。之後每次任務執行都是 worker-task-start
# 這個 Edge Function 用已經存在的 agent_id/environment_id 建立新的 session，
# 不會、也不應該重複呼叫這支腳本去建立新的 agent（Managed Agents 的 agent 是可重複使用、有版本歷史的設定物件）。

set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "請先 export ANTHROPIC_API_KEY（需要有 Managed Agents beta 權限）" >&2
  exit 1
fi

HEADERS=(
  -H "Content-Type: application/json"
  -H "x-api-key: $ANTHROPIC_API_KEY"
  -H "anthropic-version: 2023-06-01"
  -H "anthropic-beta: managed-agents-2026-04-01"
)

echo "建立 environment..."
ENV_RESPONSE=$(curl -sS -X POST https://api.anthropic.com/v1/environments \
  "${HEADERS[@]}" \
  -d '{
    "name": "ai-collab-room-worker-env",
    "config": {
      "type": "cloud",
      "networking": { "type": "unrestricted" }
    }
  }')
ENV_ID=$(echo "$ENV_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$ENV_ID" ]; then
  echo "建立 environment 失敗：$ENV_RESPONSE" >&2
  exit 1
fi
echo "environment_id = $ENV_ID"

echo "建立 agent..."
AGENT_RESPONSE=$(curl -sS -X POST https://api.anthropic.com/v1/agents \
  "${HEADERS[@]}" \
  -d '{
    "name": "AI 協作室工作型代理",
    "model": "claude-opus-5",
    "system": "你是「AI 協作室」聊天室裡的工作型代理，負責實際動手完成使用者交辦的任務（寫程式、修 bug、整理/產生檔案、部署等）。完成後把最終產出的檔案寫到 /mnt/session/outputs/。若同一個問題已經嘗試修正 3 次以上仍然卡住，呼叫 consult_other_ai 工具求助另一位 AI，不需要等待使用者回應。全部完成後，最後一則訊息用「SUMMARY: 」開頭簡短總結成果。",
    "tools": [
      {
        "type": "agent_toolset_20260401",
        "default_config": { "permission_policy": { "type": "always_allow" } }
      },
      {
        "type": "custom",
        "name": "consult_other_ai",
        "description": "當你卡住、同一個問題已經嘗試修正 3 次以上仍無法解決時，呼叫這個工具，提供完整的問題描述、已嘗試過的方法、錯誤訊息，向另一位 AI（Gemini）求助分析與建議。",
        "input_schema": {
          "type": "object",
          "properties": {
            "problem_description": { "type": "string", "description": "卡住的問題完整描述" },
            "attempted_solutions": { "type": "string", "description": "已經嘗試過的解法" },
            "error_details": { "type": "string", "description": "遇到的錯誤訊息或現象" }
          },
          "required": ["problem_description", "attempted_solutions", "error_details"]
        }
      }
    ]
  }')
AGENT_ID=$(echo "$AGENT_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$AGENT_ID" ]; then
  echo "建立 agent 失敗：$AGENT_RESPONSE" >&2
  exit 1
fi
echo "agent_id = $AGENT_ID"

echo ""
echo "完成。請把以下兩行存成 Supabase Edge Function secrets："
echo "  supabase secrets set MANAGED_AGENTS_AGENT_ID=$AGENT_ID MANAGED_AGENTS_ENVIRONMENT_ID=$ENV_ID"
