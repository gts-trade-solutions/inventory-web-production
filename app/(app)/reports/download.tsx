import { Download } from 'lucide-react'
import type { ReportKey } from '@/lib/services/report-export'
import type { ListKey } from '@/lib/services/list-export'
import { Button } from '@/components/ui/button'

/**
 * Download links for a report.
 *
 * Plain anchors to the export route, not a button that fetches. The browser
 * handles the download, `Content-Disposition` names the file, and the XLSX
 * arrives as a stream rather than being buffered into memory first — none of
 * which is possible through a Server Action returning a value.
 *
 * It also means the export URL is a real URL: it can be bookmarked, scripted,
 * or handed to somebody who needs the same figures tomorrow.
 */
export function ReportDownload({
  report,
  params,
}: {
  report: ReportKey | ListKey
  /** The filters the screen is currently showing, so the file matches it. */
  params: Record<string, string | undefined>
}) {
  const query = new URLSearchParams({ report })

  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }

  const href = (format: 'csv' | 'xlsx') => {
    const withFormat = new URLSearchParams(query)
    withFormat.set('format', format)
    return `/reports/export?${withFormat.toString()}`
  }

  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm">
        {/* download, so a browser that would rather render the CSV saves it. */}
        <a href={href('csv')} download>
          <Download />
          CSV
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={href('xlsx')} download>
          <Download />
          Excel
        </a>
      </Button>
    </div>
  )
}
