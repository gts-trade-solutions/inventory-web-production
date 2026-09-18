'use client'

import { useActionState, useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Printer } from 'lucide-react'
import { previewLabelAction, printLabelAction, type PrintState } from './actions'
import { LabelPreviewer } from './label-preview'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Mirrors the Prisma enum; a client component may not import its values. */
type LabelKind = 'ITEM' | 'BATCH' | 'SERIAL' | 'LOCATION' | 'PALLET'

interface Template {
  id: string
  name: string
  kind: LabelKind
  rfidEncode: boolean
  widthMm: number
  heightMm: number
}

/**
 * Choose a label, see it, print it.
 *
 * The preview comes back from the server as rendered ZPL rather than being
 * assembled here, so what is on screen is the job — not a second rendering that
 * can drift from the first.
 */
export function LabelStudio({
  templates,
  printers,
  items,
  batches,
  locations,
  selectedItemId,
  selectedBatchId,
}: {
  templates: Template[]
  printers: Array<{ id: string; label: string; simulated: boolean }>
  items: Array<{ id: string; sku: string; name: string }>
  batches: Array<{ id: string; batchNo: string; itemId: string }>
  locations: Array<{ id: string; code: string; name: string }>
  selectedItemId: string | null
  selectedBatchId: string | null
}) {
  const [state, formAction] = useActionState<PrintState, FormData>(printLabelAction, {})

  // Default to a label the current selection can actually fill. Arriving from
  // an item and landing on the batch template means the first thing the
  // operator sees is a refusal to print, which reads as the screen being broken
  // rather than as a sensible question.
  const [templateId, setTemplateId] = useState(
    (selectedBatchId
      ? templates.find((candidate) => candidate.kind === 'BATCH')
      : templates.find((candidate) => candidate.kind === 'ITEM' && !candidate.rfidEncode)
    )?.id ??
      templates[0]?.id ??
      '',
  )
  const [itemId, setItemId] = useState(selectedItemId ?? items[0]?.id ?? '')
  const [batchId, setBatchId] = useState(selectedBatchId ?? '')
  const [locationId, setLocationId] = useState('')
  const [printerId, setPrinterId] = useState(printers[0]?.id ?? '')
  const [copies, setCopies] = useState(1)

  const [preview, setPreview] = useState<{ zpl?: string; missing?: string[]; error?: string }>({})
  const [previewing, setPreviewing] = useState(false)

  const template = templates.find((candidate) => candidate.id === templateId)
  const batchesForItem = batches.filter((batch) => batch.itemId === itemId)

  // Re-render whenever any input changes, so the preview is never stale — a
  // preview showing the previous item is worse than none.
  useEffect(() => {
    if (!templateId) return

    let cancelled = false
    setPreviewing(true)

    previewLabelAction({
      templateId,
      itemId: itemId || undefined,
      batchId: batchId || undefined,
      locationId: locationId || undefined,
    })
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false)
      })

    return () => {
      cancelled = true
    }
  }, [templateId, itemId, batchId, locationId])

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Print a label</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="templateId">Label</Label>
              <select
                id="templateId"
                name="templateId"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {templates.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} · {option.widthMm}×{option.heightMm}mm
                    {option.rfidEncode ? ' · RFID' : ''}
                  </option>
                ))}
              </select>
              {template?.rfidEncode && (
                <p className="text-xs text-muted-foreground">
                  Each label gets its own tag number, allocated by the server. Two labels never
                  carry the same one.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="itemId">Item</Label>
              <select
                id="itemId"
                name="itemId"
                value={itemId}
                onChange={(event) => {
                  setItemId(event.target.value)
                  setBatchId('')
                }}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">None</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.sku} — {item.name}
                  </option>
                ))}
              </select>
            </div>

            {batchesForItem.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="batchId">Batch</Label>
                <select
                  id="batchId"
                  name="batchId"
                  value={batchId}
                  onChange={(event) => setBatchId(event.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {batchesForItem.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.batchNo}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* A location label needs a bin, and nothing else can supply it. */}
            {locations.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="locationId">Location</Label>
                <select
                  id="locationId"
                  name="locationId"
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.code} — {location.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="printerDeviceId">Printer</Label>
                <select
                  id="printerDeviceId"
                  name="printerDeviceId"
                  value={printerId}
                  onChange={(event) => setPrinterId(event.target.value)}
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {printers.map((printer) => (
                    <option key={printer.id} value={printer.id}>
                      {printer.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="copies">Copies</Label>
                <Input
                  id="copies"
                  name="copies"
                  type="number"
                  min={1}
                  max={99}
                  value={copies}
                  onChange={(event) => setCopies(Number(event.target.value) || 1)}
                />
              </div>
            </div>

            {state.error && (
              <Alert variant="destructive">
                <AlertCircle className="size-4" />
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            )}

            {state.result && (
              <Alert>
                <CheckCircle2 className="size-4 text-ok" />
                <AlertDescription>
                  <span className="font-medium">{state.result.docNo}</span> — {state.result.message}
                  {state.result.status === 'SENT' && (
                    // Said out loud, because "sent" is genuinely all we know.
                    <span className="mt-1 block text-xs">
                      The printer accepted the job. Check that a label came out — a network printer
                      cannot tell us.
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <PrintButton
              disabled={printers.length === 0 || !preview.zpl}
              simulated={printers.find((printer) => printer.id === printerId)?.simulated ?? false}
            />

            {printers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No printer is set up. Add one under Devices.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Preview
            {previewing && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Drawn from the exact bytes that will be sent to the printer.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {preview.error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{preview.error}</AlertDescription>
            </Alert>
          )}

          {preview.missing && preview.missing.length > 0 && (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertDescription>
                This label needs {preview.missing.join(', ')}. Choose something that has{' '}
                {preview.missing.length === 1 ? 'it' : 'them'} — it will not be printed blank.
              </AlertDescription>
            </Alert>
          )}

          {preview.zpl && (
            <>
              <LabelPreviewer zpl={preview.zpl} />

              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  Show the ZPL that will be sent
                </summary>
                <pre className="tabular mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  {preview.zpl}
                </pre>
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PrintButton({ disabled, simulated }: { disabled: boolean; simulated: boolean }) {
  const { pending } = useFormStatus()

  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={pending || disabled}>
        {pending ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />
            Printing…
          </>
        ) : (
          <>
            <Printer className="mr-2 size-4" />
            Print
          </>
        )}
      </Button>

      {/* Never hidden, so nobody mistakes a demo for a live system. */}
      {simulated && <Badge variant="demo">Simulated printer</Badge>}
    </div>
  )
}
