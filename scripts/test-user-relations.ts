import dotenv from 'dotenv'
import { createSupabaseServiceClient } from '@/lib/supabase.js'

dotenv.config()
dotenv.config({ path: '.env.local', override: true })

async function main() {
  const supabase = createSupabaseServiceClient()
  const { data, error } = await supabase
    .from('users')
    .select('*, roles(*), organizations(name)')
    .eq('active', true)
    .limit(1)

  if (error) {
    console.error('ERROR:', error)
    process.exit(1)
  }
  console.log('OK:', data?.length ?? 0, 'row(s)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
