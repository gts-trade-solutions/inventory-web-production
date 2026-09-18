'use client'

import { useState, useTransition } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { ReportCsv } from './actions'
import { Button } from '@/components/ui/button'

/**
 * Downloads a report as CSV.
 *
 * The file is built on the server by the same call that rendered the table, and
 * handed back as a string for the browser to save. That keeps the export on the
 * session-authenticated Server Action path rather than opening a second route
 * with its own guard to get wrong.
 */
export function ReportDownload({ build }: { build: () => Promise<ReportCsv> }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const download = () => {
    setError(null)

    start(async () => {
      try {
        const { filename, csv } = await build()

        // The BOM is what makes Excel open a UTF-8 CSV correctly. Without it,
        // any non-ASCII name arrives mangled — and the person who opens the
        // file has no way to tell that the export was fine.
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)

        const link = document.createElement('a')
        link.href = url
        link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`
        link.click()

        URL.revokeObjectURL(url)
      } catch {
        setError('The export could not be built. Try narrowing the filters.')
      }
    })
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-sm text-destructive">{error}</span>}
      <Button type="button" variant="outline" onClick={download} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Download />}
        Download CSV
      </Button>
    </div>
  )
}
