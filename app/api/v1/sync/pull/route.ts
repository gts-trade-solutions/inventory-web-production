import { apiRoute } from '@/lib/api/handler'
import { pull } from '@/lib/services/sync'

/**
 * Everything that changed since the cursor.
 *
 * `since` is omitted on a first, full sync. The cursor is opaque: the client
 * stores and returns it verbatim and never constructs one (API_CONTRACT §9).
 */
export const GET = apiRoute({}, async ({ db, request, claims }) => {
  const url = new URL(request.url)

  return pull(db, {
    since: url.searchParams.get('since'),
    siteId: url.searchParams.get('siteId') ?? claims.siteIds[0] ?? null,
    limit: Number(url.searchParams.get('limit')) || undefined,
  })
})
