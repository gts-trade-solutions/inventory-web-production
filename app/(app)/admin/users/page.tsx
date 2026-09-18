import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { listUsers } from '@/lib/services/users'
import { PageHeader } from '@/components/page-header'
import { UserAdmin } from './user-admin'

export const metadata: Metadata = { title: 'People' }

/**
 * Who can sign in, and what they may do.
 *
 * Administrator only. Until this screen existed, accounts could only be created
 * by the seed script — which meant adding a new starter needed a developer, the
 * exact dependency Phase 7 exists to remove.
 */
export default async function UsersPage() {
  const user = await requireRole(UserRole.ADMIN)

  const [users, sites] = await Promise.all([
    listUsers(user.db),
    user.db.site.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="People"
        description="Accounts, roles and which sites each person can work in."
      />

      <UserAdmin
        currentUserId={user.userId}
        users={users.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          active: row.active,
          siteCodes: row.siteCodes,
          // Serialised here: a Date crossing into a client component is fine,
          // but the component only ever shows the day, and passing a string
          // keeps the boundary obvious.
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
        }))}
        sites={sites.map((site) => ({ id: site.id, label: `${site.code} — ${site.name}` }))}
      />
    </div>
  )
}
