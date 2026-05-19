/**
 * Must be imported before any module that reads process.env at load time.
 */
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const envFiles = [
  path.join(apiRoot, '.env'),
  path.join(apiRoot, '.env.local'),
  path.resolve(apiRoot, '..', 'vocal-app', '.env.local'),
  path.resolve(apiRoot, '..', '.env.local'),
]

for (const file of envFiles) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: true })
  }
}

if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
}
