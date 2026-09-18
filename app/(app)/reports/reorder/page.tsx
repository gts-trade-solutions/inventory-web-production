import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { reorderReport } from '@/lib/services/reports'
import { PageHeader } from '@/components/page-header'
import { ReportFilters, filterOptions } from '../filters'
import { ReportDownload } from '../download'
import { reorderCsvAction } from '../actions'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Reorder' }

export default async function ReorderReportPage({
  searchParams,
}: {
  searchParams: Promise<{ siteId?: string; categoryId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [report, options] = await Promise.all([
    reorderReport(user.db, {
      siteId: params.siteId || null,
      categoryId: params.categoryId || null,
    }),
    filterOptions(user.db),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Reorder"
        description="Items at or below their reorder point, most short first. Items with no reorder point set are left out — 0 means nobody set one, and a list of everything that happens to be empty is not a purchase list."
      />

      <ReportFilters options={options} current={params} show={{ site: true, category: true }} />

      {params.siteId && (
        <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          The quantity on hand is filtered to this site, but the reorder point is set per item
          across the whole business. Short figures here read as &ldquo;short in this site against
          the item&rsquo;s overall point&rdquo;, which is what you want for one warehouse and
          misleading across several.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.totals.items} item{report.totals.items === 1 ? '' : 's'} to order
          {report.totals.outOfStock > 0 && (
            <>
              {' · '}
              <span className="font-medium text-destructive">
                {report.totals.outOfStock} out of stock
              </span>
            </>
          )}
        </p>
        <ReportDownload
          build={reorderCsvAction.bind(null, {
            siteId: params.siteId,
            categoryId: params.categoryId,
          })}
        />
      </div>

      {report.rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Nothing is at or below its reorder point.
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reorder at</TableHead>
                <TableHead className="text-right">Short by</TableHead>
                <TableHead className="text-right">Suggested order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.itemId} className={cn(row.onHand <= 0 && 'bg-destructive/5')}>
                  <TableCell className="tabular">{row.sku}</TableCell>
                  <TableCell>
                    {row.itemName}
                    {row.onHand <= 0 && (
                      <Badge variant="destructive" className="ml-2">
                        Out of stock
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {row.onHand} {row.unit}
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {row.reorderPoint}
                  </TableCell>
                  <TableCell className="tabular text-right font-medium">{row.shortBy}</TableCell>
                  <TableCell className="tabular text-right">
                    {/* A dash, not a guess. Without a maximum level there is no
                        basis for suggesting a quantity. */}
                    {row.suggested === null ? '—' : row.suggested}
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
