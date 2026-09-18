import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { stockOnHand, type StockGrain } from '@/lib/services/reports'
import { PageHeader } from '@/components/page-header'
import { ReportFilters, filterOptions } from '../filters'
import { ReportDownload } from '../download'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Stock on hand' }

const GRAINS: StockGrain[] = ['ITEM', 'LOCATION', 'BATCH']

export default async function StockReportPage({
  searchParams,
}: {
  searchParams: Promise<{ grain?: string; siteId?: string; categoryId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const grain: StockGrain = GRAINS.includes(params.grain as StockGrain)
    ? (params.grain as StockGrain)
    : 'ITEM'

  const [report, options] = await Promise.all([
    stockOnHand(user.db, grain, {
      siteId: params.siteId || null,
      categoryId: params.categoryId || null,
    }),
    filterOptions(user.db),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Stock on hand"
        description="From stock_levels, the projection of the ledger that the nightly sweep checks. Empty lines are left out; negative ones are not."
      />

      <ReportFilters
        options={options}
        current={params}
        show={{ grain: true, site: true, category: true }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.totals.lines} line{report.totals.lines === 1 ? '' : 's'} · {report.totals.items}{' '}
          item{report.totals.items === 1 ? '' : 's'} · {report.totals.quantity} unit
          {report.totals.quantity === 1 ? '' : 's'} on hand
        </p>
        <ReportDownload report="stock" params={{ ...params, grain }} />
      </div>

      {report.rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                {grain !== 'ITEM' && <TableHead>Location</TableHead>}
                {grain === 'BATCH' && <TableHead>Batch</TableHead>}
                <TableHead className="text-right">Quantity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow
                  key={`${row.itemId}${row.locationCode ?? ''}${row.batchNo ?? ''}`}
                  className={cn(row.quantity < 0 && 'bg-destructive/5')}
                >
                  <TableCell className="tabular">{row.sku}</TableCell>
                  <TableCell>{row.itemName}</TableCell>
                  {grain !== 'ITEM' && (
                    <TableCell className="tabular">{row.locationCode}</TableCell>
                  )}
                  {grain === 'BATCH' && (
                    <TableCell className="tabular">{row.batchNo ?? '—'}</TableCell>
                  )}
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      // A negative line is stock the system thinks is owed. It
                      // is the one row in the report somebody has to chase.
                      row.quantity < 0 && 'font-medium text-destructive',
                    )}
                  >
                    {row.quantity} {row.unit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function Empty() {
  return (
    <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
      Nothing on hand matches these filters.
    </p>
  )
}
