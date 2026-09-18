// file-register：使用者已將檔案上傳到 Storage 後呼叫，驗證檔案、登記中繼資料，
// 並在檔案是文字類型時立即擷取文字，供之後當作多供應商的共享上下文（Q10）。

import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { jsonError } from "../_shared/errors.ts";
import { supabaseAdmin, supabaseAsUser } from "../_shared/supabaseAdmin.ts";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB，對應原始規劃文件 7.5 節
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// MVP 只對純文字類型做擷取；PDF/DOCX/XLSX 先只存檔案本身，之後再補格式解析。
const TEXT_EXTRACTABLE_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const CHUNK_SIZE = 2000;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  const headers = { ...corsHeaders(req.headers.get("origin")), "content-type": "application/json" };

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonError("未登入", 401, "unauthenticated");

    const { roomId, objectPath, name, mimeType, sizeBytes } = await req.json();
    if (!roomId || !objectPath || !name || !mimeType || typeof sizeBytes !== "number") {
      return jsonError("參數不正確", 400);
    }

    if (sizeBytes > MAX_SIZE_BYTES) {
      return jsonError("檔案超過 10MB 上限", 400, "file_too_large");
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return jsonError("不支援的檔案類型", 400, "unsupported_mime_type");
    }
    if (!objectPath.startsWith(`${roomId}/`)) {
      return jsonError("檔案路徑不正確", 400, "invalid_path");
    }

    const userClient = supabaseAsUser(authHeader);
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) return jsonError("登入已過期，請重新登入", 401, "unauthenticated");

    const admin = supabaseAdmin();

    const { data: membership } = await admin
      .from("room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return jsonError("您沒有這個房間的權限", 403, "forbidden");

    const { data: file, error: insertErr } = await admin
      .from("files")
      .insert({
        room_id: roomId,
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
      return jsonError("登記檔案失敗，請稍後重試", 500, "internal_error");
    }

    if (TEXT_EXTRACTABLE_MIME_TYPES.has(mimeType)) {
      await extractTextChunks(admin, file.id, roomId, objectPath);
    }

    return new Response(JSON.stringify({ fileId: file.id }), { headers });
  } catch (err) {
    console.error("file-register 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error");
  }
});

async function extractTextChunks(
  admin: ReturnType<typeof supabaseAdmin>,
  fileId: string,
  roomId: string,
  objectPath: string,
) {
  const { data: blob, error } = await admin.storage.from("room-files").download(objectPath);
  if (error || !blob) {
    console.error("下載檔案以擷取文字失敗", roomId, objectPath, error);
    return;
  }

  const text = await blob.text();
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
