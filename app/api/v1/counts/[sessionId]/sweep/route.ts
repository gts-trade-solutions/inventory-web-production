import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { sweepLocation } from '@/lib/services/rfid-count'

const schema = z.object({
  /** Which reader to use. Omitted, the site's reader is chosen. */
  deviceId: z.string().uuid().nullable().optional(),
})

/**
 * Sweeps the session's location with a fixed RFID reader.
 *
 * For a handset with its own integrated reader, stream reads to
 * `/counts/:id/tags` instead — this endpoint is for the fixed readers the phone
 * cannot talk to directly, because the browser and the app both reach them
 * through the server (DEVICE_INTEGRATION §5).
 *
 * Returns what the count has read SO FAR, not just this sweep: tags are
 * de-duplicated per session, so a client that added the result to its own tally
 * would double a second sweep.
 */
export const POST = apiRoute({ schema }, async ({ db, body, request, claims }) => {
  const segments = new URL(request.url).pathname.split('/')
  const sessionId = segments[segments.length - 2]!

  return sweepLocation(db, sessionId, { deviceId: body.deviceId ?? null, mode: claims.mode })
})
