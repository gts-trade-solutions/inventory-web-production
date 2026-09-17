'use client'

import { startTransition, useActionState, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Minus, Plus, ScanLine, Send } from 'lucide-react'
import { resolveCountScanAction, submitCountAction, type CountActionState } from '../actions'
import type { CountRow } from '@/lib/services/count-queries'
import { KeyboardWedge, shouldIgnoreTarget } from '@/lib/devices/browser/keyboard-wedge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

/**
 * The counting sheet.
 *
 * Starts as a checklist of what the system expects at this location, because
 * counting from nothing means an item that is missing entirely is never noticed
 * — and a missing item is the variance that matters most.
 *
 * Scanning increments a row. Anything scanned that was not expected is added as
 * a new row with expected 0, since a stray from another aisle is a real finding
 * in the other direction.
 *
 * Nothing here writes to the ledger. Submitting stores the variance for a
 * supervisor (WADR-008).
 */

interface Tally {
  key: string
  itemId: string
  batchId: string | null
  itemName: string
  itemSku: string
  unit: string
  batchNo: string | null
  expected: number
  counted: number
  /** Not on the original checklist. */
  unexpected: boolean
}

const keyOf = (itemId: string, batchId: string | null) => `${itemId}:${batchId ?? 'none'}`

export function CountingSheet({
  sessionId,
  rows,
  locationCode,
}: {
  sessionId: string
  rows: CountRow[]
  locationCode: string
}) {
  const [state, dispatch, pending] = useActionState<CountActionState, FormData>(
    submitCountAction,
    {},
  )

  const [tallies, setTallies] = useState<Tally[]>(() =>
    rows.map((row) => ({
      key: keyOf(row.itemId, row.batchId),
      itemId: row.itemId,
      batchId: row.batchId,
      itemName: row.itemName,
      itemSku: row.itemSku,
      unit: row.unit,
      batchNo: row.batchNo,
      expected: row.expected,
      counted: 0,
      unexpected: false,
    })),
  )

  const [scanNote, setScanNote] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const setCounted = (key: string, next: number) =>
    setTallies((current) =>
      current.map((tally) =>
        tally.key === key ? { ...tally, counted: Math.max(0, next) } : tally,
      ),
    )

  /** A scan adds one to the matching row, or creates one if it is a stray. */
  const applyScan = useCallback(
    async (code: string) => {
      setScanning(true)
      try {
        const result = await resolveCountScanAction(code)

        if (!result || result.kind === 'UNKNOWN' || result.kind === 'LOCATION') {
          setScanNote(`${code} is not an item here.`)
          return
        }

        const itemId = result.kind === 'ITEM' ? result.item.id : result.item.id
        const batchId = result.kind === 'BATCH' ? result.batch.id : null
        // A case barcode means a carton, so it counts as its pack quantity.
        const increment = result.kind === 'ITEM' ? result.packSize : 1

        setTallies((current) => {
          const key = keyOf(itemId, batchId)
          const existing = current.find((tally) => tally.key === key)

          if (existing) {
            setScanNote(`${existing.itemName} +${increment}`)
            return current.map((tally) =>
              tally.key === key ? { ...tally, counted: tally.counted + increment } : tally,
            )
          }

          // Not expected here. Recorded rather than ignored: a stray that belongs
          // in another aisle is exactly what a count is meant to surface.
          setScanNote(`${result.item.name} is not expected at ${locationCode} — added`)
          return [
            ...current,
            {
              key,
              itemId,
              batchId,
              itemName: result.item.name,
              itemSku: result.item.sku,
              unit: result.item.unit,
              batchNo: result.kind === 'BATCH' ? result.batch.batchNo : null,
              expected: 0,
              counted: increment,
              unexpected: true,
            },
          ]
        })
      } finally {
        setScanning(false)
      }
    },
    [locationCode],
  )

  useEffect(() => {
    const wedge = new KeyboardWedge()

    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreTarget(event.target)) return
      // A quantity box is where somebody types on purpose.
      if (event.target instanceof HTMLInputElement && event.target.type === 'number') return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const result = wedge.accept({ key: event.key, at: event.timeStamp })
      if (result.kind === 'SCAN') {
        event.preventDefault()
        void applyScan(result.data)
      } else if (result.kind === 'BUFFERING') {
        event.preventDefault()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [applyScan])

  const progress = useMemo(() => {
    let matched = 0
    let short = 0
    let over = 0

    for (const tally of tallies) {
      const difference = tally.counted - tally.expected
      if (difference === 0) matched++
      else if (difference < 0) short++
      else over++
    }

    return { matched, short, over }
  }, [tallies])

  if (state.message) {
    return (
      <Alert>
        <CheckCircle2 className="text-ok" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm',
          scanning ? 'border-primary bg-primary/5' : 'bg-muted/30',
        )}
      >
        <ScanLine className={cn('size-4', scanning && 'animate-scan-pulse text-primary')} />
        <span className="flex-1">
          {scanNote ?? 'Scan items to count them, or type quantities.'}
        </span>
        <span className="flex gap-2 text-xs">
          <Badge variant="ok">{progress.matched} match</Badge>
          <Badge variant="warn">{progress.short} short</Badge>
          <Badge variant="secondary">{progress.over} over</Badge>
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead className="text-right">Expected</TableHead>
              <TableHead className="w-44 text-right">Counted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tallies.map((tally) => {
              const difference = tally.counted - tally.expected

              return (
                <TableRow key={tally.key} className={cn(tally.unexpected && 'bg-warn/5')}>
                  <TableCell>
                    <span className="font-medium">{tally.itemName}</span>
                    <span className="tabular block text-xs text-muted-foreground">
                      {tally.itemSku}
                      {tally.unexpected && ' · not expected here'}
                    </span>
                  </TableCell>
                  <TableCell className="tabular text-sm">{tally.batchNo ?? '—'}</TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {tally.expected}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="size-8 shrink-0"
                        aria-label={`One fewer ${tally.itemName}`}
                        onClick={() => setCounted(tally.key, tally.counted - 1)}
                      >
                        <Minus />
                      </Button>
                      <Input
                        type="number"
                        min={0}
                        value={tally.counted}
                        aria-label={`Counted ${tally.itemName}`}
                        onChange={(event) => setCounted(tally.key, Number(event.target.value))}
                        className="tabular h-8 w-16 text-center"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="size-8 shrink-0"
                        aria-label={`One more ${tally.itemName}`}
                        onClick={() => setCounted(tally.key, tally.counted + 1)}
                      >
                        <Plus />
                      </Button>
                      <span
                        className={cn(
                          'tabular w-10 shrink-0 text-right text-xs',
                          difference === 0 && 'text-muted-foreground',
                          difference < 0 && 'text-warn',
                          difference > 0 && 'text-primary',
                        )}
                      >
                        {difference > 0 ? `+${difference}` : difference === 0 ? '—' : difference}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={pending}
          onClick={() => {
            const data = new FormData()
            data.set('sessionId', sessionId)
            data.set(
              'counted',
              JSON.stringify(
                tallies.map((tally) => ({
                  itemId: tally.itemId,
                  batchId: tally.batchId,
                  quantity: tally.counted,
                })),
              ),
            )
            startTransition(() => dispatch(data))
          }}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Send />}
          {pending ? 'Submitting…' : 'Submit for approval'}
        </Button>

        <p className="text-sm text-muted-foreground">
          Submitting changes no stock. A supervisor reviews the variance and decides.
        </p>
      </div>
    </div>
  )
}
