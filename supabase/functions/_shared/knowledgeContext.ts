// 把共享知識系統（knowledge_items／decisions）整理成一段文字，讓 AI 當作背景參考。
// 對應 docs/AI-Partner借鏡對照.md 第 1、2 項：只取少量相關且已確認的知識，附來源與
// 更新時間；已被新決策取代的舊決策不會出現在這裡。跟 workspaceContext.ts 的
// buildWorkspaceContext() 同一種「精簡摘要、不整段貼原始資料」的做法。

import type { supabaseAdmin } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const KNOWLEDGE_MAX_COUNT = 5;
const KNOWLEDGE_BODY_PREVIEW_CHARS = 300;
const DECISION_MAX_COUNT = 5;
const DECISION_TEXT_PREVIEW_CHARS = 300;
// 候選池：先撈比實際要用的上限更多一點筆數，才有東西可以依關鍵字排序，不是每次都只看
// 最新 5 筆——但也不能撈全部（帳號用久了知識會愈存愈多），設一個合理的候選池上限。
const CANDIDATE_POOL_SIZE = 30;
const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "們", "這", "那", "和", "與",
  "就", "都", "也", "還", "又", "請", "把", "被", "一個", "一下", "什麼", "怎麼", "可以",
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "or", "in", "on", "for",
]);

const CATEGORY_LABEL: Record<string, string> = {
  goal: "目標",
  project: "專案",
  term: "用語",
  rule: "工作規則",
  fact: "事實",
  other: "其他",
};

interface KnowledgeItemRow {
  id: string;
  title: string;
  body: string;
  category: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  title: string;
  decision_text: string;
  decided_at: string;
  updated_at: string;
  supersedes_id: string | null;
}

// 從最近對話文字抽出「有意義的詞」（去掉停用詞、太短的字），用來跟知識標題/內容
// 做關鍵字重疊比對，當作「相關度」的最小可行版本（沒有做向量嵌入／語意搜尋，
// 詳見 docs/AI-Partner借鏡對照.md「尚未涵蓋、刻意留白的部分」第 1 點）。
function extractKeywords(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[\s，。、！？「」『』（）()[\]{}:：;；,.!?\n]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function overlapScore(keywords: Set<string>, haystack: string): number {
  if (keywords.size === 0) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) score += 1;
  }
  return score;
}

async function fetchRelevantKnowledgeItems(
  admin: AdminClient,
  ownerId: string,
  keywords: Set<string>,
): Promise<KnowledgeItemRow[]> {
  const { data } = await admin
    .from("knowledge_items")
    .select("id, title, body, category, updated_at, expires_at")
    .eq("owner_id", ownerId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(CANDIDATE_POOL_SIZE);

  const notExpired = (data ?? []).filter((n) => !n.expires_at || new Date(n.expires_at) > new Date());
  const ranked = notExpired
    .map((n) => ({ row: n as KnowledgeItemRow, score: overlapScore(keywords, `${n.title} ${n.body}`) }))
    .sort((a, b) => b.score - a.score || new Date(b.row.updated_at).getTime() - new Date(a.row.updated_at).getTime());

  const hasAnyMatch = ranked.some((r) => r.score > 0);
  const chosen = hasAnyMatch ? ranked.filter((r) => r.score > 0) : ranked;
  return chosen.slice(0, KNOWLEDGE_MAX_COUNT).map((r) => r.row);
}

async function fetchRelevantDecisions(
  admin: AdminClient,
  ownerId: string,
  keywords: Set<string>,
): Promise<DecisionRow[]> {
  // 只拿 active（已被取代的決策不會進系統提示詞，見 handle_decision_supersede() trigger）。
  const { data } = await admin
    .from("decisions")
    .select("id, title, decision_text, decided_at, updated_at, supersedes_id")
    .eq("owner_id", ownerId)
    .eq("status", "active")
    .order("decided_at", { ascending: false })
    .limit(CANDIDATE_POOL_SIZE);

  const ranked = (data ?? [])
    .map((d) => ({ row: d as DecisionRow, score: overlapScore(keywords, `${d.title} ${d.decision_text}`) }))
    .sort((a, b) => b.score - a.score || new Date(b.row.decided_at).getTime() - new Date(a.row.decided_at).getTime());

  const hasAnyMatch = ranked.some((r) => r.score > 0);
  const chosen = hasAnyMatch ? ranked.filter((r) => r.score > 0) : ranked;
  return chosen.slice(0, DECISION_MAX_COUNT).map((r) => r.row);
}

async function fetchSourceCounts(
  admin: AdminClient,
  subjectType: "knowledge_item" | "decision",
  ids: string[],
): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const { data } = await admin
    .from("knowledge_sources")
    .select("subject_id")
    .eq("subject_type", subjectType)
    .in("subject_id", ids);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.subject_id] = (counts[row.subject_id] ?? 0) + 1;
  }
  return counts;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

// 給檢索用（agent-run 系統提示詞、worker-task-start 初始訊息）。recentText 是最近對話文字，
// 用來抓關鍵字排相關度；沒有 recentText（例如還沒有任何對話）就退回純依更新時間排序。
export async function buildKnowledgeContext(
  admin: AdminClient,
  ownerId: string | null,
  recentText: string,
): Promise<string> {
  if (!ownerId) return "";

  const keywords = extractKeywords(recentText);
  const [items, decisions] = await Promise.all([
    fetchRelevantKnowledgeItems(admin, ownerId, keywords),
    fetchRelevantDecisions(admin, ownerId, keywords),
  ]);
  if (items.length === 0 && decisions.length === 0) return "";

  const [itemSourceCounts, decisionSourceCounts] = await Promise.all([
    fetchSourceCounts(admin, "knowledge_item", items.map((i) => i.id)),
    fetchSourceCounts(admin, "decision", decisions.map((d) => d.id)),
  ]);

  const sections: string[] = [];

  if (items.length > 0) {
    const text = items
      .map((i) => {
        const label = CATEGORY_LABEL[i.category] ?? i.category;
        const body = i.body.slice(0, KNOWLEDGE_BODY_PREVIEW_CHARS);
        const sourceCount = itemSourceCounts[i.id] ?? 0;
        return `【${label}】${i.title}（更新於 ${formatDate(i.updated_at)}，來源 ${sourceCount} 筆，詳見「共享知識」分頁）\n${body}`;
      })
      .join("\n\n");
    sections.push(`## 共享知識（使用者已確認的長期背景）\n${text}`);
  }

  if (decisions.length > 0) {
    const text = decisions
      .map((d) => {
        const supersedeNote = d.supersedes_id ? "（此決策取代了先前的舊版本）" : "";
        const sourceCount = decisionSourceCounts[d.id] ?? 0;
        const body = d.decision_text.slice(0, DECISION_TEXT_PREVIEW_CHARS);
        return `【決策】${d.title}${supersedeNote}（決定於 ${formatDate(d.decided_at)}，來源 ${sourceCount} 筆）\n${body}`;
      })
      .join("\n\n");
    sections.push(`## 目前有效的決策（舊版本已被取代的不會出現在這裡）\n${text}`);
  }

  return sections.join("\n\n");
}
