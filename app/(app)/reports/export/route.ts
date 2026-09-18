import { requireUser } from '@/lib/auth/guards'
import { csvStream, csvStreamResponse, reportFilename } from '@/lib/export/csv'
import { xlsxResponse } from '@/lib/export/xlsx'
import { isReportKey, prepareExport } from '@/lib/services/report-export'
import { isListKey, prepareListExport } from '@/lib/services/list-export'
import type { StockGrain } from '@/lib/services/reports'

/**
 * Downloading a report, as CSV or XLSX.
 *
 * A Route Handler rather than a Server Action, for two reasons. XLSX is binary
 * and streamed, which an action returning a value cannot do without buffering
 * the whole workbook first. And a download wants a real `Content-Disposition`,
 * so the browser names the file rather than JavaScript guessing at it.
 *
 * Guarded by `requireUser()` — the session, not a bearer token. Being under the
 * authenticated shell means nothing here: a layout does not run for a route
 * handler, so this is a public URL until the guard says otherwise. (That gap is
 * now also covered by `npm run check:guards`, which previously globbed only
 * pages and `app/api` routes and would have missed this file entirely.)
 *
 * Node runtime, not edge: the XLSX writer streams through a Node stream.
 */
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const user = await requireUser()
  const params = new URL(request.url).searchParams

  const key = params.get('report') ?? ''
  const format = params.get('format') === 'xlsx' ? 'xlsx' : 'csv'

  // Two families behind one route: the summarised reports, and the underlying
  // list rows somebody asks for when a summary raises a question. Both produce
  // the same shape, so the formatting below does not care which it got.
  const prepared = isReportKey(key)
    ? await prepareExport(user.db, key, {
        siteId: params.get('siteId') || null,
        categoryId: params.get('categoryId') || null,
        grain: grainFrom(params.get('grain')),
        from: dateFrom(params.get('from')),
        to: endOfDay(dateFrom(params.get('to'))),
      })
    : isListKey(key)
      ? prepareListExport(user.db, key, {
          q: params.get('q'),
          type: params.get('type'),
          tracking: params.get('tracking'),
          low: params.get('low') === '1',
          siteId: params.get('siteId') || null,
        })
      : null

  if (!prepared) {
    return new Response('Unknown report.', { status: 404 })
  }

  if (format === 'xlsx') {
    return xlsxResponse(reportFilename(prepared.name, undefined, 'xlsx'), [
      { name: prepared.sheetName, columns: prepared.columns, rows: prepared.rows },
    ])
  }

  return csvStreamResponse(
    reportFilename(prepared.name, undefined, 'csv'),
    csvStream(prepared.rows, prepared.columns),
  )
}

const GRAINS: StockGrain[] = ['ITEM', 'LOCATION', 'BATCH']

function grainFrom(value: string | null): StockGrain | undefined {
  return GRAINS.includes(value as StockGrain) ? (value as StockGrain) : undefined
}

function dateFrom(value: string | null): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * The `to` date, inclusive.
 *
 * A date input gives midnight, so a range ending on the 18th would otherwise
 * exclude everything that happened on the 18th — an export that silently drops
 * its own last day, which is the day people most often care about.
 */
function endOfDay(value: Date | undefined): Date | undefined {
  if (!value) return undefined

  const end = new Date(value)
  end.setHours(23, 59, 59, 999)
  return end
}
