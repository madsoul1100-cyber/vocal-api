/**
 * Attachment Service
 * ==================
 *
 * Owns the lifecycle of ticket_attachments in our Supabase Storage bucket.
 * Replaces the old `telegram:<file_id>` pointer pattern with real,
 * fetchable storage paths.
 *
 * Two public flows:
 *   • downloadFromTelegramAndStore() — called from the citizen webhook
 *     when a ticket gets filed. Pulls the file from Telegram (24-hour
 *     URL via getFile API), uploads to our private bucket, returns the
 *     canonical storage path.
 *   • signedUrlFor() — called from the ticket detail page to render
 *     inline previews. Generates a short-lived signed URL the browser
 *     can fetch.
 *
 * Path convention:
 *   org/<org_id>/ticket/<ticket_id>/<uuid>.<ext>
 *
 * Fail-soft: callers should treat upload failures as soft (log it,
 * fall back to keeping the telegram: pointer so the audit row still
 * exists, and let the backfill script try again later).
 */

import { PutObjectCommand, S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import { isPostgresMode } from '@/lib/db.js'
import { resolveExistingLocalObjectPath } from '@/lib/postgresCompat/storage.js'
import crypto from 'node:crypto'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const TELEGRAM_API_BASE  = 'https://api.telegram.org'
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? ''
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN ?? ''
const TWILIO_DOWNLOAD_TIMEOUT_MS = 20_000

export const BUCKET_NAME = 'ticket-attachments'

// Per Telegram Bot API: a downloaded file URL is valid for ~60 minutes,
// then the bot must call getFile again. We don't cache these — every
// download call re-resolves.
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 20_000

// Signed URL TTL for ticket previews. 1 hour is a good balance — long
// enough for the user to scroll the page, short enough that leaked
// URLs expire quickly.
const SIGNED_URL_TTL_SECONDS = 60 * 60

/** Presigned PUT for dashboard direct-to-storage uploads (v2). */
export const TICKET_UPLOAD_URL_TTL_SECONDS = 15 * 60

export const TICKET_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

const ALLOWED_TICKET_UPLOAD_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'application/pdf',
])

function isS3Configured(): boolean {
  return !!(process.env.AWS_S3_BUCKET?.trim() && process.env.AWS_REGION?.trim())
}

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  })
}

/** DB value: `s3:<key>` when using AWS, else plain object key for Supabase/local. */
export function ticketAttachmentStorageRef(objectKey: string): string {
  return isS3Configured() ? `s3:${objectKey}` : objectKey
}

export function parseTicketAttachmentStorageRef(ref: string): {
  backend: 's3' | 'supabase'
  key: string
} {
  const trimmed = ref.trim()
  if (trimmed.startsWith('s3:')) return { backend: 's3', key: trimmed.slice(3) }
  return { backend: 'supabase', key: trimmed }
}

export function isAllowedTicketUploadMime(mime: string): boolean {
  return ALLOWED_TICKET_UPLOAD_MIMES.has(mime.trim().toLowerCase())
}

export function ticketUploadPathPrefix(orgId: string, ticketId: string): string {
  return `org/${orgId}/ticket/${ticketId}/`
}

/** Validates path returned from upload-url was issued for this org/ticket. */
export function isValidTicketAttachmentStoragePath(
  storagePath: string,
  orgId: string,
  ticketId: string,
): boolean {
  const { key } = parseTicketAttachmentStorageRef(storagePath)
  const prefix = ticketUploadPathPrefix(orgId, ticketId)
  if (!key.startsWith(prefix)) return false
  const tail = key.slice(prefix.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i.test(
    tail,
  )
}

export function ticketAttachmentStorageBackend(): 's3' | 'supabase' {
  return isS3Configured() ? 's3' : 'supabase'
}

/** RDS/local disk mode without S3 — previews are served via vocal-api media routes. */
export function usesLocalTicketAttachmentFiles(): boolean {
  return isPostgresMode() && !isS3Configured()
}

/** Path relative to `/v2` mount — e.g. `${VITE_API_BASE_URL}${path}` → `http://localhost:3001/v2/tickets/.../media`. */
export function ticketAttachmentMediaPath(ticketId: string, attachmentId: string): string {
  return `/tickets/${ticketId}/attachments/${attachmentId}/media`
}

export async function readTicketAttachmentObject(
  storagePath: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  if (storagePath.startsWith('telegram:') || storagePath.startsWith('twilio:')) return null

  const { backend, key } = parseTicketAttachmentStorageRef(storagePath)

  if (backend === 's3') {
    if (!isS3Configured()) return null
    try {
      const res = await s3Client().send(
        new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
      )
      const body = res.Body
      if (!body) return null
      const bytes = await body.transformToByteArray()
      return {
        data: Buffer.from(bytes),
        contentType: res.ContentType ?? 'application/octet-stream',
      }
    } catch {
      return null
    }
  }

  if (isS3Configured()) {
    try {
      await s3Client().send(
        new HeadObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
      )
      const res = await s3Client().send(
        new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
      )
      const body = res.Body
      if (!body) return null
      const bytes = await body.transformToByteArray()
      return {
        data: Buffer.from(bytes),
        contentType: res.ContentType ?? 'application/octet-stream',
      }
    } catch {
      /* fall through to local / supabase */
    }
  }

  const localFull = await resolveExistingLocalObjectPath(BUCKET_NAME, key)
  if (localFull) {
    const fs = await import('node:fs/promises')
    const data = await fs.readFile(localFull)
    const ext = key.split('.').pop()?.toLowerCase() ?? ''
    const mimeByExt: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      ogg: 'audio/ogg',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      pdf: 'application/pdf',
    }
    return { data, contentType: mimeByExt[ext] ?? 'application/octet-stream' }
  }

  try {
    const supabase = createSupabaseServiceClient()
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(key)
    if (error || !data) return null
    const buf = Buffer.from(await data.arrayBuffer())
    return { data: buf, contentType: data.type || 'application/octet-stream' }
  } catch {
    return null
  }
}

export interface TicketAttachmentUploadUrlResult {
  upload_url: string
  storage_path: string
  method: 'PUT'
  headers: Record<string, string>
  expires_in: number
  /** Browser PUT needs S3 bucket CORS — see cors_setup_doc. */
  cors_required?: boolean
  cors_setup_doc?: string
}

/**
 * Issue a presigned URL so the browser uploads directly to S3 or Supabase Storage.
 * Requires S3 env vars when DATABASE_URL is set (local disk cannot accept browser PUT).
 */
export async function createTicketAttachmentUploadUrl(args: {
  org_id: string
  ticket_id: string
  file_name: string
  mime_type: string
  file_size_bytes: number
}): Promise<TicketAttachmentUploadUrlResult | { error: string }> {
  const mime = args.mime_type.trim().toLowerCase()
  if (!isAllowedTicketUploadMime(mime)) {
    return { error: `File type not allowed: ${args.mime_type}` }
  }
  if (args.file_size_bytes < 1 || args.file_size_bytes > TICKET_UPLOAD_MAX_BYTES) {
    return {
      error: `file_size_bytes must be between 1 and ${TICKET_UPLOAD_MAX_BYTES}`,
    }
  }

  if (isPostgresMode() && !isS3Configured()) {
    return {
      error:
        'Direct upload requires AWS_S3_BUCKET and AWS_REGION when using DATABASE_URL. Configure S3 or use POST .../attachments multipart.',
    }
  }

  const objectKey = buildPath({ org_id: args.org_id, ticket_id: args.ticket_id, mime })
  const storage_path = ticketAttachmentStorageRef(objectKey)

  if (isS3Configured()) {
    try {
      const upload_url = await getSignedUrl(
        s3Client(),
        new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET!,
          Key: objectKey,
          ContentType: mime,
          ContentLength: args.file_size_bytes,
        }),
        { expiresIn: TICKET_UPLOAD_URL_TTL_SECONDS },
      )
      return {
        upload_url,
        storage_path,
        method: 'PUT',
        headers: { 'Content-Type': mime },
        expires_in: TICKET_UPLOAD_URL_TTL_SECONDS,
        cors_required: true,
        cors_setup_doc: 'docs/s3-cors-ticket-attachments.example.json',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Presigned upload URL failed'
      return { error: msg }
    }
  }

  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUploadUrl(objectKey, { upsert: false })

  if (error || !data?.signedUrl) {
    return { error: error?.message ?? 'Presigned upload URL failed' }
  }

  return {
    upload_url: data.signedUrl,
    storage_path,
    method: 'PUT',
    headers: { 'Content-Type': mime },
    expires_in: TICKET_UPLOAD_URL_TTL_SECONDS,
  }
}

/** Confirm the object exists before inserting ticket_attachments. */
export async function verifyTicketAttachmentObject(storagePath: string): Promise<boolean> {
  if (storagePath.startsWith('telegram:') || storagePath.startsWith('twilio:')) return false

  const { backend, key } = parseTicketAttachmentStorageRef(storagePath)

  if (backend === 's3') {
    if (!isS3Configured()) return false
    try {
      await s3Client().send(
        new HeadObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
      )
      return true
    } catch {
      return false
    }
  }

  try {
    const supabase = createSupabaseServiceClient()
    const { data, error } = await supabase.storage.from(BUCKET_NAME).download(key)
    return !error && !!data
  } catch {
    return false
  }
}

export interface StoredAttachment {
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  attachment_type: 'image' | 'video' | 'audio' | 'document' | 'other'
  /** The original Telegram file_id for audit / re-download. */
  telegram_file_id: string
}

// ─── Path + MIME helpers ─────────────────────────────────────────────────────

function attachmentTypeFromMime(mime: string | null | undefined): StoredAttachment['attachment_type'] {
  if (!mime) return 'other'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || mime.startsWith('application/')) return 'document'
  return 'other'
}

function extFromMime(mime: string | null | undefined): string {
  if (!mime) return 'bin'
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/gif':  'gif',
    'video/mp4':  'mp4',
    'video/quicktime': 'mov',
    'audio/ogg':  'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4':  'm4a',
    'application/pdf': 'pdf',
  }
  return map[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 6) ?? 'bin'
}

/**
 * Best-effort MIME inference when Telegram + the message struct don't
 * give us a usable one. Order of preference:
 *   1. The mime_hint we were given (from the caller — most reliable).
 *   2. The file extension Telegram returned on `file_path` (e.g. `.jpg`).
 *   3. Magic-bytes sniff on the first ~12 downloaded bytes.
 *   4. Give up — caller decides what to do (we never return octet-stream
 *      because the bucket allowlist rejects it).
 */
function inferMime(args: {
  hint: string | null | undefined
  telegramFilePath: string | null | undefined
  bytes: Buffer
}): string | null {
  // 1. Trust the hint if it's a real MIME (not the generic fallback).
  if (args.hint && args.hint !== 'application/octet-stream' && args.hint.includes('/')) {
    return args.hint
  }
  // 2. File extension from Telegram's `file_path`.
  if (args.telegramFilePath) {
    const ext = args.telegramFilePath.split('.').pop()?.toLowerCase() ?? ''
    const fromExt: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heic: 'image/heic', heif: 'image/heif',
      gif: 'image/gif',
      mp4: 'video/mp4', mov: 'video/quicktime',
      ogg: 'audio/ogg', oga: 'audio/ogg',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      pdf: 'application/pdf',
    }
    if (fromExt[ext]) return fromExt[ext]
  }
  // 3. Magic-bytes sniff.
  const b = args.bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)               return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 6 && b.toString('ascii', 0, 6) === 'GIF87a')                         return 'image/gif'
  if (b.length >= 6 && b.toString('ascii', 0, 6) === 'GIF89a')                         return 'image/gif'
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'
  return null
}

function buildPath(args: { org_id: string; ticket_id: string; mime: string | null | undefined }): string {
  const uuid = crypto.randomUUID()
  return `org/${args.org_id}/ticket/${args.ticket_id}/${uuid}.${extFromMime(args.mime)}`
}

// ─── Telegram → Supabase ─────────────────────────────────────────────────────

interface TelegramGetFileResult {
  ok: boolean
  result?: { file_path?: string; file_size?: number; file_unique_id?: string }
  description?: string
}

/**
 * Pulls a file from Telegram and uploads it to our private bucket. Returns
 * the canonical storage path and metadata, or null if anything goes wrong.
 * Never throws — the citizen webhook calls this fire-and-forget style.
 */
export async function downloadFromTelegramAndStore(args: {
  file_id: string
  org_id: string
  ticket_id: string
  mime_hint?: string | null
}): Promise<StoredAttachment | null> {
  const log = (msg: string, extra?: Record<string, unknown>) => {
    // Always log at error level so it surfaces in Vercel function logs and
    // we can diagnose silent upload failures.
    console.error(`[attachmentService] ${msg}`, JSON.stringify({
      file_id: args.file_id?.slice(0, 16) + '…',
      ticket_id: args.ticket_id,
      ...(extra ?? {}),
    }))
  }

  if (!TELEGRAM_BOT_TOKEN) {
    log('FAIL: TELEGRAM_BOT_TOKEN env var missing in runtime')
    return null
  }

  try {
    // 1. Resolve file_id → file_path via Telegram getFile.
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), TELEGRAM_DOWNLOAD_TIMEOUT_MS)
    const metaResp = await fetch(
      `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(args.file_id)}`,
      { signal: ctrl.signal },
    )
    clearTimeout(timeout)
    if (!metaResp.ok) {
      const body = await metaResp.text().catch(() => '')
      log('FAIL: Telegram getFile HTTP error', { status: metaResp.status, body: body.slice(0, 200) })
      return null
    }
    const metaJson = await metaResp.json() as TelegramGetFileResult
    if (!metaJson.ok || !metaJson.result?.file_path) {
      log('FAIL: Telegram getFile returned not-ok', { description: metaJson.description })
      return null
    }
    const filePath = metaJson.result.file_path
    const declaredSize = metaJson.result.file_size ?? null

    // 2. Download the bytes.
    const ctrl2 = new AbortController()
    const timeout2 = setTimeout(() => ctrl2.abort(), TELEGRAM_DOWNLOAD_TIMEOUT_MS)
    const fileResp = await fetch(
      `${TELEGRAM_API_BASE}/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`,
      { signal: ctrl2.signal },
    )
    clearTimeout(timeout2)
    if (!fileResp.ok) {
      log('FAIL: Telegram file download HTTP error', { status: fileResp.status, file_path: filePath })
      return null
    }
    const buffer = Buffer.from(await fileResp.arrayBuffer())
    const headerCt = fileResp.headers.get('content-type')

    // Resolve a MIME that the bucket will actually accept. Telegram's CDN
    // often returns 'application/octet-stream' for photos, and the message
    // struct for `photo` type has no mime_type field — so the hint can
    // also be null. inferMime walks: hint → Telegram file_path extension
    // → magic-bytes sniff.
    const resolved = inferMime({
      hint: args.mime_hint ?? (headerCt && headerCt !== 'application/octet-stream' ? headerCt : null),
      telegramFilePath: filePath,
      bytes: buffer,
    })
    if (!resolved) {
      log('FAIL: could not infer MIME', {
        hint: args.mime_hint,
        header_content_type: headerCt,
        telegram_file_path: filePath,
        first_bytes_hex: buffer.subarray(0, 8).toString('hex'),
      })
      return null
    }
    const mime = resolved

    // 3. Upload to Supabase Storage.
    const supabase = createSupabaseServiceClient()
    const storagePath = buildPath({ org_id: args.org_id, ticket_id: args.ticket_id, mime })
    const { error: upErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: mime,
        upsert: false,
      })
    if (upErr) {
      log('FAIL: Supabase Storage upload error', {
        bucket: BUCKET_NAME,
        path: storagePath,
        mime,
        size: buffer.length,
        error: upErr.message,
      })
      return null
    }

    log('OK: stored', { path: storagePath, size: buffer.length, mime })
    return {
      storage_path: storagePath,
      mime_type: mime,
      size_bytes: declaredSize ?? buffer.length,
      attachment_type: attachmentTypeFromMime(mime),
      telegram_file_id: args.file_id,
    }
  } catch (err) {
    log('FAIL: unexpected exception', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function downloadFromTwilioAndStore(args: {
  media_url: string
  org_id: string
  ticket_id: string
  mime_hint?: string | null
  message_sid?: string
}): Promise<StoredAttachment | null> {
  const log = (msg: string, extra?: Record<string, unknown>) => {
    console.error(`[attachmentService:twilio] ${msg}`, JSON.stringify({
      ticket_id: args.ticket_id,
      message_sid: args.message_sid,
      ...(extra ?? {}),
    }))
  }

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    log('FAIL: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing')
    return null
  }

  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), TWILIO_DOWNLOAD_TIMEOUT_MS)
    const fileResp = await fetch(args.media_url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: ctrl.signal,
    })
    clearTimeout(timeout)

    if (!fileResp.ok) {
      log('FAIL: Twilio media HTTP error', { status: fileResp.status })
      return null
    }

    const buffer = Buffer.from(await fileResp.arrayBuffer())
    const headerCt = fileResp.headers.get('content-type')
    const resolved = inferMime({
      hint: args.mime_hint ?? (headerCt && headerCt !== 'application/octet-stream' ? headerCt : null),
      telegramFilePath: null,
      bytes: buffer,
    })
    if (!resolved) {
      log('FAIL: could not infer MIME', { hint: args.mime_hint, headerCt })
      return null
    }

    const supabase = createSupabaseServiceClient()
    const storagePath = buildPath({ org_id: args.org_id, ticket_id: args.ticket_id, mime: resolved })
    const { error: upErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, { contentType: resolved, upsert: false })
    if (upErr) {
      log('FAIL: Supabase upload', { error: upErr.message })
      return null
    }

    log('OK: stored', { path: storagePath, size: buffer.length })
    return {
      storage_path: storagePath,
      mime_type: resolved,
      size_bytes: buffer.length,
      attachment_type: attachmentTypeFromMime(resolved),
      telegram_file_id: args.message_sid ?? '',
    }
  } catch (err) {
    log('FAIL: exception', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Worker-initiated upload — receives bytes already in memory (from the
 * dashboard's add-note form) and writes them to the bucket. Used by
 * `/api/tickets/notes/upload`. Returns null on any failure.
 */
export async function uploadWorkerAttachment(args: {
  bytes: Buffer | Uint8Array
  filename: string
  mime: string
  org_id: string
  ticket_id: string
}): Promise<StoredAttachment | null> {
  const log = (msg: string, extra?: Record<string, unknown>) => {
    console.error(`[attachmentService:worker] ${msg}`, JSON.stringify({
      filename: args.filename,
      ticket_id: args.ticket_id,
      ...(extra ?? {}),
    }))
  }
  try {
    const objectKey = buildPath({ org_id: args.org_id, ticket_id: args.ticket_id, mime: args.mime })
    const buffer = args.bytes instanceof Buffer ? args.bytes : Buffer.from(args.bytes)

    if (isS3Configured()) {
      await s3Client().send(
        new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET!,
          Key: objectKey,
          Body: buffer,
          ContentType: args.mime,
        }),
      )
      const storage_path = ticketAttachmentStorageRef(objectKey)
      log('OK: uploaded to S3', { path: storage_path, size: buffer.length })
      return {
        storage_path,
        mime_type: args.mime,
        size_bytes: buffer.length,
        attachment_type: attachmentTypeFromMime(args.mime),
        telegram_file_id: '',
      }
    }

    const supabase = createSupabaseServiceClient()
    const { error: upErr } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(objectKey, buffer, { contentType: args.mime, upsert: false })
    if (upErr) {
      log('FAIL: upload error', { error: upErr.message, mime: args.mime, size: buffer.length })
      return null
    }
    log('OK: uploaded', { path: objectKey, size: buffer.length })
    return {
      storage_path: objectKey,
      mime_type: args.mime,
      size_bytes: buffer.length,
      attachment_type: attachmentTypeFromMime(args.mime),
      telegram_file_id: '',
    }
  } catch (err) {
    log('FAIL: exception', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

// ─── Signed URL for previews ─────────────────────────────────────────────────

/**
 * Generates a short-lived signed URL for reading an attachment. Used by
 * the ticket detail page to render inline image previews.
 *
 * If `storage_path` still looks like an old `telegram:<file_id>` pointer
 * (pre-E1 migration), returns null so the caller can render a placeholder.
 */
async function tryS3PresignedGetUrl(objectKey: string): Promise<string | null> {
  if (!isS3Configured()) return null
  try {
    await s3Client().send(
      new HeadObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: objectKey }),
    )
    return await getSignedUrl(
      s3Client(),
      new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: objectKey }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    )
  } catch {
    return null
  }
}

export async function signedUrlFor(storagePath: string | null | undefined): Promise<string | null> {
  if (!storagePath) return null
  if (storagePath.startsWith('telegram:') || storagePath.startsWith('twilio:')) return null

  const { backend, key } = parseTicketAttachmentStorageRef(storagePath)

  // Prefer S3 when configured (DB paths may omit `s3:` prefix from older rows).
  if (backend === 's3' || isS3Configured()) {
    const s3Url = await tryS3PresignedGetUrl(key)
    if (s3Url) return s3Url
    if (backend === 's3') return null
  }

  if (usesLocalTicketAttachmentFiles()) {
    return null
  }

  try {
    const supabase = createSupabaseServiceClient()
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(key, SIGNED_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) {
      console.warn('[attachmentService] signed URL failed for', key, error?.message)
      return null
    }
    const url = data.signedUrl
    if (url.startsWith('file://')) {
      console.warn('[attachmentService] refusing file:// preview URL for', key)
      return null
    }
    return url
  } catch (err) {
    console.warn('[attachmentService] signed URL exception:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Batched version — generates signed URLs for many storage paths in one
 * pass. Useful for the ticket detail page rendering N attachments.
 */
export async function signedUrlsFor(storagePaths: Array<string | null | undefined>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    storagePaths.map(async p => {
      if (!p) return
      const url = await signedUrlFor(p)
      if (url) out[p] = url
    }),
  )
  return out
}
