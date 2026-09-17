import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { recordTagReads } from '@/lib/services/counts'

const schema = z.object({
  tags: z
    .array(
      z.object({
        epc: z.string().regex(/^[0-9A-Fa-f]{24}$/, 'An SGTIN-96 EPC is 24 hex characters.'),
        rssi: z.number().int().optional().nullable(),
        readAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .max(5000),
})

/**
 * Streams raw RFID reads into an open session.
 *
 * De-duplicated by (session, EPC). A reader sees the same tag dozens of times
 * per sweep, and counting each read would multiply stock by the dwell time —
 * which is why a batch this large is expected and safe to retry.
 */
export const POST = apiRoute({ schema }, async ({ db, body, request }) => {
  const segments = new URL(request.url).pathname.split('/')
  const sessionId = segments[segments.length - 2]!

  return recordTagReads(
    db,
    sessionId,
    body.tags.map((tag) => ({
      epc: tag.epc,
      rssi: tag.rssi ?? null,
      readAt: tag.readAt ? new Date(tag.readAt) : new Date(),
    })),
  )
})
