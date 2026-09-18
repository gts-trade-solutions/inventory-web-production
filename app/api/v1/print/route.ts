import { z } from 'zod'
import { PrintJobStatus } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { listPrintJobs, submitPrintJob } from '@/lib/services/printing'

const schema = z.object({
  templateId: z.string().uuid(),
  printerDeviceId: z.string().uuid().nullable().optional(),
  copies: z.number().int().min(1).max(99).optional(),
  fields: z.record(z.union([z.string(), z.number()]).nullable()).optional(),
  epcs: z.array(z.string().regex(/^[0-9A-Fa-f]{24}$/)).max(500).optional(),
  itemId: z.string().uuid().nullable().optional(),
  batchId: z.string().uuid().nullable().optional(),
  serialUnitId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
})

/**
 * One print path for both clients.
 *
 * The response carries the ZPL that was sent, so the phone can show a preview of
 * exactly what printed rather than a rendering of what it thinks printed.
 *
 * `status` is SENT, not CONFIRMED, for a networked printer: the socket closing
 * means the printer took the bytes, not that a label came out. Show the operator
 * what we actually know, and keep reprint one tap away.
 */
export const POST = apiRoute({ schema }, async ({ db, body, claims }) =>
  submitPrintJob(db, body, { userId: claims.userId }, claims.mode),
)

/** Print history — the audit trail behind every physical tag. */
export const GET = apiRoute({}, async ({ db, request }) => {
  const params = new URL(request.url).searchParams
  const status = params.get('status')?.toUpperCase()

  return {
    jobs: await listPrintJobs(db, {
      itemId: params.get('itemId') ?? undefined,
      status: status && status in PrintJobStatus ? (status as PrintJobStatus) : undefined,
    }),
  }
})
