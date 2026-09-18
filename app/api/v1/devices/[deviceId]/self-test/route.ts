import { apiRoute } from '@/lib/api/handler'
import { runSelfTest } from '@/lib/services/devices'

/**
 * Runs the device's bring-up sequence on demand.
 *
 * Available to any signed-in user, not just admins: the person standing next to
 * a printer that is not printing is the one who needs to know why, and making
 * them find a supervisor first is how a five-minute problem becomes an hour.
 *
 * Returns a report per step, never a boolean.
 */
export const POST = apiRoute({}, async ({ db, request, claims }) => {
  const segments = new URL(request.url).pathname.split('/')
  const deviceId = segments[segments.length - 2]!

  return runSelfTest(db, deviceId, claims.mode)
})
