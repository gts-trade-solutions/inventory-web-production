'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Usb } from 'lucide-react'
import { WebHidScanner, isWebHidAvailable, type WebHidStatus } from '@/lib/devices/browser/webhid'
import type { BarcodeScan } from '@/lib/devices/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * The Tier 2 offer.
 *
 * Connecting a scanner directly gives us the symbology and the device's
 * identity, which the keyboard wedge can never provide. It is offered, never
 * required: this component is additive, and Tier 1 keeps running underneath
 * whether or not anybody presses the button (DEVICE_INTEGRATION §4).
 *
 * It renders nothing at all in a browser without WebHID, rather than showing a
 * disabled control. A button that cannot ever work is a support question.
 */
export function ScannerConnection({
  onScan,
  onNotice,
}: {
  onScan: (scan: BarcodeScan) => void
  onNotice?: (message: string) => void
}) {
  const [status, setStatus] = useState<WebHidStatus>({ kind: 'IDLE' })
  const [connecting, setConnecting] = useState(false)
  const [available, setAvailable] = useState(false)
  const scannerRef = useRef<WebHidScanner | null>(null)

  // Checked after mount: `navigator` does not exist while the server renders,
  // and guessing during render would mismatch the hydrated markup.
  useEffect(() => setAvailable(isWebHidAvailable()), [])

  useEffect(() => {
    if (!available) return

    const scanner = new WebHidScanner({ onScan, onNotice, onStatus: setStatus })
    scannerRef.current = scanner

    // A scanner already granted on this origin reattaches with no prompt, so a
    // reload does not make the operator pick it again.
    void scanner.reconnect()

    return () => {
      scannerRef.current = null
      void scanner.disconnect()
    }
  }, [available, onScan, onNotice])

  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      // Must happen inside the click: browsers refuse the permission prompt
      // otherwise, and that refusal looks exactly like "no scanner found".
      await scannerRef.current?.connect()
    } finally {
      setConnecting(false)
    }
  }, [])

  if (!available) return null

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <Usb className="size-4 text-muted-foreground" />

      {status.kind === 'CONNECTED' ? (
        <>
          <span className="flex-1">
            Connected to <span className="font-medium">{status.name}</span>. Scans carry their
            symbology.
          </span>
          <Badge variant="ok">Direct</Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void scannerRef.current?.disconnect()}
          >
            Disconnect
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 text-muted-foreground">
            {status.kind === 'FAILED'
              ? status.reason
              : 'Scanning already works with a scanner paired as a keyboard. Connecting one directly also captures the symbology.'}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={connect} disabled={connecting}>
            {connecting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Waiting…
              </>
            ) : (
              'Connect a scanner'
            )}
          </Button>
        </>
      )}
    </div>
  )
}
