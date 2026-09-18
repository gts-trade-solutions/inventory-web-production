import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { listCategories } from '@/lib/services/categories'
import { listSites } from '@/lib/services/sites'
import { listSequences } from '@/lib/services/sequences'
import { currentPeriod } from '@/lib/services/numbering'
import { CategoriesAdmin } from './categories-admin'
import { SitesAdmin } from './sites-admin'
import { SequencesAdmin } from './sequences-admin'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'Master data' }

export default async function MasterDataPage() {
  const user = await requireRole(UserRole.ADMIN)

  const period = currentPeriod()
  const [categories, sites, sequences] = await Promise.all([
    listCategories(user.db),
    listSites(user.db),
    listSequences(user.db, period),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <PageHeader
        title="Master data"
        description="The structures everything else hangs off: what stock is called, where it lives, and how paperwork is numbered."
      />

      <SitesAdmin sites={sites} />
      <CategoriesAdmin categories={categories} />
      <SequencesAdmin sequences={sequences} period={period} />
    </div>
  )
}
