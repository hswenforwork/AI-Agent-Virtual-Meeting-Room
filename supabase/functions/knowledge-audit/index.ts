// knowledge-audit：借鏡 AI-Partner 的 /audit——依證據檢查共享知識系統，不是看知識筆數。
// 對應 docs/AI-Partner借鏡對照.md 第 5 項。
//
// 兩種呼叫方式：
// 1. 一般使用者手動觸發（前端「立即檢查」按鈕）：帶使用者自己的 JWT，用
//    supabaseAsUser()，RLS 天然把查詢範圍限制在自己帳號名下。
// 2. 排程呼叫（PR #44 review 修正：原本 README 建議把某個使用者的 JWT 寫死存進
//    pg_cron 排程 SQL，但 JWT 本身會過期，排程遲早會開始失敗——不是真正「可持續使用」
//    的排程）：改成用 service_role key（不會過期）+ 明確帶 ownerId 參數，這裡驗證呼叫者
//    真的持有 service_role key（跟 agent-run 用同一種比對方式）才會用 service_role client
//    查詢，且每一張表都明確加 owner_id 過濾（不是單純信任 service_role 拿到全部人的資料），
//    見 README「共享知識系統」章節的 pg_cron／Vault 設定方式。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const DEFAULT_REVIEW_INTERVAL_DAYS = 180;
const STALE_PROPOSAL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// 17 項修正計劃項目 14：PostgREST／Supabase 對單次查詢預設有回傳筆數上限（專案設定，
// 常見預設是 1000），舊版本這裡的五張表查詢完全沒有分頁，資料量一旦超過那個上限，
// 就會被「悄悄截斷」——稽核只看到前面一部分資料，卻還是照常產生一份「掃過了」的報告，
// 完全沒有任何跡象顯示其實沒掃完。PAGE_SIZE 故意設得比那個常見上限小很多，
// 用 .range() 分頁掃到「這一頁回傳筆數 < PAGE_SIZE」為止，確保掃描結果不受那個上限影響，
// 不管帳號名下這張表實際有幾筆都能掃完整。
const PAGE_SIZE = 500;

type Severity = "confirmed" | "needs_review" | "suggestion";
type SupabaseLikeClient = ReturnType<typeof supabaseAdmin> | ReturnType<typeof supabaseAsUser>;

interface Finding {
  finding_id: string;
  category: string;
  severity: Severity;
  message: string;
  evidence: Record<string, unknown>;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // 沒有 body 也沒關係
    }

    const isServiceRoleCall = authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

    let client: SupabaseLikeClient;
    let ownerId: string;
    let triggeredBy: "manual" | "schedule";

    if (isServiceRoleCall) {
      // 排程路徑：呼叫者已經證明持有 service_role key，等同已經有整個資料庫的存取權，
      // 這裡仍然要求明確帶 ownerId 並在每一張表的查詢加上過濾，不是圖方便直接查全部。
      const requestedOwnerId = body.ownerId;
      if (typeof requestedOwnerId !== "string" || !requestedOwnerId) {
        return jsonError("排程呼叫缺少 ownerId", 400, "missing_owner_id", headers);
      }
      client = supabaseAdmin();
      ownerId = requestedOwnerId;
      triggeredBy = "schedule";
    } else {
      const userClient = supabaseAsUser(authHeader);
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);
      client = userClient;
      ownerId = user.id;
      triggeredBy = "manual";
    }

    const result = await runAudit(client, ownerId, triggeredBy);
    if (!result.ok) return jsonError(result.message, result.status, result.code, headers);

    return new Response(JSON.stringify({ ok: true, ...result.body }), { headers });
  } catch (err) {
    console.error("knowledge-audit 未預期錯誤", err);
    return jsonError("稽核時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});

type AuditResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

interface PaginatedFetch<T> {
  rows: T[];
  scanned: number;
  pages: number;
  error: { table: string; message: string } | null;
}

// 分頁掃完一整張表（限定 owner_id），不依賴 PostgREST/Supabase 專案設定的單次查詢筆數
// 上限——每一頁固定用 PAGE_SIZE，掃到某一頁回傳筆數 < PAGE_SIZE 就代表已經到底。
// 用 id 排序只是為了讓分頁本身穩定（避免同一頁重複或漏頁），不代表任何業務意義上的順序。
async function fetchAllPaginated<T>(
  client: SupabaseLikeClient,
  table: string,
  columns: string,
  ownerId: string,
): Promise<PaginatedFetch<T>> {
  const rows: T[] = [];
  let page = 0;
  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await client.from(table).select(columns).eq("owner_id", ownerId).order("id", { ascending: true }).range(from, to);
    if (error) {
      return { rows, scanned: rows.length, pages: page + 1, error: { table, message: error.message } };
    }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    page += 1;
    if (batch.length < PAGE_SIZE) break;
  }
  return { rows, scanned: rows.length, pages: page, error: null };
}

interface AuditKnowledgeItemRow {
  id: string;
  title: string;
  category: string;
  status: string;
  expires_at: string | null;
  review_interval_days: number | null;
  updated_at: string;
}
interface AuditDecisionRow {
  id: string;
  title: string;
  status: string;
  decided_at: string;
  updated_at: string;
}
interface AuditSourceRow {
  id: string;
  subject_type: string;
  subject_id: string;
  status: string;
  verified: boolean;
}
interface AuditLinkRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  status: string;
}
interface AuditProposalRow {
  id: string;
  proposal_type: string;
  status: string;
  created_at: string;
}

async function runAudit(client: SupabaseLikeClient, ownerId: string, triggeredBy: "manual" | "schedule"): Promise<AuditResult> {
  const [itemsRes, decisionsRes, sourcesRes, linksRes, proposalsRes] = await Promise.all([
    fetchAllPaginated<AuditKnowledgeItemRow>(
      client,
      "knowledge_items",
      "id, title, category, status, expires_at, review_interval_days, updated_at",
      ownerId,
    ),
    fetchAllPaginated<AuditDecisionRow>(client, "decisions", "id, title, status, decided_at, updated_at", ownerId),
    fetchAllPaginated<AuditSourceRow>(client, "knowledge_sources", "id, subject_type, subject_id, status, verified", ownerId),
    fetchAllPaginated<AuditLinkRow>(
      client,
      "knowledge_links",
      "id, from_type, from_id, to_type, to_id, relation, status",
      ownerId,
    ),
    fetchAllPaginated<AuditProposalRow>(client, "knowledge_proposals", "id, proposal_type, status, created_at", ownerId),
  ]);

  // PR #44 review 修正（第一輪）＋項目 14 修正：原本任何一個查詢失敗都會被 `?? []` 悄悄
  // 吞掉，變成「這張表沒有任何資料」；項目 14 之前的版本雖然會回報失敗，但整張表沒有分頁，
  // 資料量超過 PostgREST 的單次查詢筆數上限時會被悄悄截斷、完全不會報錯，稽核照常產生一份
  // 「掃過了」的報告，卻其實只看到部分資料。現在改成逐頁掃描，任一頁查詢出錯，或掃描過程
  // 中斷，整次稽核直接失敗、不寫入任何報告；正常掃完時，每張表實際掃描到的筆數也會寫進
  // 報告的 stats.scan，讓使用者／自己都能事後確認掃描是不是真的完整，不是只憑筆數猜測。
  const queryResults = [
    { name: "knowledge_items", res: itemsRes },
    { name: "decisions", res: decisionsRes },
    { name: "knowledge_sources", res: sourcesRes },
    { name: "knowledge_links", res: linksRes },
    { name: "knowledge_proposals", res: proposalsRes },
  ];
  const failed = queryResults.filter((q) => q.res.error);
  if (failed.length > 0) {
    for (const f of failed) console.error("knowledge-audit 查詢失敗", f.name, f.res.error, "已掃描", f.res.scanned, "筆");
    return {
      ok: false,
      status: 500,
      code: "audit_query_failed",
      message: `稽核未完成：${failed
        .map((f) => `${f.name}（已掃描 ${f.res.scanned} 筆時讀取失敗）`)
        .join("、")}，沒有產生報告，請稍後重試。`,
    };
  }

  const scanStats = {
    knowledge_items: { scanned: itemsRes.scanned, pages: itemsRes.pages },
    decisions: { scanned: decisionsRes.scanned, pages: decisionsRes.pages },
    knowledge_sources: { scanned: sourcesRes.scanned, pages: sourcesRes.pages },
    knowledge_links: { scanned: linksRes.scanned, pages: linksRes.pages },
    knowledge_proposals: { scanned: proposalsRes.scanned, pages: proposalsRes.pages },
  };

  const items = itemsRes.rows;
  const decisions = decisionsRes.rows;
  const sources = sourcesRes.rows;
  const links = linksRes.rows;
  const proposals = proposalsRes.rows;

  const findings: Finding[] = [];
  const now = Date.now();

  const sourceCountBySubject = new Map<string, number>();
  const invalidSourceStillUsed = new Map<string, number>();
  for (const s of sources) {
    const key = `${s.subject_type}:${s.subject_id}`;
    sourceCountBySubject.set(key, (sourceCountBySubject.get(key) ?? 0) + 1);
    if (s.status === "invalid") {
      invalidSourceStillUsed.set(key, (invalidSourceStillUsed.get(key) ?? 0) + 1);
    }
  }

  // --- Context：沒有來源的知識／決策（confirmed，不能查證的知識不該被當依據）---
  const activeItems = items.filter((i) => i.status === "active");
  for (const item of activeItems) {
    const key = `knowledge_item:${item.id}`;
    if (!sourceCountBySubject.get(key)) {
      findings.push({
        finding_id: `no-source-item-${item.id}`,
        category: "來源",
        severity: "confirmed",
        message: `知識「${item.title}」沒有任何來源，無法回溯依據。`,
        evidence: { subject_type: "knowledge_item", subject_id: item.id },
      });
    }
  }
  const activeDecisions = decisions.filter((d) => d.status === "active");
  for (const decision of activeDecisions) {
    const key = `decision:${decision.id}`;
    if (!sourceCountBySubject.get(key)) {
      findings.push({
        finding_id: `no-source-decision-${decision.id}`,
        category: "來源",
        severity: "confirmed",
        message: `決策「${decision.title}」沒有任何來源，無法回溯依據。`,
        evidence: { subject_type: "decision", subject_id: decision.id },
      });
    }
  }

  // --- 時效：已過期 / 太久沒複查 ---
  for (const item of activeItems) {
    if (item.expires_at && new Date(item.expires_at).getTime() < now) {
      findings.push({
        finding_id: `expired-${item.id}`,
        category: "時效",
        severity: "confirmed",
        message: `知識「${item.title}」已過期（expires_at=${item.expires_at}），仍是 active 狀態。`,
        evidence: { subject_type: "knowledge_item", subject_id: item.id, expires_at: item.expires_at },
      });
      continue;
    }
    const intervalDays = item.review_interval_days ?? DEFAULT_REVIEW_INTERVAL_DAYS;
    const daysSinceUpdate = (now - new Date(item.updated_at).getTime()) / MS_PER_DAY;
    if (daysSinceUpdate > intervalDays) {
      findings.push({
        finding_id: `stale-${item.id}`,
        category: "時效",
        severity: "needs_review",
        message: `知識「${item.title}」已經 ${Math.floor(daysSinceUpdate)} 天沒有更新（複查週期 ${intervalDays} 天），建議覆核是否仍正確。`,
        evidence: { subject_type: "knowledge_item", subject_id: item.id, days_since_update: Math.floor(daysSinceUpdate) },
      });
    }
  }

  // --- 來源已失效但仍被引用 ---
  for (const [key, count] of invalidSourceStillUsed) {
    const [subjectType, subjectId] = key.split(":");
    findings.push({
      finding_id: `invalid-source-used-${key}`,
      category: "來源",
      severity: "needs_review",
      message: `${subjectType === "knowledge_item" ? "知識" : "決策"}還有 ${count} 筆來源已失效（原訊息/記事/待辦/檔案已被刪除），內容摘要仍保留，建議確認是否仍可信。`,
      evidence: { subject_type: subjectType, subject_id: subjectId, invalid_source_count: count },
    });
  }

  // --- 重複標題（同一種類型、標題完全相同的 active 項目）---
  const titleSeen = new Map<string, string[]>();
  for (const item of activeItems) {
    const key = `knowledge_item:${item.title.trim()}`;
    titleSeen.set(key, [...(titleSeen.get(key) ?? []), item.id]);
  }
  for (const decision of activeDecisions) {
    const key = `decision:${decision.title.trim()}`;
    titleSeen.set(key, [...(titleSeen.get(key) ?? []), decision.id]);
  }
  for (const [key, ids] of titleSeen) {
    if (ids.length > 1) {
      const [subjectType, title] = key.split(":");
      findings.push({
        finding_id: `duplicate-title-${key}`,
        category: "重複",
        severity: "needs_review",
        message: `有 ${ids.length} 筆標題完全相同的「${title}」（${subjectType === "knowledge_item" ? "知識" : "決策"}），建議確認是否該合併。`,
        evidence: { subject_type: subjectType, ids },
      });
    }
  }

  // --- 矛盾：knowledge_links.relation='contradicts' 且 status='confirmed'，
  //     但兩端都還是 active，代表這個矛盾還沒有被解決 ---
  const activeItemIds = new Set(activeItems.map((i) => i.id));
  const activeDecisionIds = new Set(activeDecisions.map((d) => d.id));
  const isActive = (type: string, id: string) => (type === "knowledge_item" ? activeItemIds.has(id) : activeDecisionIds.has(id));

  for (const link of links) {
    if (link.relation !== "contradicts" || link.status !== "confirmed") continue;
    if (isActive(link.from_type, link.from_id) && isActive(link.to_type, link.to_id)) {
      findings.push({
        finding_id: `unresolved-contradiction-${link.id}`,
        category: "矛盾",
        severity: "confirmed",
        message: "有一對已確認為「矛盾」的知識/決策關聯，兩端目前都還是有效狀態，尚未解決。",
        evidence: { link_id: link.id, from: `${link.from_type}:${link.from_id}`, to: `${link.to_type}:${link.to_id}` },
      });
    }
  }

  // --- 待確認提案累積太久 ---
  const stalePending = proposals.filter(
    (p) => p.status === "pending" && (now - new Date(p.created_at).getTime()) / MS_PER_DAY > STALE_PROPOSAL_DAYS,
  );
  if (stalePending.length > 0) {
    findings.push({
      finding_id: "stale-pending-proposals",
      category: "提案",
      severity: "suggestion",
      message: `有 ${stalePending.length} 則知識提案已經待確認超過 ${STALE_PROPOSAL_DAYS} 天，建議去「共享知識」分頁確認或拒絕。`,
      evidence: { proposal_ids: stalePending.map((p) => p.id) },
    });
  }

  const stats = {
    knowledge_items_active: activeItems.length,
    knowledge_items_total: items.length,
    decisions_active: activeDecisions.length,
    decisions_total: decisions.length,
    links_confirmed: links.filter((l) => l.status === "confirmed").length,
    links_proposed: links.filter((l) => l.status === "proposed").length,
    sources_total: sources.length,
    sources_invalid: sources.filter((s) => s.status === "invalid").length,
    sources_verified: sources.filter((s) => s.verified).length,
    proposals_pending: proposals.filter((p) => p.status === "pending").length,
    findings_confirmed: findings.filter((f) => f.severity === "confirmed").length,
    findings_needs_review: findings.filter((f) => f.severity === "needs_review").length,
    findings_suggestion: findings.filter((f) => f.severity === "suggestion").length,
    // 項目 14：每張表實際掃描到的筆數與分頁數，讓報告本身就能證明「這次是真的掃完整張表」，
    // 不是被 PostgREST 的預設筆數上限悄悄截斷卻沒人發現。
    scan: scanStats,
  };

  const summary =
    findings.length === 0
      ? "沒有發現需要處理的問題。"
      : `發現 ${stats.findings_confirmed} 項已確認問題、${stats.findings_needs_review} 項待覆核、${stats.findings_suggestion} 項建議。`;

  const { data: report, error: insertErr } = await client
    .from("knowledge_audit_reports")
    .insert({ owner_id: ownerId, triggered_by: triggeredBy, summary, findings, stats })
    .select("id, run_at")
    .single();
  if (insertErr || !report) {
    console.error("寫入稽核報告失敗", insertErr);
    return { ok: false, status: 500, code: "report_save_failed", message: "稽核完成但報告儲存失敗，請稍後重試" };
  }

  return { ok: true, body: { reportId: report.id, runAt: report.run_at, summary, stats, findings } };
}
