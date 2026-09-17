import type { Metadata } from 'next'
import Link from 'next/link'
import { CountStatus } from '@prisma/client'
import { requireUser } from '@/lib/auth/guards'
import { listCountSessions } from '@/lib/services/count-queries'
import { StartCountForm } from './start-count-form'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Cycle counts' }

export default async function CountsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const status = parseStatus(params.status)

  const siteId = user.defaultSiteId ?? user.siteIds[0]

  const [sessions, locations] = await Promise.all([
    listCountSessions(user.db, { status }),
    user.db.location.findMany({
      where: { siteId, deletedAt: null, active: true },
      select: {
        id: true,
        code: true,
        name: true,
        _count: { select: { stockLevels: true } },
      },
      orderBy: { code: 'asc' },
    }),
  ])

  const awaiting = sessions.filter((s) => s.status === CountStatus.SUBMITTED).length

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Cycle counts"
        description="Count a location, then a supervisor approves the variance. Nothing reaches the ledger until then."
      />

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Start a count</CardTitle>
          <CardDescription>
            The sheet opens with what the system expects to be there, so anything missing is
            obvious.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StartCountForm
            locations={locations.map((location) => ({
              id: location.id,
              code: location.code,
              name: location.name,
              itemCount: location._count.stockLevels,
            }))}
          />
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterLink href="/counts" active={!status}>
          All
        </FilterLink>
        {[
          CountStatus.COUNTING,
          CountStatus.SUBMITTED,
          CountStatus.APPROVED,
          CountStatus.REJECTED,
        ].map((option) => (
          <FilterLink
            key={option}
            href={status === option ? '/counts' : `/counts?status=${option.toLowerCase()}`}
            active={status === option}
          >
            {option}
            {option === CountStatus.SUBMITTED && awaiting > 0 && (
              <Badge variant="warn" className="ml-1.5">
                {awaiting}
              </Badge>
            )}
          </FilterLink>
        ))}
      </div>

      <div className="rounded-lg border bg-card">
        {sessions.length === 0 ? (
          <EmptyState
            title="No counts yet"
            hint={status ? 'Nothing in that state.' : 'Start one above to begin.'}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Variance</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="tabular text-xs">
                    <Link href={`/counts/${session.id}`} className="font-medium hover:underline">
                      {session.docNo}
                    </Link>
                    <span className="block text-muted-foreground">{session.method}</span>
                  </TableCell>
                  <TableCell>
                    <span className="tabular font-medium">{session.locationCode}</span>
                    <span className="block text-xs text-muted-foreground">
                      {session.locationName}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={badgeFor(session.status)}>{session.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {session.summary ? (
                      <span className="tabular">
                        {session.summary.short > 0 && (
                          <span className="text-warn">{session.summary.short} short</span>
                        )}
                        {session.summary.short > 0 && session.summary.over > 0 && ' · '}
                        {session.summary.over > 0 && (
                          <span className="text-primary">{session.summary.over} over</span>
                        )}
                        {session.summary.short === 0 && session.summary.over === 0 && (
                          <span className="text-muted-foreground">Clean</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">In progress</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {session.startedAt.toISOString().slice(0, 10)}
                    <span className="block text-xs">{session.startedBy}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        active ? 'bg-primary font-medium text-primary-foreground' : 'border hover:bg-accent',
      )}
    >
      {children}
    </Link>
  )
}

function badgeFor(status: CountStatus) {
  if (status === CountStatus.APPROVED) return 'ok' as const
  if (status === CountStatus.SUBMITTED) return 'warn' as const
  if (status === CountStatus.REJECTED || status === CountStatus.CANCELLED) {
    return 'destructive' as const
  }
  return 'secondary' as const
}

function parseStatus(value: string | undefined): CountStatus | undefined {
  const upper = value?.toUpperCase()
  return upper && upper in CountStatus ? (upper as CountStatus) : undefined
}
