# PostgreSQL (RDS) setup

vocal-api uses **direct PostgreSQL** when `DATABASE_URL` is set. Supabase REST keys are optional legacy fallback.

## 1. Environment

In `vocal-api/.env.local`:

```bash
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@database-1.crk26mqsmlsa.eu-north-1.rds.amazonaws.com:5432/postgres
DATABASE_SSL=true
```

Also set `JWT_SECRET` (min 32 characters) and `ORG_ID`.

## 2. Run schema migrations

### Fresh empty database (all tables in one step)

```bash
cd vocal-api
npm install
npm run db:check        # test connection
npm run db:build-schema # build supabase/schema.sql from migrations (optional; committed file)
npm run db:setup        # applies full schema.sql, records all migrations
```

Or apply the SQL file directly in pgAdmin or psql:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

`schema.sql` includes a stub `auth.uid()` function so RLS policies work on plain RDS Postgres (not only Supabase). vocal-api connects as the DB owner and bypasses RLS; the policies are for legacy Supabase client access.

### Incremental migrations (existing workflow)

```bash
npm run db:migrate    # applies supabase/migrations/*.sql (skips already recorded)

# One migration only (e.g. DB already has schema but schema_migrations is empty):
npm run db:migrate:one -- 012_ticket_closure_review.sql
```

### Database already has tables but schema_migrations is incomplete

```bash
npm run db:setup -- --migrate   # apply only pending migration files
npm run db:setup -- --sync      # mark all migrations applied without running SQL
```

## 3. Migrate data from old Supabase

If you already have data in Supabase Postgres:

```bash
# Export from Supabase (Dashboard → Database → connection string)
pg_dump "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres" \
  --no-owner --no-acl -f vocal_backup.sql

# Import into RDS
psql "$DATABASE_URL" -f vocal_backup.sql
```

Or export/import single tables with `pg_dump -t users -t tickets ...`.

## 4. Seed test users and passwords

Staff users from monolith seed; set login passwords for vocal-api:

```bash
cd ../vocal-app
npm run seed:test-users
```

Then run `npm run seed:passwords` in vocal-api (`DATABASE_URL` in `.env.local`, migration `007_user_password_auth.sql`).

## 5. Attachments

**v2 presigned upload (dashboard):** set `AWS_S3_BUCKET` + `AWS_REGION` (and credentials). Flow:

1. `POST /v2/tickets/:id/attachments/upload-url` — get presigned PUT URL + `storage_path`
2. Browser `PUT` file to `upload_url` with `Content-Type` header from response
3. `POST /v2/tickets/:id/attachments/complete` — register `ticket_attachments` row

Without S3 when `DATABASE_URL` is set, presigned upload returns `503`; use legacy `POST .../attachments` multipart or configure S3.

Citizen webhook media still uses server-side upload (Telegram/WhatsApp). Local disk fallback for server uploads only:

```bash
ATTACHMENT_STORAGE_PATH=./data/ticket-attachments
```

## Notes

- **JWT auth** uses `users.password_hash` — only the database host changed.
- **Next.js monolith** (`vocal-app`) still uses Supabase client by default; migrate it separately if needed.
- Fix typos in passwords (`passowrd` → `password`) if connection fails.
