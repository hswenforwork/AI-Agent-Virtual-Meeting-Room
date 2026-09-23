// 把共享知識系統（knowledge_items／decisions／knowledge_links／knowledge_sources）整理成
// 一段文字，讓 AI 當作背景參考。對應 docs/AI-Partner借鏡對照.md 第 1、2、3 項：只取少量
// 相關且已確認的知識/決策/關聯，附「真正可引用」的來源（id、類型、摘要、可解析的畫面連結，
// 不只是筆數）與更新時間；已被新決策取代的舊決策不會出現在這裡。跟 workspaceContext.ts 的
// buildWorkspaceContext() 同一種「精簡摘要、不整段貼原始資料」的做法。
//
// PR #44 review 修正：原本只給來源筆數，代理沒辦法真的引用；這裡改成附上有限數量「status=
// valid」的來源，每筆給 id、類型、（只有 verified=true 才附上的）摘要、以及可解析的畫面
// 連結（訊息型來源連到 #/rooms/{roomId}?highlight={messageId}，見 RoomPage.tsx／
// ChatPanel.tsx／MessageBubble.tsx 新增的跳轉高亮功能；來源房間已刪除就沒有連結，只保留
// 摘要文字）。也額外撈出「已確認」的知識關聯（相關／支持／依賴／矛盾／取代），矛盾關聯
// 明確提醒代理不要自己選邊。

import type { supabaseAdmin } from "./supabaseAdmin.ts";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const KNOWLEDGE_MAX_COUNT = 5;
const KNOWLEDGE_BODY_PREVIEW_CHARS = 300;
const DECISION_MAX_COUNT = 5;
const DECISION_TEXT_PREVIEW_CHARS = 300;
// 候選池：先撈比實際要用的上限更多一點筆數，才有東西可以依關鍵字排序，不是每次都只看
// 最新 5 筆——但也不能撈全部（帳號用久了知識會愈存愈多），設一個合理的候選池上限。
const CANDIDATE_POOL_SIZE = 30;
// 每則知識/決策最多附幾筆「可引用」的來源——太多會把提示詞灌爆，這裡刻意保守。
const SOURCE_MAX_PER_SUBJECT = 2;
// 關聯（knowledge_links）最多附幾條，矛盾/依賴/取代優先，其餘用 related/supports 補滿。
const LINK_MAX_COUNT = 8;
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

const RELATION_LABEL: Record<string, string> = {
  related: "相關",
  supports: "支持",
  depends_on: "依賴",
  contradicts: "矛盾",
  supersedes: "取代",
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

interface CitableSource {
  id: string;
  sourceType: string;
  verified: boolean;
  contentSnapshot: string | null;
  link: string | null;
}

interface KnowledgeSourceRow {
  id: string;
  subject_id: string;
  source_type: string;
  room_id: string | null;
  message_id: string | null;
  external_url: string | null;
  verified: boolean;
  content_snapshot: string | null;
  created_at: string;
}

interface KnowledgeLinkRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  reasoning: string | null;
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

// 前端用 HashRouter（src/main.tsx），畫面連結一律是 "#/rooms/{roomId}"（或加上
// "?highlight={messageId}" 跳到並高亮特定訊息，見 ChatPanel.tsx）。這個 Edge Function
// 執行時不知道網站部署在哪個網域，預設只給相對路徑；有設定 PUBLIC_APP_URL（選用的
// Edge Function secret）才會組成完整網址，方便代理直接在回覆裡貼出可點擊的連結。
function buildAppLinkPrefix(): string {
  const base = Deno.env.get("PUBLIC_APP_URL");
  return base ? `${base.replace(/\/$/, "")}/#` : "#";
}

function buildSourceLink(source: KnowledgeSourceRow): string | null {
  if (source.source_type === "external_url") return source.external_url ?? null;
  // 來源房間已經被刪除（room_id 被 set null）：沒有畫面可以連過去，只保留摘要文字。
  if (!source.room_id) return null;
  const prefix = buildAppLinkPrefix();
  if (source.source_type === "message" && source.message_id) {
    return `${prefix}/rooms/${source.room_id}?highlight=${source.message_id}`;
  }
  // note/task/file：記事本/待辦事項/檔案夾是跨聊天室共用的（任何房間都看得到），
  // 目前沒有針對單一項目的畫面內深連結，先連到來源房間，使用者可以自己切到對應分頁找。
  return `${prefix}/rooms/${source.room_id}`;
}

// 只取 status='valid' 的來源（已失效的不當成可引用證據，只在「共享知識」分頁本身顯示）；
// 每個 subject 最多 SOURCE_MAX_PER_SUBJECT 筆，優先已驗證內容的。
// PR #44 第二輪 review 修正：明確加上 owner_id 過濾——這個查詢用 service_role 執行，不會
// 自動套用 RLS，subject_id 雖然是從已經用 owner_id 篩過的 items/decisions 查出來的，但
// knowledge_sources 本身如果曾經被寫進一筆 owner_id 不同、subject_id 卻剛好對到的髒資料
// （見 validate_knowledge_source_subject() trigger，這裡是讀取端再加一層防護），不應該
// 讓它混進另一個帳號的檢索結果。
async function fetchCitableSources(
  admin: AdminClient,
  ownerId: string,
  subjectType: "knowledge_item" | "decision",
  ids: string[],
): Promise<Map<string, { shown: CitableSource[]; total: number }>> {
  const result = new Map<string, { shown: CitableSource[]; total: number }>();
  if (ids.length === 0) return result;

  const { data, error } = await admin
    .from("knowledge_sources")
    .select("id, subject_id, source_type, room_id, message_id, external_url, verified, content_snapshot, created_at")
    .eq("owner_id", ownerId)
    .eq("subject_type", subjectType)
    .eq("status", "valid")
    .in("subject_id", ids)
    .order("verified", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("讀取知識來源失敗", subjectType, error);
    return result;
  }

  for (const row of (data ?? []) as KnowledgeSourceRow[]) {
    const entry = result.get(row.subject_id) ?? { shown: [], total: 0 };
    entry.total += 1;
    if (entry.shown.length < SOURCE_MAX_PER_SUBJECT) {
      entry.shown.push({
        id: row.id,
        sourceType: row.source_type,
        verified: row.verified,
        // 沒驗證過內容的來源不附摘要——避免代理把「還沒核對過的東西」講得好像已經讀過。
        contentSnapshot: row.verified ? row.content_snapshot : null,
        link: buildSourceLink(row),
      });
    }
    result.set(row.subject_id, entry);
  }
  return result;
}

function formatSourceLine(s: CitableSource): string {
  const verifiedLabel = s.verified ? "已驗證內容" : "僅標記存在（內容未驗證）";
  const linkPart = s.link ? `連結：${s.link}` : "（來源房間已刪除，連結已失效）";
  const snapshotPart = s.contentSnapshot ? `\n  摘要：${s.contentSnapshot.slice(0, 200)}` : "";
  return `  - [來源 id=${s.id}／${s.sourceType}／${verifiedLabel}] ${linkPart}${snapshotPart}`;
}

// 只抓「兩端都在這次已經選進提示詞的知識/決策」範圍內的已確認關聯——這樣標題一定查得到，
// 不用再多打一次資料庫查詢去撈不在範圍內的另一端；矛盾/依賴/取代優先排到前面。
async function fetchRelevantLinks(admin: AdminClient, ownerId: string, subjectIds: string[]): Promise<KnowledgeLinkRow[]> {
  if (subjectIds.length < 2) return [];
  const { data, error } = await admin
    .from("knowledge_links")
    .select("id, from_type, from_id, to_type, to_id, relation, reasoning")
    .eq("owner_id", ownerId)
    .eq("status", "confirmed")
    .in("from_id", subjectIds)
    .in("to_id", subjectIds);

  if (error) {
    console.error("讀取知識關聯失敗", error);
    return [];
  }

  const priority: Record<string, number> = { contradicts: 0, depends_on: 1, supersedes: 1, supports: 2, related: 3 };
  return (data ?? [])
    .sort((a, b) => (priority[a.relation] ?? 9) - (priority[b.relation] ?? 9))
    .slice(0, LINK_MAX_COUNT);
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

  const [itemSources, decisionSources, links] = await Promise.all([
    fetchCitableSources(admin, ownerId, "knowledge_item", items.map((i) => i.id)),
    fetchCitableSources(admin, ownerId, "decision", decisions.map((d) => d.id)),
    fetchRelevantLinks(admin, ownerId, [...items.map((i) => i.id), ...decisions.map((d) => d.id)]),
  ]);

  const sections: string[] = [];
  const titleById = new Map<string, string>([
    ...items.map((i) => [i.id, i.title] as const),
    ...decisions.map((d) => [d.id, d.title] as const),
  ]);

  if (items.length > 0) {
    const text = items
      .map((i) => {
        const label = CATEGORY_LABEL[i.category] ?? i.category;
        const body = i.body.slice(0, KNOWLEDGE_BODY_PREVIEW_CHARS);
        const sourceInfo = itemSources.get(i.id);
        const sourceLines = sourceInfo && sourceInfo.shown.length > 0
          ? `\n${sourceInfo.shown.map(formatSourceLine).join("\n")}${
              sourceInfo.total > sourceInfo.shown.length ? `\n  （還有 ${sourceInfo.total - sourceInfo.shown.length} 筆未列出）` : ""
            }`
          : "\n  （目前沒有已驗證有效的來源，引用時請明確告知使用者這點）";
        return `【${label}】${i.title}（更新於 ${formatDate(i.updated_at)}）\n${body}${sourceLines}`;
      })
      .join("\n\n");
    sections.push(`## 共享知識（使用者已確認的長期背景）\n${text}`);
  }

  if (decisions.length > 0) {
    const text = decisions
      .map((d) => {
        const supersedeNote = d.supersedes_id ? "（此決策取代了先前的舊版本）" : "";
        const body = d.decision_text.slice(0, DECISION_TEXT_PREVIEW_CHARS);
        const sourceInfo = decisionSources.get(d.id);
        const sourceLines = sourceInfo && sourceInfo.shown.length > 0
          ? `\n${sourceInfo.shown.map(formatSourceLine).join("\n")}${
              sourceInfo.total > sourceInfo.shown.length ? `\n  （還有 ${sourceInfo.total - sourceInfo.shown.length} 筆未列出）` : ""
            }`
          : "\n  （目前沒有已驗證有效的來源，引用時請明確告知使用者這點）";
        return `【決策】${d.title}${supersedeNote}（決定於 ${formatDate(d.decided_at)}）\n${body}${sourceLines}`;
      })
      .join("\n\n");
    sections.push(`## 目前有效的決策（舊版本已被取代的不會出現在這裡）\n${text}`);
  }

  if (links.length > 0) {
    const lines = links.map((l) => {
      const fromTitle = titleById.get(l.from_id) ?? "（未知）";
      const toTitle = titleById.get(l.to_id) ?? "（未知）";
      const relationLabel = RELATION_LABEL[l.relation] ?? l.relation;
      const warn = l.relation === "contradicts" ? "⚠ 尚未解決的矛盾：" : "";
      const reasoningPart = l.reasoning ? `（原因：${l.reasoning}）` : "";
      return `- ${warn}「${fromTitle}」${relationLabel}「${toTitle}」${reasoningPart}`;
    });
    sections.push(
      `## 已確認的知識/決策關聯\n提醒：「矛盾」代表使用者自己也還沒解決這個衝突，回答時要明確指出兩者都存在、` +
        `不要自己選一邊當標準答案，並建議使用者到「共享知識 → 關聯圖」處理；「依賴」代表其中一項要成立需要另一項先成立；` +
        `「取代」代表較新的那項才是目前依據。\n${lines.join("\n")}`,
    );
  }

  return sections.join("\n\n");
}
