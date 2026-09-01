import { PRODUCTS, fetchCurrentDraw } from '../../../src/lib/svenskaspel.ts'
import { ingestDraw } from '../../../src/lib/ingest.ts'
import { getDb } from '../../../src/db/client.ts'

/**
 * Capture via Vercel Cron — reserv för GitHub Actions.
 *
 * Vercels free tier tillåger bara cron 1×/dygn med lös precision, så den
 * täta insamlingen (var 15:e min) ligger kvar i GitHub Actions. Denna route
 * finns som skyddsnät: om Actions är trasigt får vi ändå minst en snapshot
 * per dygn, vilket är bättre än permanent dataförlust.
 *
 * Skyddad med CRON_SECRET. Vercel skickar den som Bearer-token.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  const secret = process.env['CRON_SECRET']
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const results: Record<string, unknown> = {}
  const db = getDb()

  for (const product of PRODUCTS) {
    try {
      const raw = await fetchCurrentDraw(product)
      if (!raw) {
        results[product] = 'ingen öppen omgång'
        continue
      }
      const res = await ingestDraw(db, product, raw, { source: 'live' })
      results[product] =
        res.status === 'inserted'
          ? { drawNumber: raw['drawNumber'], snapshotId: res.snapshotId, events: res.events }
          : res.status
    } catch (err) {
      results[product] = `fel: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return Response.json({ ok: true, at: new Date().toISOString(), results })
}
