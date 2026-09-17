import { apiRoute } from '@/lib/api/handler'
import { traceBatch } from '@/lib/services/traceability'
import { ApiError, ErrorCode } from '@/lib/api/errors'

/**
 * The recall query: everywhere a batch's stock sits, every movement it has been
 * part of, and every unit it produced — in one call.
 *
 * On a phone this is what somebody standing in an aisle during a quality
 * incident actually needs.
 */
export const GET = apiRoute({}, async ({ db, request }) => {
  const batchId = new URL(request.url).pathname.split('/').pop()!

  const trace = await traceBatch(db, batchId)
  if (!trace) throw new ApiError(ErrorCode.NOT_FOUND, 'That batch does not exist.')

  return trace
})
