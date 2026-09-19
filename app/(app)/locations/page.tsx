import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { listLocations } from '@/lib/services/locations'
import { PageHeader } from '@/components/page-header'
import { ReportDownload } from '../reports/download'
import { LocationAdmin, type LocationRow } from './location-admin'

export const metadata: Metadata = { title: 'Locations' }

/**
 * Where stock sits.
 *
 * Readable by anyone — an operator looking for a rack is the commonest reason
 * to open it — and editable only by an administrator. Locations could only be
 * created by CSV import before this screen existed, which meant a site could be
 * set up and then not be usable through the app at all.
 */
export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ siteId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [locations, sites] = await Promise.all([
    listLocations(user.db, { siteId: params.siteId || null }),
    user.db.site.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    }),
  ])

  const rows: LocationRow[] = locations.map((location) => ({
    ...location,
    zone: location.zone as LocationRow['zone'],
  }))

  const stocked = rows.filter((row) => row.onHand > 0).length

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Locations"
        description={`${rows.length} location${rows.length === 1 ? '' : 's'} · ${stocked} holding stock. A zone is descriptive — it labels what a place is for and does not change how stock is allocated.`}
        actions={<ReportDownload report="locations" params={params} />}
      />

      <LocationAdmin
        locations={rows}
        sites={sites}
        canEdit={roleAtLeast(user.role, UserRole.ADMIN)}
      />
    </div>
  )
}
