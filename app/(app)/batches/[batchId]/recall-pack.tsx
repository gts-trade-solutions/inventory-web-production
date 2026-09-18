'use client'

import { useState } from 'react'
import { AlertTriangle, Download, FileSearch, Loader2 } from 'lucide-react'
import { recallPackAction, type RecallPackState } from './recall-actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The recall pack, from the batch screen.
 *
 * On the screen because that is where somebody is standing when a quality
 * incident starts. Behind an API it was reachable only by a developer, which is
 * the opposite of the point.
 */
export function RecallPack({ batchId, batchNo }: { batchId: string; batchNo: string }) {
  const [state, setState] = useState<RecallPackState>({})
  const [loading, setLoading] = useState(false)

  const build = async () => {
    setLoading(true)
    try {
      setState(await recallPackAction(batchId))
    } finally {
      setLoading(false)
    }
  }

  const download = () => {
    if (!state.csv) return

    // Built in the browser from what is already on screen, so the file is
    // exactly the pack that was reviewed rather than a second query that may
    // have moved on.
    const blob = new Blob(['﻿' + state.csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `recall-${batchNo}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSearch className="size-4 text-muted-foreground" />
          Recall pack
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Everywhere this batch is, everywhere it has been, and every unit it produced — in one
          sheet you can send on.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {state.error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {state.summary && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">{state.summary.onHand} on hand</Badge>
              <Badge variant="outline">{state.summary.movements} movements</Badge>
              {state.summary.issuedUnits > 0 && (
                <Badge variant="warn">{state.summary.issuedUnits} units have left stock</Badge>
              )}
            </div>

            {state.summary.balanced ? (
              <p className="text-sm text-muted-foreground">
                Received {state.summary.received}, issued {state.summary.issued}, scrapped{' '}
                {state.summary.scrapped}. The ledger balances against stock on hand.
              </p>
            ) : (
              // Not a footnote. Somebody signing this off has to see that the
              // arithmetic does not close.
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>
                  The ledger accounts for {state.summary.expectedOnHand} but{' '}
                  {state.summary.onHand} is on hand. Investigate before relying on this pack.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => void build()} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Building…
              </>
            ) : (
              'Build the recall pack'
            )}
          </Button>

          {state.csv && (
            <Button type="button" onClick={download}>
              <Download className="mr-2 size-4" />
              Download CSV
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
