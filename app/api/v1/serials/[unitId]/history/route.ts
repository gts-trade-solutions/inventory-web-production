import { apiRoute } from '@/lib/api/handler'
import { traceSerialUnit } from '@/lib/services/traceability'
import { ApiError, ErrorCode } from '@/lib/api/errors'

/** The full life of one physical unit: received, moved, counted, issued. */
export const GET = apiRoute({}, async ({ db, request }) => {
  const segments = new URL(request.url).pathname.split('/')
  const unitId = segments[segments.length - 2]!

  const trace = await traceSerialUnit(db, unitId)
  if (!trace) throw new ApiError(ErrorCode.NOT_FOUND, 'That unit is not on record.')

  return trace
})
