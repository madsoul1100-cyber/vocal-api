import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT =
  process.env.ATTACHMENT_STORAGE_PATH ??
  path.join(process.cwd(), 'data', 'ticket-attachments')

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export function localStorageRoot(): string {
  return ROOT
}

/** Canonical write path (flat under ROOT). */
export function localStoragePath(bucket: string, objectPath: string): string {
  if (bucket === 'ticket-attachments') {
    return path.join(ROOT, objectPath)
  }
  return path.join(ROOT, bucket, objectPath)
}

/** Resolve an object that may exist under flat or legacy `ROOT/bucket/key` layout. */
export async function resolveExistingLocalObjectPath(
  bucket: string,
  objectPath: string,
): Promise<string | null> {
  const candidates =
    bucket === 'ticket-attachments'
      ? [path.join(ROOT, objectPath), path.join(ROOT, bucket, objectPath)]
      : [path.join(ROOT, bucket, objectPath), path.join(ROOT, objectPath)]
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

export class LocalStorageBucket {
  constructor(private bucket: string) {}

  async upload(
    objectPath: string,
    body: Buffer | Uint8Array,
    _opts?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string } | null }> {
    try {
      const full = localStoragePath(this.bucket, objectPath)
      await ensureDir(full)
      await fs.writeFile(full, body)
      return { error: null }
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : String(err) } }
    }
  }

  async createSignedUrl(
    objectPath: string,
    _expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
    const full = await resolveExistingLocalObjectPath(this.bucket, objectPath)
    if (!full) {
      return { error: { message: 'Object not found on disk' }, data: null }
    }
    // Browsers cannot load file:// from the web app — attachmentService uses HTTP media URLs instead.
    const signedUrl = `file://${full}`
    return { data: { signedUrl }, error: null }
  }
}

export class LocalStorageApi {
  from(bucket: string) {
    return new LocalStorageBucket(bucket)
  }
}
