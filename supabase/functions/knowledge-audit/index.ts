// knowledge-audit：借鏡 AI-Partner 的 /audit——依證據檢查共享知識系統，不是看知識筆數。
// 對應 docs/AI-Partner借鏡對照.md 第 5 項。
//
// 刻意用呼叫者自己的 JWT（supabaseAsUser），不用 service_role：RLS 天然把查詢範圍限制在
// 自己帳號名下，不需要額外的權限檢查邏輯，也不會有「稽核功能本身變成權限外洩管道」的風險。
// 可以手動觸發（前端按鈕）；要排程執行的話，見 README「共享知識系統」章節的
// pg_cron 設定方式——這個 PR 不會直接幫你在 Supabase 專案裡打開排程。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const DEFAULT_REVIEW_INTERVAL_DAYS = 180;
const STALE_PROPOSAL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type Severity = "confirmed" | "needs_review" | "suggestion";

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

    let triggeredBy = "manual";
    try {
      const body = await req.json();
      if (body?.triggeredBy === "schedule") triggeredBy = "schedule";
    } catch {
      // 沒有 body 也沒關係，預設 manual
    }

    const client = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const [itemsRes, decisionsRes, sourcesRes, linksRes, proposalsRes] = await Promise.all([
      client.from("knowledge_items").select("id, title, category, status, expires_at, review_interval_days, updated_at"),
      client.from("decisions").select("id, title, status, decided_at, updated_at"),
      client.from("knowledge_sources").select("id, subject_type, subject_id, status, verified"),
      client.from("knowledge_links").select("id, from_type, from_id, to_type, to_id, relation, status"),
      client.from("knowledge_proposals").select("id, proposal_type, status, created_at"),
    ]);

    const items = itemsRes.data ?? [];
    const decisions = decisionsRes.data ?? [];
    const sources = sourcesRes.data ?? [];
    const links = linksRes.data ?? [];
    const proposals = proposalsRes.data ?? [];

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
    const isActive = (type: string, id: string) =>
      type === "knowledge_item" ? activeItemIds.has(id) : activeDecisionIds.has(id);

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
    };

    const summary =
      findings.length === 0
        ? "沒有發現需要處理的問題。"
        : `發現 ${stats.findings_confirmed} 項已確認問題、${stats.findings_needs_review} 項待覆核、${stats.findings_suggestion} 項建議。`;

    const { data: report, error: insertErr } = await client
      .from("knowledge_audit_reports")
      .insert({ triggered_by: triggeredBy, summary, findings, stats })
      .select("id, run_at")
      .single();
    if (insertErr || !report) {
      console.error("寫入稽核報告失敗", insertErr);
      return jsonError("稽核完成但報告儲存失敗，請稍後重試", 500, "report_save_failed", headers);
    }

    return new Response(JSON.stringify({ ok: true, reportId: report.id, runAt: report.run_at, summary, stats, findings }), {
      headers,
    });
  } catch (err) {
    console.error("knowledge-audit 未預期錯誤", err);
    return jsonError("稽核時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});
