import 'server-only'
import { spawn } from 'node:child_process'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { assertDemoMode, type AppMode } from '@/lib/mode'
import { AuditAction, writeAudit } from '@/lib/audit'
import { publishDevice } from '@/lib/events/publish'

/**
 * One-click reset of the demo database (PROJECT_PLAN 6.3, DEMO_MODE §7.6).
 *
 * Demo mode is the training environment and the sales floor. Both need to start
 * from the same state every time — a demo that has been half-counted by the
 * last person is worse than no demo, because the script no longer matches the
 * screen.
 *
 * Three guardrails, and none of them is a convention:
 *
 *  1. `assertDemoMode` first, before anything else happens. There is
 *     deliberately no code path from here to the live database.
 *  2. The seed script refuses any URL that is not the demo one, so even calling
 *     this with a mis-set environment cannot destroy live data.
 *  3. Admin-only and audited by the caller.
 */

/** Long enough for the seed, short enough that a hung run is not silent. */
const RESET_TIMEOUT_MS = 120_000

export interface DemoResetResult {
  ok: boolean
  ms: number
  /** The seed's own summary, so the operator sees what they now have. */
  output: string
}

export async function resetDemoData(
  db: PrismaClient,
  mode: AppMode,
  actor: { userId: string },
): Promise<DemoResetResult> {
  // First line of the function on purpose. Everything below this point assumes
  // it has already thrown for LIVE.
  assertDemoMode(mode, 'Resetting the demo data')

  // Read WHO before the reseed, because it deletes them. The audit entry then
  // names them as text rather than by a foreign key.
  const who = await db.user.findUnique({
    where: { id: actor.userId },
    select: { email: true, name: true },
  })

  const started = Date.now()
  const { ok, output } = await runSeed()
  const ms = Date.now() - started

  /**
   * Audited whether it worked or not. "Who wiped the demo and when" is a
   * question that gets asked, and a failed reset is itself worth recording —
   * it means somebody is looking at data they did not expect.
   *
   * `actorUserId` is deliberately null. The reseed deletes every user and
   * creates new ones with new ids, so a foreign key to the person who pressed
   * the button would point at a row that no longer exists — which is exactly
   * what it did on the first attempt, and the whole reset failed on the
   * constraint after the data had already been replaced.
   *
   * This entry describes the provenance of the CURRENT dataset, not a history
   * of resets: the previous ones went with the data they were recorded in.
   */
  await writeAudit(db, {
    actorUserId: null,
    action: AuditAction.DEMO_RESET,
    entity: 'DemoDatabase',
    entityId: 'demo',
    after: { ok, ms, resetBy: who?.email ?? actor.userId, name: who?.name ?? null },
  })

  publishDevice({
    mode,
    siteId: null,
    device: 'Demo data',
    detail: ok ? `reset in ${(ms / 1000).toFixed(1)}s` : 'reset failed',
    ok,
  })

  if (!ok) {
    throw new ApiError(
      ErrorCode.INTERNAL,
      'The demo data could not be reset. The database may be part-way through a reseed.',
      { output: output.slice(-2000) },
    )
  }

  return { ok, ms, output }
}

/**
 * Runs the seed script in a child process.
 *
 * Deliberately the same `npm run db:seed:demo` a developer runs, rather than a
 * second implementation of the same thing. Two seeds would drift, and the one
 * nobody runs by hand would be the one that breaks.
 */
function runSeed(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm run db:seed:demo', {
      shell: true,
      env: process.env,
      cwd: process.cwd(),
    })

    let output = ''
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
    }

    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        output: `${output}\nTimed out after ${RESET_TIMEOUT_MS / 1000}s.`,
      })
    }, RESET_TIMEOUT_MS)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `${output}\n${error.message}` })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })
}
