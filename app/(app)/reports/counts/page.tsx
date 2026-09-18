import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { countAccuracy } from '@/lib/services/reports'
import { PageHeader } from '@/components/page-header'
import { ReportFilters, filterOptions } from '../filters'
import { ReportDownload } from '../download'
import { countsCsvAction } from '../actions'
import { defaultRange, endOfDay } from '../range'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Count accuracy' }

export default async function CountAccuracyPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; siteId?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams
  const { from, to } = defaultRange(params)

  const [report, options] = await Promise.all([
    countAccuracy(
      user.db,
      { from: new Date(from), to: endOfDay(to) },
      { siteId: params.siteId || null },
    ),
    filterOptions(user.db),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Count accuracy"
        description="Scored by LINES, not units. One line out by 500 and one line out by 1 are both one thing somebody has to investigate, and a unit-weighted figure lets a single bulk item hide a dozen real discrepancies."
      />

      <ReportFilters
        options={options}
        current={{ ...params, from, to }}
        show={{ dates: true, site: true, category: false }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {report.totals.sessions} session{report.totals.sessions === 1 ? '' : 's'} ·{' '}
          {report.totals.lines} line{report.totals.lines === 1 ? '' : 's'} ·{' '}
          <strong className="font-medium text-foreground">
            {report.totals.accuracy.toFixed(1)}% accurate
          </strong>{' '}
          overall
        </p>
        <ReportDownload build={countsCsvAction.bind(null, { from, to, siteId: params.siteId })} />
      </div>

      {report.rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          No counts were started in this period.
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Variances</TableHead>
                <TableHead className="text-right">Units out</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.sessionId}>
                  <TableCell className="tabular">
                    {row.startedAt.toISOString().slice(0, 10)}
                  </TableCell>
                  <TableCell className="tabular">{row.locationCode}</TableCell>
                  <TableCell>{row.method}</TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell className="tabular text-right">{row.linesCounted}</TableCell>
                  <TableCell className="tabular text-right">
                    {row.linesWithVariance || '—'}
                  </TableCell>
                  <TableCell className="tabular text-right">{row.unitsOut || '—'}</TableCell>
                  <TableCell
                    className={cn(
                      'tabular text-right',
                      row.accuracy < 95 && row.linesCounted > 0 && 'text-warn',
                    )}
                  >
                    {row.linesCounted === 0 ? '—' : `${row.accuracy.toFixed(0)}%`}
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
