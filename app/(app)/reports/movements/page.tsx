import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { movementSummary } from '@/lib/services/reports'
import { PageHeader } from '@/components/page-header'
import { ReportFilters, filterOptions } from '../filters'
import { ReportDownload } from '../download'
import { movementsCsvAction } from '../actions'
import { defaultRange, endOfDay } from '../range'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const metadata: Metadata = { title: 'Movement summary' }

export default async function MovementsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; siteId?: string; categoryId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const { from, to } = defaultRange(params)

  const [report, options] = await Promise.all([
    movementSummary(
      user.db,
      { from: new Date(from), to: endOfDay(to) },
      { siteId: params.siteId || null, categoryId: params.categoryId || null },
    ),
    filterOptions(user.db),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Movement summary"
        description="Straight from the ledger, which is append-only — so a total for a past period cannot change after the fact. Quantities are as recorded; the direction is the type."
      />

      <ReportFilters
        options={options}
        current={{ ...params, from, to }}
        show={{ dates: true, site: true, category: true }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.totals.movements} movement{report.totals.movements === 1 ? '' : 's'} between{' '}
          {from} and {to}
        </p>
        <ReportDownload
          build={movementsCsvAction.bind(null, {
            from,
            to,
            siteId: params.siteId,
            categoryId: params.categoryId,
          })}
        />
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Movements</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Items touched</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row) => (
              <TableRow key={row.type}>
                <TableCell className="font-medium">{row.type}</TableCell>
                {/* Zero rows are kept deliberately: "no scraps this period" is
                    a finding, and a missing row is ambiguous. */}
                <TableCell className="tabular text-right">{row.movements || '—'}</TableCell>
                <TableCell className="tabular text-right">{row.quantity || '—'}</TableCell>
                <TableCell className="tabular text-right">{row.items || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
