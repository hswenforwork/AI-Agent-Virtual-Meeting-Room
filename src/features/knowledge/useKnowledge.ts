// 跨聊天室共享知識系統的前端資料層（docs/AI-Partner借鏡對照.md）。
// knowledge_items/decisions/knowledge_links/knowledge_proposals 都是 owner_id 直接 RLS，
// 跟 notes/tasks 的 useNotes.ts 同一種模式：前端直接用 supabase-js CRUD，不用另外開
// Edge Function；只有「確認/拒絕提案」（跨表操作）走 0019 migration 定義的 RPC，
// 「稽核」走 knowledge-audit Edge Function（用呼叫者自己的 JWT，見該檔案說明）。

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type {
  DecisionRow,
  KnowledgeAuditReportRow,
  KnowledgeCategory,
  KnowledgeItemRow,
  KnowledgeLinkRow,
  KnowledgeProposalRow,
  KnowledgeRelation,
} from "../../types/database";

function useRealtimeInvalidate(table: string, queryKey: string[]) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`${table}-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `owner_id=eq.${user.id}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, queryClient, table, queryKey.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------
// knowledge_items（共用背景）
// ---------------------------------------------------------------------------
export function useKnowledgeItems() {
  useRealtimeInvalidate("knowledge_items", ["knowledge_items"]);
  return useQuery({
    queryKey: ["knowledge_items"],
    queryFn: async (): Promise<KnowledgeItemRow[]> => {
      const { data, error } = await supabase
        .from("knowledge_items")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateKnowledgeItem() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      body: string;
      category: KnowledgeCategory;
      expiresAt?: string | null;
      reviewIntervalDays?: number | null;
      sourceRoomId?: string | null;
    }) => {
      const { data, error } = await supabase
        .from("knowledge_items")
        .insert({
          title: input.title,
          body: input.body,
          category: input.category,
          expires_at: input.expiresAt ?? null,
          review_interval_days: input.reviewIntervalDays ?? null,
          source_room_id: input.sourceRoomId ?? null,
          confirmed_by: user?.id,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as KnowledgeItemRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_items"] }),
  });
}

export function useUpdateKnowledgeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title, body }: { id: string; title: string; body: string }) => {
      const { error } = await supabase
        .from("knowledge_items")
        .update({ title, body, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_items"] }),
  });
}

export function useArchiveKnowledgeItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("knowledge_items").update({ status: "archived" }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_items"] }),
  });
}

// ---------------------------------------------------------------------------
// decisions（決策紀錄，取代用 supersedesId，DB trigger 自動處理舊版狀態）
// ---------------------------------------------------------------------------
export function useDecisions() {
  useRealtimeInvalidate("decisions", ["decisions"]);
  return useQuery({
    queryKey: ["decisions"],
    queryFn: async (): Promise<DecisionRow[]> => {
      const { data, error } = await supabase.from("decisions").select("*").order("decided_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateDecision() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      title: string;
      decisionText: string;
      reasoning: string;
      alternatives?: string;
      supersedesId?: string | null;
      sourceRoomId?: string | null;
    }) => {
      const { data, error } = await supabase
        .from("decisions")
        .insert({
          title: input.title,
          decision_text: input.decisionText,
          reasoning: input.reasoning,
          alternatives: input.alternatives ?? null,
          supersedes_id: input.supersedesId ?? null,
          source_room_id: input.sourceRoomId ?? null,
          created_by: user?.id,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as DecisionRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["decisions"] }),
  });
}

// ---------------------------------------------------------------------------
// knowledge_sources（來源，附加在知識/決策上）
// ---------------------------------------------------------------------------
export function useAddKnowledgeSource() {
  return useMutation({
    mutationFn: async (input: {
      subjectType: "knowledge_item" | "decision";
      subjectId: string;
      sourceType: "message" | "note" | "task" | "file" | "external_url";
      roomId?: string | null;
      messageId?: string | null;
      noteId?: string | null;
      taskId?: string | null;
      fileId?: string | null;
      externalUrl?: string | null;
      verified: boolean;
      contentSnapshot?: string | null;
    }) => {
      const { error } = await supabase.from("knowledge_sources").insert({
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        source_type: input.sourceType,
        room_id: input.roomId ?? null,
        message_id: input.messageId ?? null,
        note_id: input.noteId ?? null,
        task_id: input.taskId ?? null,
        file_id: input.fileId ?? null,
        external_url: input.externalUrl ?? null,
        verified: input.verified,
        content_snapshot: input.contentSnapshot ?? null,
      });
      if (error) throw error;
    },
  });
}

export function useKnowledgeSources(subjectType: "knowledge_item" | "decision", subjectId: string | null) {
  return useQuery({
    queryKey: ["knowledge_sources", subjectType, subjectId],
    enabled: !!subjectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("knowledge_sources")
        .select("*")
        .eq("subject_type", subjectType)
        .eq("subject_id", subjectId as string)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ---------------------------------------------------------------------------
// knowledge_links（知識關聯圖）
// ---------------------------------------------------------------------------
export function useKnowledgeLinks() {
  useRealtimeInvalidate("knowledge_links", ["knowledge_links"]);
  return useQuery({
    queryKey: ["knowledge_links"],
    queryFn: async (): Promise<KnowledgeLinkRow[]> => {
      const { data, error } = await supabase.from("knowledge_links").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateKnowledgeLink() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      fromType: "knowledge_item" | "decision";
      fromId: string;
      toType: "knowledge_item" | "decision";
      toId: string;
      relation: KnowledgeRelation;
      reasoning?: string;
    }) => {
      const { error } = await supabase.from("knowledge_links").insert({
        from_type: input.fromType,
        from_id: input.fromId,
        to_type: input.toType,
        to_id: input.toId,
        relation: input.relation,
        status: "confirmed",
        reasoning: input.reasoning ?? null,
        created_by: user?.id,
        confirmed_by: user?.id,
        confirmed_at: new Date().toISOString(),
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_links"] }),
  });
}

// ---------------------------------------------------------------------------
// knowledge_proposals（代理提案，確認/拒絕走 RPC）
// ---------------------------------------------------------------------------
export function useKnowledgeProposals() {
  useRealtimeInvalidate("knowledge_proposals", ["knowledge_proposals"]);
  return useQuery({
    queryKey: ["knowledge_proposals"],
    queryFn: async (): Promise<KnowledgeProposalRow[]> => {
      const { data, error } = await supabase
        .from("knowledge_proposals")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAcceptProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ proposalId, edits }: { proposalId: string; edits?: Record<string, unknown> }) => {
      const { data, error } = await supabase.rpc("accept_knowledge_proposal", {
        proposal_id: proposalId,
        edits: edits ?? {},
      });
      if (error) throw error;
      return data as { table: string; id: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge_proposals"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge_items"] });
      queryClient.invalidateQueries({ queryKey: ["decisions"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge_links"] });
    },
  });
}

export function useRejectProposal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ proposalId, note }: { proposalId: string; note?: string }) => {
      const { error } = await supabase.rpc("reject_knowledge_proposal", { proposal_id: proposalId, note: note ?? null });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_proposals"] }),
  });
}

// ---------------------------------------------------------------------------
// 稽核（knowledge-audit Edge Function）
// ---------------------------------------------------------------------------
export function useKnowledgeAuditReports() {
  return useQuery({
    queryKey: ["knowledge_audit_reports"],
    queryFn: async (): Promise<KnowledgeAuditReportRow[]> => {
      const { data, error } = await supabase
        .from("knowledge_audit_reports")
        .select("*")
        .order("run_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRunKnowledgeAudit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("knowledge-audit", { body: { triggeredBy: "manual" } });
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge_audit_reports"] }),
  });
}
