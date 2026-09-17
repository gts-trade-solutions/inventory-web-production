import { z } from 'zod'
import { CountMethod, CountStatus } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { startCount } from '@/lib/services/counts'
import { listCountSessions } from '@/lib/services/count-queries'

const schema = z.object({
  id: z.string().uuid().optional(),
  siteId: z.string().uuid(),
  locationId: z.string().uuid(),
  method: z.nativeEnum(CountMethod).optional(),
})

/** Sessions, so a phone can show what is awaiting approval and what was decided. */
export const GET = apiRoute({}, async ({ db, request }) => {
  const status = new URL(request.url).searchParams.get('status')?.toUpperCase()

  return {
    sessions: await listCountSessions(db, {
      status: status && status in CountStatus ? (status as CountStatus) : undefined,
    }),
  }
})

/**
 * Starts a session. The id is client-generated, so a retried start on a flaky
 * connection is idempotent rather than creating a second session.
 */
export const POST = apiRoute({ schema }, async ({ db, body, claims }) =>
  startCount(db, body, { userId: claims.userId }),
)
