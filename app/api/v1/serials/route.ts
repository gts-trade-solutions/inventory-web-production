import { SerialStatus } from '@prisma/client'
import { apiRoute } from '@/lib/api/handler'
import { listSerialUnits } from '@/lib/services/traceability'

/**
 * The serial unit register.
 *
 * `?q=` takes a scanned EPC as readily as a typed serial number, because the
 * operator holding a reader has the EPC and nothing else.
 */
export const GET = apiRoute({}, async ({ db, request }) => {
  const params = new URL(request.url).searchParams
  const status = params.get('status')?.toUpperCase()
  const limit = Number(params.get('limit'))

  return {
    units: await listSerialUnits(db, {
      itemId: params.get('itemId') ?? undefined,
      batchId: params.get('batchId') ?? undefined,
      status: status && status in SerialStatus ? (status as SerialStatus) : undefined,
      search: params.get('q') ?? undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }),
  }
})
