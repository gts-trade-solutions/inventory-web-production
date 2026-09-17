import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CountStatus, UserRole } from '@prisma/client'
import { ArrowLeft, Radio } from 'lucide-react'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { loadCountSession } from '@/lib/services/count-queries'
import { CountingSheet } from './counting-sheet'
import { ReviewActions } from './review-actions'
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

export const metadata: Metadata = { title: 'Cycle count' }

/**
 * One cycle count, at whatever stage it has reached.
 *
 * COUNTING shows the counting sheet. Anything later shows the variance, and a
 * supervisor additionally gets the approve and reject controls. The same page
 * throughout, because a count is one thing moving through states, not four
 * separate screens.
 */
export default async function CountSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const user = await requireUser()
  const { sessionId } = await params

  const session = await loadCountSession(user.db, sessionId)
  if (!session) notFound()

  const canApprove = roleAtLeast(user.role, UserRole.SUPERVISOR)
  const counting = session.status === CountStatus.COUNTING

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/counts"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Cycle counts
      </Link>

      <PageHeader
        title={session.docNo}
        description={`${session.locationCode} — ${session.locationName} · started by ${session.startedBy}`}
        actions={<StatusBadge status={session.status} />}
      />

      {session.tagsRead > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Radio className="size-4" />
          {session.tagsRead} RFID tag{session.tagsRead === 1 ? '' : 's'} read, de-duplicated by EPC.
        </p>
      )}

      {counting ? (
        session.rows.length === 0 ? (
          <EmptyState
            title="Nothing is expected here"
            hint="The system has no stock at this location. Scan anything you find and it will be recorded as unexpected."
          />
        ) : (
          <CountingSheet
            sessionId={session.id}
            rows={session.rows}
            locationCode={session.locationCode}
          />
        )
      ) : (
        <VarianceTable session={session} />
      )}

      {session.status === CountStatus.SUBMITTED &&
        (canApprove ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Review</CardTitle>
              <CardDescription>
                Nothing has been posted yet. Approving turns each variance into a COUNT movement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewActions
                sessionId={session.id}
                netUnits={session.summary?.netUnits ?? 0}
                lineCount={
                  session.summary?.lines.filter((l) => l.counted !== l.expected).length ?? 0
                }
              />
            </CardContent>
          </Card>
        ) : (
          <Alert>Waiting for a supervisor to review this count. No stock has changed.</Alert>
        ))}

      {session.status === CountStatus.REJECTED && session.rejectedNote && (
        <Alert>Rejected: {session.rejectedNote}</Alert>
      )}

      {session.status === CountStatus.APPROVED && session.approvedBy && (
        <Alert>
          Approved by {session.approvedBy}. The corrections are in the ledger under this document
          number.
        </Alert>
      )}
    </div>
  )
}

function VarianceTable({
  session,
}: {
  session: NonNullable<Awaited<ReturnType<typeof loadCountSession>>>
}) {
  const { summary, rows } = session

  return (
    <>
      {summary && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Lines" value={summary.lines.length} />
            <Stat label="Matched" value={summary.matched} tone="ok" />
            <Stat label="Short" value={summary.short} tone={summary.short ? 'warn' : undefined} />
            <Stat label="Over" value={summary.over} tone={summary.over ? 'warn' : undefined} />
          </div>

          {/*
            A count is blind over the whole location, so a line nobody scanned is
            proposed for write-off exactly like a line counted as empty. Saying
            only "N short" makes those two look identical on the one screen where
            somebody decides whether to post them.
          */}
          {summary.missing > 0 && (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
              <span className="font-medium">
                {summary.missing} of these {summary.lines.length} lines were never counted.
              </span>{' '}
              Approving writes all of them off. If the count was meant to cover only part of this
              location, reject it and count the whole location instead.
            </p>
          )}
        </>
      )}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Difference</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const difference = (row.counted ?? 0) - row.expected

              return (
                <TableRow key={`${row.itemId}-${row.batchId ?? 'none'}`}>
                  <TableCell>
                    <Link href={`/inventory/${row.itemId}`} className="font-medium hover:underline">
                      {row.itemName}
                    </Link>
                    <span className="tabular block text-xs text-muted-foreground">
                      {row.itemSku}
                    </span>
                  </TableCell>
                  <TableCell className="tabular text-sm">{row.batchNo ?? '—'}</TableCell>
                  <TableCell className="tabular text-right">{row.expected}</TableCell>
                  <TableCell className="tabular text-right">{row.counted ?? '—'}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right font-medium',
                      difference === 0 && 'text-muted-foreground',
                      difference < 0 && 'text-warn',
                      difference > 0 && 'text-primary',
                    )}
                  >
                    {difference === 0 ? '—' : difference > 0 ? `+${difference}` : difference}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          'tabular mt-1 text-2xl font-semibold',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function StatusBadge({ status }: { status: CountStatus }) {
  const variant =
    status === CountStatus.APPROVED
      ? 'ok'
      : status === CountStatus.REJECTED || status === CountStatus.CANCELLED
        ? 'destructive'
        : status === CountStatus.SUBMITTED
          ? 'warn'
          : 'secondary'

  return <Badge variant={variant}>{status}</Badge>
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
      {children}
    </div>
  )
}
