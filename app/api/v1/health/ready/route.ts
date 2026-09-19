import { NextResponse } from 'next/server'
import { dbFor } from '@/lib/mode'
import { report } from '@/lib/log'

/**
 * Readiness: can this process actually serve a request?
 *
 * Deliberately separate from `/health`, which answers a different question.
 * Liveness asks "is the web tier up" and must NOT touch the database, because
 * an uptime check that goes red whenever MySQL is briefly busy teaches people
 * to ignore it. Readiness asks "would a real request work", which cannot be
 * answered without asking the database.
 *
 * Conflating the two is how a load balancer takes every instance out of
 * rotation during a thirty-second database blip, turning a slow minute into an
 * outage.
 *
 * The query is `SELECT 1` — it proves the connection pool can hand out a
 * working connection and nothing more. Counting rows would make the check
 * slower and more fragile without telling anybody anything they wanted.
 *
 * Unauthenticated, like `/health`: a readiness probe runs before any session
 * exists, and this discloses nothing but whether the database answered.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const started = Date.now()

  try {
    await dbFor('LIVE').$queryRaw`SELECT 1`

    return NextResponse.json(
      { status: 'ready', database: 'ok', ms: Date.now() - started },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (thrown) {
    report('health.notReady', thrown, { ms: Date.now() - started })

    // 503, not 500. "I am not ready, come back" is what a load balancer and an
    // uptime monitor are both looking for; a 500 reads as a broken application
    // and gets somebody woken up for a database that is merely restarting.
    return NextResponse.json(
      { status: 'not-ready', database: 'unreachable', ms: Date.now() - started },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
