import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, CalendarClock, ShieldAlert } from 'lucide-react'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { expirySummary, listBatches, type ExpiryState } from '@/lib/services/traceability'
import { UserRole } from '@prisma/client'
import { BulkBatchForm } from './bulk-bar'
import { PageHeader } from '@/components/page-header'
import { ReportDownload } from '../reports/download'
import { EmptyState } from '@/components/empty-state'
import { ExpiryBadge } from '@/components/expiry-badge'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Batches & expiry' }

/**
 * The batch register, fronted by the expiry board.
 *
 * Sorted by expiry date ascending, so whatever needs attention first is at the
 * top without anyone choosing a sort. The tiles count only batches that still
 * hold stock — an expired batch with nothing left is history, and listing it
 * buries the ones that matter.
 */
export default async function BatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string }>
}) {
  const user = await requireUser()
  // Bulk quarantine is a supervisor decision, exactly as the single-batch one
  // is. A bulk path with a lower bar would be a way around the role guarding
  // the slow one.
  const canQuarantine = roleAtLeast(user.role, UserRole.SUPERVISOR)
  const params = await searchParams

  const search = params.q?.trim() ?? ''
  const state = parseState(params.state)

  const [summary, batches] = await Promise.all([
    expirySummary(user.db),
    listBatches(user.db, { search: search || undefined, expiryState: state }),
  ])

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Batches & expiry"
        description="Every lot in the warehouse, soonest to expire first."
        actions={<ReportDownload report="batches" params={params} />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <ExpiryTile
          label="Expired, still on hand"
          icon={<AlertTriangle className="size-4" />}
          batches={summary.expired.batches}
          units={summary.expired.units}
          tone="destructive"
          href={buildHref({ q: search, state: state === 'EXPIRED' ? undefined : 'expired' })}
          active={state === 'EXPIRED'}
        />
        <ExpiryTile
          label="Near expiry"
          icon={<CalendarClock className="size-4" />}
          batches={summary.near.batches}
          units={summary.near.units}
          tone="warn"
          href={buildHref({ q: search, state: state === 'NEAR' ? undefined : 'near' })}
          active={state === 'NEAR'}
        />
        <ExpiryTile
          label="Quarantined"
          icon={<ShieldAlert className="size-4" />}
          batches={summary.quarantined.batches}
          units={summary.quarantined.units}
          tone="muted"
        />
      </div>

      <form className="mb-4">
        <Input
          name="q"
          defaultValue={search}
          placeholder="Search batch number, item or SKU…"
          aria-label="Search batches"
          className="max-w-sm"
        />
        {state && <input type="hidden" name="state" value={state.toLowerCase()} />}
      </form>
      <BulkBatchForm>
        <div className="rounded-lg border bg-card">
          {batches.length === 0 ? (
            <EmptyState
              title="No batches match"
              hint={
                search || state
                  ? 'Try clearing the search or the filter.'
                  : 'No batch-tracked stock yet.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Batch</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Supplier ref</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.id} className={cn(batch.onHand === 0 && 'opacity-50')}>
                    <TableCell>
                      {canQuarantine && (
                        <input
                          type="checkbox"
                          name="batchIds"
                          value={batch.id}
                          aria-label={`Select ${batch.batchNo}`}
                          className="size-4"
                        />
                      )}
                    </TableCell>
                    <TableCell className="tabular">
                      <Link href={`/batches/${batch.id}`} className="font-medium hover:underline">
                        {batch.batchNo}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/inventory/${batch.itemId}`} className="hover:underline">
                        {batch.itemName}
                      </Link>
                      <span className="tabular block text-xs text-muted-foreground">
                        {batch.itemSku}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ExpiryBadge
                        state={batch.expiryState}
                        daysToExpiry={batch.daysToExpiry}
                        date={batch.expiryDate}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={batch.status === 'ACTIVE' ? 'secondary' : 'destructive'}>
                        {batch.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular text-sm text-muted-foreground">
                      {batch.supplierRef ?? '—'}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {batch.onHand.toLocaleString()}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {batch.unit}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </BulkBatchForm>
    </div>
  )
}

function ExpiryTile({
  label,
  icon,
  batches,
  units,
  tone,
  href,
  active,
}: {
  label: string
  icon: React.ReactNode
  batches: number
  units: number
  tone: 'destructive' | 'warn' | 'muted'
  href?: string
  active?: boolean
}) {
  const empty = batches === 0

  const body = (
    <div
      className={cn(
        'rounded-lg border bg-card p-4 transition-colors',
        href && 'hover:bg-accent',
        active && 'ring-2 ring-ring',
        // A zero here is good news, so it is not dressed up as an alert.
        !empty && tone === 'destructive' && 'border-destructive/40',
        !empty && tone === 'warn' && 'border-warn/50',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 text-sm',
          empty
            ? 'text-muted-foreground'
            : tone === 'destructive'
              ? 'text-destructive'
              : tone === 'warn'
                ? 'text-warn'
                : 'text-muted-foreground',
        )}
      >
        {icon}
        {label}
      </div>
      <p className="tabular mt-2 text-2xl font-semibold">{batches}</p>
      <p className="text-xs text-muted-foreground">
        {batches === 1 ? 'batch' : 'batches'} · {units.toLocaleString()} units
      </p>
    </div>
  )

  return href ? <Link href={href}>{body}</Link> : body
}

function buildHref(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const string = query.toString()
  return string ? `/batches?${string}` : '/batches'
}

function parseState(value: string | undefined): ExpiryState | undefined {
  const upper = value?.toUpperCase()
  return upper === 'EXPIRED' || upper === 'NEAR' || upper === 'OK'
    ? (upper as ExpiryState)
    : undefined
}
