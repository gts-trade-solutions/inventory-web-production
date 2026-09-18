import { UserRole } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { runNightlySweep } from '@/lib/services/maintenance'

/**
 * The nightly sweep, on demand.
 *
 * Administrator only, and safe to call repeatedly: it reports drift rather than
 * repairing it, and marking an already-expired batch expired again changes
 * nothing.
 *
 * Meant to be driven by cron. There is deliberately no scheduler inside the
 * app — a web process that quietly runs jobs behaves differently depending on
 * how many copies of it happen to be running, and "why did that run twice"
 * is a bad question to have to answer about stock.
 */
export const POST = apiRoute({ minimumRole: UserRole.ADMIN }, async ({ db, claims }) =>
  runNightlySweep(db, claims.mode),
)
