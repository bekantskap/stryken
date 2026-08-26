import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema.ts'

/**
 * Neon over HTTP — passar korta cron-körningar (ingen pool att stänga).
 */
export function getDb() {
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error(
      'DATABASE_URL saknas. Sätt den i .env lokalt eller som GitHub Actions-secret.',
    )
  }
  const sql = neon(url)
  return drizzle(sql, { schema })
}

export type Db = ReturnType<typeof getDb>
export { schema }
