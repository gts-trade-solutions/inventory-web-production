import { UserRole } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { approveCount } from '@/lib/services/counts'

/**
 * Posts the corrections. Supervisor or above.
 *
 * Available on the phone as well as the web, so a supervisor on the floor can
 * approve without walking to a desk (WADR-008).
 */
export const POST = apiRoute(
  { minimumRole: UserRole.SUPERVISOR },
  async ({ db, request, claims }) => {
    const segments = new URL(request.url).pathname.split('/')
    const sessionId = segments[segments.length - 2]!

    return approveCount(db, sessionId, { userId: claims.userId })
  },
)
