import { z } from 'zod'
import { UserRole } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { rejectCount } from '@/lib/services/counts'

const schema = z.object({ note: z.string().max(1000).optional() })

/** Rejects a count. Nothing is posted; the location needs recounting. */
export const POST = apiRoute(
  { minimumRole: UserRole.SUPERVISOR, schema },
  async ({ db, body, request, claims }) => {
    const segments = new URL(request.url).pathname.split('/')
    const sessionId = segments[segments.length - 2]!

    return rejectCount(db, sessionId, { userId: claims.userId }, body.note)
  },
)
