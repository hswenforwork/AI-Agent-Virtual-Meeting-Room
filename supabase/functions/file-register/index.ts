// file-register：使用者已將檔案上傳到 Storage 後呼叫，驗證檔案、登記中繼資料，
// 並在檔案是文字類型時立即擷取文字，供之後當作多供應商的共享上下文（Q10）。
// brainstorms/2026-09-23-gpt-audit-followups.md Q14/Q16：PDF 改走三家供應商各自的原生
// 文件輸入（見 agent-run/workspaceContext.ts），不在這裡處理；DOCX/XLSX 用解析庫在這裡
// 就地擷取成純文字，沿用跟 txt/md/csv 一樣的 file_text_chunks 流程。

import mammoth from "npm:mammoth@1.9.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB，對應原始規劃文件 7.5 節
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
]);

// PDF 不在這裡擷取（走原生文件輸入，見上方說明）；其餘都能擷取成純文字。
const TEXT_EXTRACTABLE_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/csv", DOCX_MIME_TYPE, XLSX_MIME_TYPE]);
const CHUNK_SIZE = 2000;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated", headers);

    const { roomId, objectPath, name, mimeType, sizeBytes } = await req.json();
    if (!roomId || !objectPath || !name || !mimeType || typeof sizeBytes !== "number") {
      return jsonError("參數不正確", 400, headers);
    }

    if (sizeBytes > MAX_SIZE_BYTES) {
      return jsonError("檔案超過 10MB 上限", 400, "file_too_large", headers);
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return jsonError("不支援的檔案類型", 400, "unsupported_mime_type", headers);
    }
    if (!objectPath.startsWith(`${roomId}/`)) {
      return jsonError("檔案路徑不正確", 400, "invalid_path", headers);
    }

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated", headers);

    const admin = supabaseAdmin();

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden", headers);

    // 用 admin（service_role）client 寫入，沒有 auth.uid() context，owner_id（記事本/待辦/
    // 檔案夾真正的歸屬，brainstorms/2026-09-23-gpt-audit-followups.md Q1）要自己明確帶。
    const { data: file, error: insertErr } = await admin
      .from("files")
      .insert({
        room_id: roomId,
        owner_id: user.id,
        bucket: "room-files",
        object_path: objectPath,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr || !file) {
      console.error("登記檔案失敗", insertErr);
      return jsonError("登記檔案失敗，請稍後重試", 500, "internal_error", headers);
    }

    if (TEXT_EXTRACTABLE_MIME_TYPES.has(mimeType)) {
      await extractTextChunks(admin, file.id, roomId, objectPath, mimeType);
    }

    return new Response(JSON.stringify({ fileId: file.id }), { headers });
  } catch (err) {
    console.error("file-register 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});

// DOCX 用 mammoth 擷取純文字（表格/樣式都不保留，只要文字內容）；XLSX 用 xlsx（SheetJS）
// 把每個工作表轉成 CSV 文字後串接——都只需要「讓 AI 讀得到內容」，不需要保留原始格式。
async function extractPlainText(blob: Blob, mimeType: string): Promise<string> {
  if (mimeType === DOCX_MIME_TYPE) {
    const arrayBuffer = await blob.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }
  if (mimeType === XLSX_MIME_TYPE) {
    const arrayBuffer = await blob.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    return workbook.SheetNames.map((sheetName: string) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      return `【工作表：${sheetName}】\n${csv}`;
    }).join("\n\n");
  }
  return await blob.text();
}

async function extractTextChunks(
  admin: ReturnType<typeof supabaseAdmin>,
  fileId: string,
  roomId: string,
  objectPath: string,
  mimeType: string,
) {
  const { data: blob, error } = await admin.storage.from("room-files").download(objectPath);
  if (error || !blob) {
    console.error("下載檔案以擷取文字失敗", roomId, objectPath, error);
    return;
  }

  let text: string;
  try {
    text = await extractPlainText(blob, mimeType);
  } catch (err) {
    console.error("解析檔案文字失敗", roomId, objectPath, mimeType, err);
    return;
  }

  const chunks: { file_id: string; chunk_no: number; content: string; token_count: number }[] = [];
  for (let i = 0, chunkNo = 0; i < text.length; i += CHUNK_SIZE, chunkNo++) {
    const content = text.slice(i, i + CHUNK_SIZE);
    chunks.push({
      file_id: fileId,
      chunk_no: chunkNo,
      content,
      token_count: Math.ceil(content.length / 4),
    });
  }

  if (chunks.length > 0) {
    await admin.from("file_text_chunks").insert(chunks);
  }
}
