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

    // D 階段項目 11 修正（檔案登記核對）：到這裡為止的所有檢查（10MB 上限、MIME 類型、
    // 房間權限）都只驗證了「使用者這次請求宣稱的中繼資料」，從來沒有跟 Storage 裡
    // 真正上傳的物件核對過——bucket 本身在這次修正前也完全沒有設定任何限制
    // （見 migrations/0027_file_storage_lifecycle.sql），前端可以直接呼叫 Storage API
    // 上傳任意大小、任意類型的檔案，這裡只是照抄一份使用者自己填的數字寫進 files 表。
    // 用 Storage 自己記錄的物件中繼資料（真正收到的位元組數、上傳當下的 Content-Type）
    // 取代使用者宣稱的值，同一個 10MB／白名單檢查用真實資料再核對一次；物件根本不存在
    // （例如前端上傳失敗卻還是呼叫了這支函式、或 objectPath 打錯）也要直接拒絕，不能
    // 登記一筆「查無實體」的檔案紀錄。
    const verified = await verifyUploadedObject(admin, "room-files", objectPath);
    if (!verified) {
      return jsonError("找不到剛剛上傳的檔案，請重新上傳一次", 400, "object_not_found", headers);
    }
    if (verified.size > MAX_SIZE_BYTES) {
      return jsonError("檔案超過 10MB 上限", 400, "file_too_large", headers);
    }
    if (!ALLOWED_MIME_TYPES.has(verified.mimeType)) {
      return jsonError("不支援的檔案類型", 400, "unsupported_mime_type", headers);
    }

    // PR #49 審閱意見（項目 11 補強）：到這裡只驗證了「房間成員」跟「物件真的存在」，
    // 完全沒確認呼叫者是不是這個物件真正的上傳者——同一個房間的成員 A 可以拿房間成員
    // B 已經上傳的 object_path 呼叫這支函式，把 B 的檔案登記成「A 的檔案」。
    // storage.objects.owner 是 Storage 在上傳當下依 room_files_insert_member policy
    // 的 with check owner = auth.uid() 設定的，之後沒有任何流程會改它，是唯一可信的
    // 「這個物件真正是誰上傳的」依據。用 service_role-only 的
    // room_files_storage_object_owner() 讀出來核對，不等於呼叫者就直接拒絕，不能讓
    // 別人的上傳被冒名登記。
    const uploaderId = await getStorageObjectOwner(admin, "room-files", objectPath);
    if (!uploaderId) {
      return jsonError("找不到這個物件的上傳者紀錄，請重新上傳一次", 400, "object_owner_unknown", headers);
    }
    if (uploaderId !== user.id) {
      return jsonError("這個檔案不是由你上傳的，無法登記為你的檔案", 403, "not_uploader", headers);
    }

    // 用 admin（service_role）client 寫入，沒有 auth.uid() context，owner_id（記事本/待辦/
    // 檔案夾真正的歸屬，brainstorms/2026-09-23-gpt-audit-followups.md Q1）要自己明確帶。
    // mime_type／size_bytes 一律用上面核對過的真實值，不是請求 body 裡使用者自己填的值。
    const { data: file, error: insertErr } = await admin
      .from("files")
      .insert({
        room_id: roomId,
        owner_id: user.id,
        bucket: "room-files",
        object_path: objectPath,
        name,
        mime_type: verified.mimeType,
        size_bytes: verified.size,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr) {
      // PR #49 審閱意見：files(bucket, object_path) 現在有唯一約束（見
      // migrations/0027_file_storage_lifecycle.sql）——同一個路徑被登記第二次時，
      // Postgres 回傳 23505 unique_violation。上面的上傳者核對已經先擋掉「別人的
      // 物件」，這裡剩下的合理情境只有「同一個上傳者自己重試」（例如網路逾時、前端
      // 重複點擊），查出既有那一筆、owner_id 確實是自己就直接回傳既有 id 當冪等
      // 成功；owner_id 不是自己（理論上不該發生，上傳者核對已經擋過一次，這裡是
      // 第二層防禦）就明確回報衝突，不能讓其中一筆變成看不見的殭屍資料。
      if (insertErr.code === "23505") {
        const { data: existing } = await admin
          .from("files")
          .select("id, owner_id")
          .eq("bucket", "room-files")
          .eq("object_path", objectPath)
          .maybeSingle();
        if (existing && existing.owner_id === user.id) {
          return new Response(JSON.stringify({ fileId: existing.id }), { headers });
        }
        console.error("檔案路徑重複登記，且擁有者不是這次呼叫者", objectPath, existing);
        return jsonError("這個檔案路徑已經被登記過", 409, "already_registered", headers);
      }
      console.error("登記檔案失敗", insertErr);
      return jsonError("登記檔案失敗，請稍後重試", 500, "internal_error", headers);
    }
    if (!file) {
      console.error("登記檔案失敗：insert 沒有回傳任何錯誤，但也沒有資料");
      return jsonError("登記檔案失敗，請稍後重試", 500, "internal_error", headers);
    }

    if (TEXT_EXTRACTABLE_MIME_TYPES.has(verified.mimeType)) {
      await extractTextChunks(admin, file.id, roomId, objectPath, verified.mimeType);
    }

    return new Response(JSON.stringify({ fileId: file.id }), { headers });
  } catch (err) {
    console.error("file-register 未預期錯誤", err);
    return jsonError("系統暫時發生錯誤，請稍後重試", 500, "internal_error", headers);
  }
});

interface VerifiedObject {
  size: number;
  mimeType: string;
}

// D 階段項目 11 修正：用 Storage 的 list() API 讀出物件在上傳當下真正被記錄的中繼資料
// （size／mimetype，Storage 服務自己從實際收到的位元組數與上傳請求的 Content-Type
// 記下來的，不是我們自己維護的資料），核對這支函式收到的請求宣不宣稱都不重要，這是
// 唯一可信的來源。用 list() 而不是 download()：只需要中繼資料就能核對完 10MB／MIME
// 類型限制，不需要真的把檔案內容整個下載下來，省流量也省時間。
async function verifyUploadedObject(
  admin: ReturnType<typeof supabaseAdmin>,
  bucket: string,
  objectPath: string,
): Promise<VerifiedObject | null> {
  const lastSlash = objectPath.lastIndexOf("/");
  const dirPath = lastSlash === -1 ? "" : objectPath.slice(0, lastSlash);
  const fileName = lastSlash === -1 ? objectPath : objectPath.slice(lastSlash + 1);

  const { data: entries, error } = await admin.storage.from(bucket).list(dirPath, {
    search: fileName,
    limit: 1,
  });
  if (error) {
    console.error("讀取 Storage 物件中繼資料失敗", bucket, objectPath, error);
    return null;
  }
  const entry = entries?.find((e) => e.name === fileName);
  if (!entry || !entry.metadata) return null;

  const size = Number(entry.metadata.size);
  const mimeType = String(entry.metadata.mimetype ?? "");
  if (!Number.isFinite(size) || !mimeType) return null;

  return { size, mimeType };
}

// PR #49 審閱意見（項目 11 補強）：呼叫 migrations/0027_file_storage_lifecycle.sql
// 新增的 service_role-only RPC，讀出這個物件當初上傳時 Storage 記下的真正 owner
// （storage.objects.owner）。刻意不用一般查詢（例如直接 select storage.objects），
// 因為 admin client 雖然是 service_role、本來就能繞過 RLS 直接查，但這裡改用專用
// 函式是為了讓「誰能讀到物件上傳者」這件事的權限邊界集中定義在資料庫層（跟
// verifyUploadedObject() 用 Storage API 而不是直查 storage.objects 是同樣的分層
// 考量）。RPC 呼叫失敗（含查無此物件）一律回傳 null，呼叫端會直接拒絕登記，不會
// 誤判成「驗證通過」。
async function getStorageObjectOwner(
  admin: ReturnType<typeof supabaseAdmin>,
  bucket: string,
  objectPath: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("room_files_storage_object_owner", {
    p_bucket: bucket,
    p_object_path: objectPath,
  });
  if (error) {
    console.error("查詢 Storage 物件上傳者失敗", bucket, objectPath, error);
    return null;
  }
  return typeof data === "string" && data.length > 0 ? data : null;
}

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
