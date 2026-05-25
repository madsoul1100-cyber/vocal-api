/**
 * Staff profile photo + KYC document storage.
 * Uses AWS S3 when configured; otherwise Supabase Storage bucket `staff-documents`.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_STAFF_PROFILE_STORAGE_PATH,
  isDefaultStaffProfilePath,
} from '@/constants/staffProfileDefaults.js'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { localStoragePath } from '@/lib/postgresCompat/storage.js'
import { createSupabaseServiceClient } from '@/lib/supabase.js'
import {
  STAFF_KYC_FILE_MAX_BYTES,
  STAFF_PROFILE_IMAGE_MAX_BYTES,
  type StaffKycDocument,
} from '@/types/staffDocuments.js'

const SUPABASE_BUCKET = process.env.STAFF_STORAGE_BUCKET ?? 'staff-documents'
const SIGNED_URL_TTL_SECONDS = 60 * 60

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
])

const KYC_MIMES = new Set([
  ...IMAGE_MIMES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  }
  return map[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) ?? 'bin'
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file'
}

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

function buildObjectKey(
  orgId: string,
  kind: 'profile' | 'kyc',
  mime: string,
  originalName: string,
): string {
  const uuid = crypto.randomUUID()
  const ext = extFromMime(mime)
  const safe = sanitizeFilename(originalName)
  return `org/${orgId}/staff/${kind}/${uuid}.${ext}--${safe}`
}

async function uploadToS3(
  key: string,
  body: Buffer,
  mime: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bucket = process.env.AWS_S3_BUCKET!
  try {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: mime,
      }),
    )
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'S3 upload failed'
    return { ok: false, error: msg }
  }
}

async function uploadToSupabase(
  path: string,
  body: Buffer,
  mime: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = createSupabaseServiceClient()
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, body, {
    contentType: mime,
    upsert: false,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/** Storage key prefix: `s3:` for AWS, plain path for Supabase bucket. */
export function storageRef(key: string): string {
  return isS3Configured() ? `s3:${key}` : key
}

/** Normalize DB paths so S3-backed refs always include the `s3:` prefix. */
export function normalizeStaffStorageRef(ref: string): string {
  const trimmed = ref.trim()
  if (!trimmed) return storageRef(DEFAULT_STAFF_PROFILE_STORAGE_PATH)
  if (trimmed.startsWith('s3:')) return trimmed
  if (isS3Configured()) return `s3:${trimmed}`
  return trimmed
}

export function resolveStaffProfileStoragePath(imageUrl: string | null | undefined): string {
  const trimmed = typeof imageUrl === 'string' ? imageUrl.trim() : ''
  return normalizeStaffStorageRef(trimmed || DEFAULT_STAFF_PROFILE_STORAGE_PATH)
}

function parseStorageRef(ref: string): { backend: 's3' | 'supabase'; key: string } {
  const normalized = normalizeStaffStorageRef(ref)
  if (normalized.startsWith('s3:')) return { backend: 's3', key: normalized.slice(3) }
  return { backend: 'supabase', key: normalized }
}

export async function uploadStaffProfileImage(args: {
  orgId: string
  buffer: Buffer
  mime: string
  originalName: string
}): Promise<{ storage_path: string } | { error: string }> {
  if (!IMAGE_MIMES.has(args.mime)) {
    return { error: 'Profile image must be JPEG, PNG, or WebP' }
  }
  if (args.buffer.length > STAFF_PROFILE_IMAGE_MAX_BYTES) {
    return { error: 'Profile image must be under 5 MB' }
  }

  const key = buildObjectKey(args.orgId, 'profile', args.mime, args.originalName)
  const up = isS3Configured()
    ? await uploadToS3(key, args.buffer, args.mime)
    : await uploadToSupabase(key, args.buffer, args.mime)
  if (!up.ok) return { error: up.error }
  return { storage_path: storageRef(key) }
}

export async function uploadStaffKycDocument(args: {
  orgId: string
  buffer: Buffer
  mime: string
  originalName: string
}): Promise<StaffKycDocument | { error: string }> {
  let mime = args.mime === 'application/octet-stream' ? 'application/pdf' : args.mime
  const lowerName = args.originalName.toLowerCase()
  if (mime === 'application/octet-stream') {
    if (lowerName.endsWith('.pdf')) mime = 'application/pdf'
    else if (lowerName.endsWith('.doc')) mime = 'application/msword'
    else if (lowerName.endsWith('.docx')) {
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }
  }
  if (!KYC_MIMES.has(mime)) {
    return { error: `File type not allowed: ${args.mime}. Use PDF, Word, or images.` }
  }
  if (args.buffer.length > STAFF_KYC_FILE_MAX_BYTES) {
    return { error: 'Each KYC document must be under 10 MB' }
  }

  const key = buildObjectKey(args.orgId, 'kyc', mime, args.originalName)
  const up = isS3Configured()
    ? await uploadToS3(key, args.buffer, mime)
    : await uploadToSupabase(key, args.buffer, mime)
  if (!up.ok) return { error: up.error }

  return {
    storage_path: storageRef(key),
    file_name: args.originalName,
    mime_type: mime,
    size_bytes: args.buffer.length,
    uploaded_at: new Date().toISOString(),
  }
}

const DEFAULT_PROFILE_ASSET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../assets/default-staff-profile.png',
)

/** Upload the bundled placeholder PNG if it is not already in storage. */
export async function ensureDefaultStaffProfileAsset(): Promise<
  { ok: true; storage_path: string } | { ok: false; error: string }
> {
  const key = DEFAULT_STAFF_PROFILE_STORAGE_PATH
  const storage_path = storageRef(key)
  const existing = await readStaffStorageObject(storage_path)
  if (existing) return { ok: true, storage_path }

  let buffer: Buffer
  try {
    buffer = await fs.readFile(DEFAULT_PROFILE_ASSET)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not read default profile asset'
    return { ok: false, error: msg }
  }

  const up = isS3Configured()
    ? await uploadToS3(key, buffer, 'image/png')
    : await uploadToSupabase(key, buffer, 'image/png')
  if (!up.ok) return { ok: false, error: up.error }
  return { ok: true, storage_path }
}

export async function signedUrlForStaffStorage(
  storagePath: string | null | undefined,
): Promise<string | null> {
  if (!storagePath) return null
  const { backend, key } = parseStorageRef(normalizeStaffStorageRef(storagePath))

  if (backend === 's3') {
    if (!isS3Configured()) return null
    try {
      return await getSignedUrl(
        s3Client(),
        new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
        { expiresIn: SIGNED_URL_TTL_SECONDS },
      )
    } catch {
      return null
    }
  }

  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(key, SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) return null
  return data.signedUrl
}

export function staffStorageBackend(): 's3' | 'supabase' {
  return isS3Configured() ? 's3' : 'supabase'
}

/** Read object bytes for API streaming (local bucket or S3). */
export async function readStaffStorageObject(
  storagePath: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  const { backend, key } = parseStorageRef(normalizeStaffStorageRef(storagePath))

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

  try {
    const full = localStoragePath(SUPABASE_BUCKET, key)
    const data = await fs.readFile(full)
    const ext = key.split('.').pop()?.split('--')[0]?.toLowerCase() ?? ''
    const mimeByExt: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      pdf: 'application/pdf',
    }
    return { data, contentType: mimeByExt[ext] ?? 'application/octet-stream' }
  } catch {
    const supabase = createSupabaseServiceClient()
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(key)
    if (error || !data) return null
    const buf = Buffer.from(await data.arrayBuffer())
    return { data: buf, contentType: data.type || 'application/octet-stream' }
  }
}

export async function enrichStaffMediaUrls<T extends {
  image_url: string | null
  kyc_documents: StaffKycDocument[]
}>(row: T): Promise<
  T & {
    profile_image_url: string | null
    kyc_documents: (StaffKycDocument & { download_url: string | null })[]
  }
> {
  const profilePath = resolveStaffProfileStoragePath(row.image_url)
  if (isDefaultStaffProfilePath(profilePath)) {
    await ensureDefaultStaffProfileAsset()
  }
  const profile_image_url = await signedUrlForStaffStorage(profilePath)
  const kyc_documents = await Promise.all(
    row.kyc_documents.map(async (doc) => ({
      ...doc,
      download_url: await signedUrlForStaffStorage(doc.storage_path),
    })),
  )
  return { ...row, profile_image_url, kyc_documents }
}
