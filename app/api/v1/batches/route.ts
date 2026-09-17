import { BatchStatus } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { expirySummary, listBatches, type ExpiryState } from '@/lib/services/traceability'

const EXPIRY_STATES: ExpiryState[] = ['EXPIRED', 'NEAR', 'OK', 'NONE']

/**
 * The batch register, with on-hand and expiry state already worked out.
 *
 * Expiry is computed here rather than left to the client. A phone deciding
 * "expired" from its own clock disagrees with the server the moment the clock
 * drifts, and two devices in the same aisle showing different answers about the
 * same batch is worse than either answer being slightly stale.
 */
export const GET = apiRoute({}, async ({ db, request }) => {
  const params = new URL(request.url).searchParams

  const status = params.get('status')?.toUpperCase()
  const expiryState = params.get('expiry')?.toUpperCase()

  const batches = await listBatches(db, {
    itemId: params.get('itemId') ?? undefined,
    status: status && status in BatchStatus ? (status as BatchStatus) : undefined,
    expiryState: EXPIRY_STATES.includes(expiryState as ExpiryState)
      ? (expiryState as ExpiryState)
      : undefined,
    search: params.get('q') ?? undefined,
  })

  return {
    batches,
    // The headline counts, so a client can show the expiry board without a
    // second round trip on a connection that may not survive one.
    summary: await expirySummary(db),
  }
})
