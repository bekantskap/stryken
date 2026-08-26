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
  assertRealDatabaseUrl(url)
  const sql = neon(url)
  return drizzle(sql, { schema })
}

/**
 * Fångar oredigerad .env.example. Utan detta blir felet ett kryptiskt
 * "password authentication failed for user 'user'" från Postgres.
 */
export function assertRealDatabaseUrl(url: string): void {
  if (url.includes('user:password@') || url.includes('ep-xxx')) {
    throw new Error(
      'DATABASE_URL är fortfarande platshållaren från .env.example.\n' +
        'Klistra in din riktiga connection string från Neon\n' +
        '(console.neon.tech → projekt → Connection Details → Connection string).',
    )
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(`DATABASE_URL ser inte ut som en Postgres-URL: ${url.slice(0, 20)}...`)
  }
}

export type Db = ReturnType<typeof getDb>
export { schema }
