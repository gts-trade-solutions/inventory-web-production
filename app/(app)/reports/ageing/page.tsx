import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { stockAgeing } from '@/lib/services/reports'
import { PageHeader } from '@/components/page-header'
import { ReportFilters, filterOptions } from '../filters'
import { ReportDownload } from '../download'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Info } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const metadata: Metadata = { title: 'Stock ageing' }

export default async function AgeingReportPage({
  searchParams,
}: {
  searchParams: Promise<{ siteId?: string; categoryId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [report, options] = await Promise.all([
    stockAgeing(user.db, {
      siteId: params.siteId || null,
      categoryId: params.categoryId || null,
    }),
    filterOptions(user.db),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Stock ageing"
        description="How long stock has been sitting, from the date its batch was received."
      />

      <ReportFilters options={options} current={params} show={{ site: true, category: true }} />

      {report.unknown.lines > 0 && (
        <Alert>
          <Info />
          <AlertDescription>
            <strong className="font-medium">
              {report.unknown.quantity} unit{report.unknown.quantity === 1 ? '' : 's'} have no
              knowable age.
            </strong>{' '}
            For an item tracked as NONE the ledger records quantities, not units: ten received in
            March and ten in September are one number, and nothing says which ten are still on the
            shelf. Assuming the oldest went first would give a confident wrong answer, and an ageing
            report is how stock gets written off. Turn on batch tracking for an item if you need its
            age.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          {report.buckets.map((bucket) => (
            <span key={bucket.label}>
              <span className="font-medium text-foreground">{bucket.label}d</span>{' '}
              {bucket.quantity || '—'}
            </span>
          ))}
          <span>
            <span className="font-medium text-foreground">Unknown</span>{' '}
            {report.unknown.quantity || '—'}
          </span>
        </div>
        <ReportDownload report="ageing" params={params} />
      </div>

      {report.rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Nothing on hand matches these filters.
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead>Bucket</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={`${row.itemId}${row.batchNo ?? ''}${row.locationCode}`}>
                  <TableCell className="tabular">{row.sku}</TableCell>
                  <TableCell>{row.itemName}</TableCell>
                  <TableCell className="tabular">{row.batchNo ?? '—'}</TableCell>
                  <TableCell className="tabular">{row.locationCode}</TableCell>
                  <TableCell className="tabular text-right">{row.quantity}</TableCell>
                  <TableCell className="tabular text-right">
                    {/* A dash, never 0: an unknown age is not "arrived today". */}
                    {row.ageDays === null ? '—' : `${row.ageDays}d`}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.bucket}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
