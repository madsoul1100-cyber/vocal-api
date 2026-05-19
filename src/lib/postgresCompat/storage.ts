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

export function localStoragePath(bucket: string, objectPath: string): string {
  return path.join(ROOT, bucket, objectPath)
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
    try {
      const full = localStoragePath(this.bucket, objectPath)
      await fs.access(full)
      // Local dev: serve via file URL; production should use S3 + presigned URLs.
      const signedUrl = `file://${full}`
      return { data: { signedUrl }, error: null }
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : String(err) }, data: null }
    }
  }
}

export class LocalStorageApi {
  from(bucket: string) {
    return new LocalStorageBucket(bucket)
  }
}
