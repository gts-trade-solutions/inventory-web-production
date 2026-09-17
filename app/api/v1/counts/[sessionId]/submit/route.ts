import { z } from 'zod'
import { apiRoute } from '@/lib/api/handler'
import { submitCount } from '@/lib/services/counts'

const schema = z.object({
  counted: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        batchId: z.string().uuid().nullable().optional(),
        quantity: z.number().int().min(0),
      }),
    )
    .optional(),
  submittedAt: z.string().datetime({ offset: true }).optional(),
})

/**
 * Submits for approval. Writes NOTHING to the ledger.
 *
 * The mobile MVP posts adjustments on submit; the real system stores the
 * variance and waits for a supervisor (WADR-008). The phone must say "submitted
 * for approval", not "stock updated".
 */
export const POST = apiRoute({ schema }, async ({ db, body, request }) => {
  const segments = new URL(request.url).pathname.split('/')
  const sessionId = segments[segments.length - 2]!

  const result = await submitCount(
    db,
    sessionId,
    body.counted?.map((line) => ({
      itemId: line.itemId,
      batchId: line.batchId ?? null,
      quantity: line.quantity,
    })),
  )

  return { ...result, message: 'Submitted for approval. No stock has changed yet.' }
})
