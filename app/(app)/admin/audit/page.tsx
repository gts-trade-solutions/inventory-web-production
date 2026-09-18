import type { Metadata } from 'next'
import Link from 'next/link'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { auditFacets, describeChange, listAuditEntries } from '@/lib/services/audit-log'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export const metadata: Metadata = { title: 'Audit log' }

/**
 * The audit log, readable.
 *
 * Several decisions in this system are justified by being "audited" — approving
 * a count, quarantining a batch, resetting the demo. That claim was worth
 * nothing while nobody could read the log.
 *
 * Administrator only: it names who did what, which is not everybody's business.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string; q?: string; cursor?: string }>
}) {
  const user = await requireRole(UserRole.ADMIN)
  const params = await searchParams

  const [{ entries, nextCursor }, facets] = await Promise.all([
    listAuditEntries(user.db, {
      action: params.action || undefined,
      entity: params.entity || undefined,
      search: params.q || undefined,
      cursor: params.cursor || undefined,
    }),
    auditFacets(user.db),
  ])

  const href = (overrides: Record<string, string | undefined>) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...params, cursor: undefined, ...overrides })) {
      if (value) query.set(key, value)
    }
    const string = query.toString()
    return string ? `/admin/audit?${string}` : '/admin/audit'
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Audit log"
        description="Who did what, and when. Approvals, quarantines, master-data edits and demo resets."
      />

      <form className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor="q" className="text-sm font-medium">
            Search
          </label>
          <Input id="q" name="q" defaultValue={params.q ?? ''} placeholder="Action or entity…" />
        </div>

        <div className="space-y-1">
          <label htmlFor="action" className="text-sm font-medium">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={params.action ?? ''}
            className="h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All</option>
            {facets.actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="entity" className="text-sm font-medium">
            Entity
          </label>
          <select
            id="entity"
            name="entity"
            defaultValue={params.entity ?? ''}
            className="h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">All</option>
            {facets.entities.map((entity) => (
              <option key={entity} value={entity}>
                {entity}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          hint="Entries appear as people approve counts, quarantine batches and edit master data."
        />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const changes = describeChange(entry.before, entry.after)

            return (
              <div key={entry.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge variant="secondary">{entry.action}</Badge>
                  <span className="font-medium">{entry.entity}</span>
                  <span className="tabular flex-1 text-xs text-muted-foreground">
                    {entry.at.toISOString().replace('T', ' ').slice(0, 19)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {/* "Somebody who no longer exists" is honest. A deleted user,
                        or a demo reset that replaced everybody. */}
                    {entry.actor ?? 'an account that no longer exists'}
                  </span>
                </div>

                {changes.length > 0 && (
                  <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    {changes.map((change) => (
                      <div key={change.field} className="contents">
                        <dt className="text-muted-foreground">{change.field}</dt>
                        <dd className="tabular">
                          <span className="text-muted-foreground line-through">{change.from}</span>
                          {' → '}
                          <span>{change.to}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )
          })}
        </div>
      )}

      {nextCursor && (
        <Button asChild variant="outline">
          <Link href={href({ cursor: nextCursor })}>Older entries</Link>
        </Button>
      )}
    </div>
  )
}
