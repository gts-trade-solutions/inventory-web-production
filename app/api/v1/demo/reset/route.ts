import { UserRole } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { resetDemoData } from '@/lib/services/demo-reset'

/**
 * Puts the demo database back to its seeded state.
 *
 * Admin-only and audited (DEMO_MODE §7.6). It refuses outright in LIVE mode —
 * not by checking a flag here, but because `resetDemoData` asserts the mode on
 * its first line and there is no code path from it to the live database.
 *
 * A confirmation belongs in the UI, not here: an API that asks "are you sure?"
 * is an API that cannot be scripted, and the mobile client will want this too.
 */
export const POST = apiRoute({ minimumRole: UserRole.ADMIN }, async ({ db, claims }) =>
  resetDemoData(db, claims.mode, { userId: claims.userId }),
)
