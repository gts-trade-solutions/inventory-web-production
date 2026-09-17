import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { ReasonCodeAdmin, type ReasonCodeRow } from './reason-code-admin'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'Reason codes' }

export default async function ReasonCodesPage() {
  const user = await requireRole(UserRole.ADMIN)

  const codes = await user.db.reasonCode.findMany({
    select: {
      id: true,
      code: true,
      label: true,
      appliesTo: true,
      requiresNote: true,
      active: true,
      // How often it is actually used. A code nobody picks is either badly
      // worded or unnecessary, and a retired one that has been used cannot be
      // deleted without orphaning movements.
      _count: { select: { movements: true } },
    },
    orderBy: [{ appliesTo: 'asc' }, { active: 'desc' }, { code: 'asc' }],
  })

  const rows: ReasonCodeRow[] = codes.map((code) => ({
    id: code.id,
    code: code.code,
    label: code.label,
    appliesTo: code.appliesTo,
    requiresNote: code.requiresNote,
    active: code.active,
    usageCount: code._count.movements,
  }))

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Reason codes"
        description="Every adjustment and scrap picks from this list. Free text cannot be grouped in a report, and “damaged”, “Damaged” and “dmg” are the same fact."
      />

      <ReasonCodeAdmin codes={rows} />
    </div>
  )
}
