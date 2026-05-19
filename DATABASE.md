# PostgreSQL (RDS) setup

vocal-api uses **direct PostgreSQL** when `DATABASE_URL` is set. Supabase REST keys are optional legacy fallback.

## 1. Environment

In `vocal-api/.env.local`:

```bash
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@database-1.crk26mqsmlsa.eu-north-1.rds.amazonaws.com:5432/postgres
DATABASE_SSL=true
```

Also keep Clerk keys (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`) and `ORG_ID`.

## 2. Run schema migrations

```bash
cd vocal-api
npm install
npm run db:check      # test connection
npm run db:migrate    # applies supabase/migrations/*.sql
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

## 4. Seed test users (Clerk)

Staff users are still created via Clerk + monolith seed:

```bash
cd ../vocal-app
npm run seed:test-users
```

That writes `users.clerk_user_id` rows in Postgres.

## 5. Attachments

Without Supabase Storage, files are stored on disk:

```bash
ATTACHMENT_STORAGE_PATH=./data/ticket-attachments
```

For production, plan S3 (or keep Supabase Storage only for files).

## Notes

- **Clerk auth** is unchanged — only the database host changed.
- **Next.js monolith** (`vocal-app`) still uses Supabase client by default; migrate it separately if needed.
- Fix typos in passwords (`passowrd` → `password`) if connection fails.
