# S3 CORS for presigned uploads (browser / Flutter web)

Presigned `PUT` uploads (ticket attachments **and** staff profile / KYC) go **directly from the browser to S3**. The API CORS settings do **not** apply to that request — the **S3 bucket** must allow your app origin.

## Symptoms

- `Access to XMLHttpRequest at 'https://<bucket>.s3...amazonaws.com/...' from origin 'http://localhost:61836' has been blocked by CORS policy`
- Upload fails after `POST .../attachments/upload-url` succeeds

## Fix (AWS Console)

1. Open **S3** → bucket `local007` (or your `AWS_S3_BUCKET`).
2. **Permissions** → **Cross-origin resource sharing (CORS)** → Edit.
3. Paste the rules from [`s3-cors-ticket-attachments.example.json`](./s3-cors-ticket-attachments.example.json).
4. Add every origin you use (Flutter web port, Vercel URL, etc.) under `AllowedOrigins`.
5. Save.

## Fix (AWS CLI)

```bash
aws s3api put-bucket-cors \
  --bucket local007 \
  --cors-configuration file://docs/s3-cors-ticket-attachments.example.json
```

Adjust `AllowedOrigins` for extra dev ports or preview URLs. The example includes:

- **Production:** `https://nyleader.vercel.app` ([Naa Neta](https://nyleader.vercel.app))
- **Local Flutter web:** `http://localhost:49807`, `http://localhost:61836`, etc.

If you add a Vercel preview deployment (`https://*.vercel.app`), either list each URL or use a separate CORS rule (S3 does not support wildcard subdomains in `AllowedOrigins`).

## Preview images (`file://` in Flutter)

Do **not** use `file://` URLs in `Image.network`. With S3 configured, `GET .../attachments` should return **https://...s3...** `preview_url` values (signed GET).

If you still see `file://`, restart vocal-api and reload attachments — older API versions returned local disk URLs.

For local dev **without** S3, `preview_url` is `/tickets/:id/attachments/:attachmentId/media` — load with JWT:

`GET {API_BASE}/tickets/{ticketId}/attachments/{attachmentId}/media`

## Fallback without S3 CORS

Use legacy server upload (no browser→S3):

`POST /v2/tickets/:id/attachments` with `multipart/form-data` field `file`.
