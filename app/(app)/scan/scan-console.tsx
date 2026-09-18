'use client'

import { startTransition, useActionState, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Layers, MapPin, Package, Radio, ScanLine, SearchX, Send } from 'lucide-react'
import { scanAction, type ScanState } from './actions'
import type { ScanResolution } from '@/lib/services/scan'
import { KeyboardWedge, shouldIgnoreTarget } from '@/lib/devices/browser/keyboard-wedge'
import type { BarcodeScan } from '@/lib/devices/types'
import { ScannerConnection } from './scanner-connection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Scan-anywhere.
 *
 * A scanner paired as an HID keyboard types into whatever has focus, so this
 * listens at the document and recognises scans by timing
 * (DEVICE_INTEGRATION.md §3). No pairing, no driver, no permission prompt — it
 * works today with any Zebra Bluetooth scanner and no hardware here at all,
 * which is why Tier 1 is the floor the whole device layer stands on.
 *
 * There is a manual box as well. Not a fallback for missing hardware so much as
 * the normal way to work at a desk, and the only way to test this without a
 * scanner.
 */
export function ScanConsole({ demoBarcodes }: { demoBarcodes: string[] }) {
  const [state, dispatch, pending] = useActionState<ScanState, FormData>(scanAction, {
    history: [],
  })

  const [armed, setArmed] = useState(false)
  const [pendingChars, setPendingChars] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const manualRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(
    (code: string) => {
      const data = new FormData()
      data.set('code', code)
      // useActionState requires a transition; without one isPending never
      // updates, so the indicator would never show "Looking up…".
      startTransition(() => dispatch(data))
    },
    [dispatch],
  )

  useEffect(() => {
    const wedge = new KeyboardWedge()
    let clearPending: ReturnType<typeof setTimeout> | undefined

    function onKeyDown(event: KeyboardEvent) {
      // A scanner aimed at a password box or a textarea is aimed there on
      // purpose; stealing that input would be maddening.
      if (shouldIgnoreTarget(event.target)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const result = wedge.accept({ key: event.key, at: event.timeStamp })

      if (result.kind === 'SCAN') {
        event.preventDefault()
        setArmed(true)
        setPendingChars('')
        submit(result.data)
        return
      }

      if (result.kind === 'BUFFERING') {
        // Held back so the characters do not land in whatever has focus and
        // then get replaced when the terminator arrives.
        event.preventDefault()
        setPendingChars(wedge.pending)

        clearTimeout(clearPending)
        clearPending = setTimeout(() => setPendingChars(''), 400)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      clearTimeout(clearPending)
    }
  }, [submit])

  // A Tier 2 scan takes the same path as a Tier 1 one. The tier decides what we
  // KNOW about a scan, never what happens to it.
  const onDirectScan = useCallback(
    (scan: BarcodeScan) => {
      setArmed(true)
      setPendingChars('')
      submit(scan.data)
    },
    [submit],
  )

  const latest = state.history[0]

  return (
    <div className="space-y-5">
      <ScanIndicator armed={armed} pending={pendingChars} busy={pending} />

      <ScannerConnection onScan={onDirectScan} />

      <form
        ref={formRef}
        action={dispatch}
        className="flex gap-2"
        onSubmit={() => setTimeout(() => manualRef.current?.select(), 0)}
      >
        <Input
          ref={manualRef}
          name="code"
          placeholder="Or type a barcode, EPC, serial, batch or location…"
          aria-label="Enter a code manually"
          autoComplete="off"
          // Excluded from the wedge listener: this box is where someone types on
          // purpose, and a scan into it works through normal keyboard entry.
          data-no-scan="true"
        />
        <Button type="submit" disabled={pending}>
          <Send />
          Look up
        </Button>
      </form>

      {demoBarcodes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Try:</span>
          {demoBarcodes.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => submit(code)}
              className="tabular rounded border px-2 py-1 transition-colors hover:bg-accent"
            >
              {code}
            </button>
          ))}
        </div>
      )}

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}

      {latest && <ScanResult key={latest.at} entry={latest} primary />}

      {state.history.length > 1 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Earlier</p>
          {state.history.slice(1).map((entry) => (
            <ScanResult key={entry.at} entry={entry} />
          ))}
        </div>
      )}

      {state.history.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <ScanLine className="size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Ready to scan</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Pair any Zebra scanner as a Bluetooth keyboard and scan — nothing to install. Item
              barcodes, case barcodes, RFID tags, serial numbers, batch labels and location labels
              all resolve here.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ScanIndicator({
  armed,
  pending,
  busy,
}: {
  armed: boolean
  pending: string
  busy: boolean
}) {
  const active = pending.length > 0 || busy

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
        active ? 'border-primary bg-primary/5' : 'bg-muted/30',
      )}
    >
      <ScanLine className={cn('size-4 shrink-0', active && 'animate-scan-pulse text-primary')} />
      <span className="min-w-0 flex-1">
        {busy ? (
          'Looking up…'
        ) : pending ? (
          <span className="tabular">Reading {pending}…</span>
        ) : armed ? (
          'Scanner listening'
        ) : (
          // Stated plainly, because a listener that silently is not listening is
          // the worst possible failure on a warehouse floor.
          'Scanner listening — scan anywhere on this page'
        )}
      </span>
    </div>
  )
}

function ScanResult({
  entry,
  primary,
}: {
  entry: { code: string; at: string; result: ScanResolution }
  primary?: boolean
}) {
  const { result } = entry

  return (
    <Card className={cn(primary && 'border-primary/40')}>
      <CardContent className={cn('flex items-start gap-3', primary ? 'py-5' : 'py-3')}>
        <Icon result={result} />

        <div className="min-w-0 flex-1">
          <Body result={result} primary={primary} />
          <p className="tabular mt-1 text-xs text-muted-foreground">
            {entry.code} · {new Date(entry.at).toLocaleTimeString()}
          </p>
        </div>

        <Action result={result} />
      </CardContent>
    </Card>
  )
}

function Icon({ result }: { result: ScanResolution }) {
  const className = 'mt-0.5 size-5 shrink-0 text-muted-foreground'

  if (result.kind === 'SERIAL') return <Radio className={className} />
  if (result.kind === 'BATCH') return <Layers className={className} />
  if (result.kind === 'LOCATION') return <MapPin className={className} />
  if (result.kind === 'UNKNOWN') return <SearchX className={cn(className, 'text-destructive')} />
  return <Package className={className} />
}

function Body({ result, primary }: { result: ScanResolution; primary?: boolean }) {
  const title = cn('font-medium', primary && 'text-lg')

  switch (result.kind) {
    case 'ITEM':
      return (
        <>
          <p className={title}>{result.item.name}</p>
          <p className="text-sm text-muted-foreground">
            <span className="tabular">{result.item.sku}</span> ·{' '}
            <span className="tabular">{result.item.onHand}</span> {result.item.unit} on hand
            {result.packSize > 1 && (
              <Badge variant="secondary" className="ml-2">
                Case of {result.packSize}
              </Badge>
            )}
            {result.item.onHand <= result.item.reorderPoint && (
              <Badge variant="warn" className="ml-2">
                Low
              </Badge>
            )}
          </p>
        </>
      )

    case 'SERIAL':
      return (
        <>
          <p className={title}>
            <span className="tabular">{result.unit.serialNo}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {result.item.name} ·{' '}
            <Badge variant={result.unit.status === 'IN_STOCK' ? 'ok' : 'secondary'}>
              {result.unit.status.replace('_', ' ')}
            </Badge>
            {result.unit.locationCode && (
              <>
                {' '}
                at <span className="tabular">{result.unit.locationCode}</span>
              </>
            )}
          </p>
        </>
      )

    case 'BATCH':
      return (
        <>
          <p className={title}>
            <span className="tabular">{result.batch.batchNo}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {result.item.name} · <span className="tabular">{result.batch.onHand}</span> on hand
            {result.batch.expiryState === 'EXPIRED' && (
              <Badge variant="destructive" className="ml-2">
                Expired
              </Badge>
            )}
            {result.batch.expiryState === 'NEAR' && (
              <Badge variant="warn" className="ml-2">
                Near expiry
              </Badge>
            )}
          </p>
        </>
      )

    case 'LOCATION':
      return (
        <>
          <p className={title}>
            <span className="tabular">{result.location.code}</span> — {result.location.name}
          </p>
          <p className="text-sm text-muted-foreground">
            {result.location.zone} · {result.location.distinctItems} item
            {result.location.distinctItems === 1 ? '' : 's'} held here
          </p>
        </>
      )

    case 'UNKNOWN':
      return (
        <>
          <p className={cn(title, 'text-destructive')}>Not recognised</p>
          <p className="text-sm text-muted-foreground">
            {result.looksLikeEpc
              ? 'A valid RFID tag, but no unit on record carries it — it may belong to another site, or to stock never received here.'
              : 'No item, batch, serial number or location matches this code.'}
          </p>
        </>
      )
  }
}

function Action({ result }: { result: ScanResolution }) {
  const href =
    result.kind === 'ITEM'
      ? `/movements/new?item=${result.item.id}`
      : result.kind === 'SERIAL'
        ? `/serials/${result.unit.id}`
        : result.kind === 'BATCH'
          ? `/batches/${result.batch.id}`
          : null

  if (!href) return null

  return (
    <Button asChild size="sm" variant="outline" className="shrink-0">
      <Link href={href}>
        {result.kind === 'ITEM' ? 'Record' : 'Open'}
        <ArrowRight />
      </Link>
    </Button>
  )
}
