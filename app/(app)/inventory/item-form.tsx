'use client'

import { startTransition, useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, Barcode, Loader2, Plus, Trash2 } from 'lucide-react'
import { saveItemAction, type ItemFormState } from './item-actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

type TrackingMode = 'NONE' | 'BATCH' | 'SERIAL'
type BarcodeType = 'EAN13' | 'ITF14' | 'CODE128' | 'QR' | 'OTHER'

interface BarcodeRow {
  barcode: string
  type: BarcodeType
  packSize: number
  isPrimary: boolean
}

export interface ItemFormValues {
  id?: string
  sku: string
  name: string
  unit: string
  categoryId: string | null
  reorderPoint: number
  maxLevel: number | null
  trackingMode: TrackingMode
  expiryRequired: boolean
  shelfLifeDays: number | null
  nearExpiryDays: number
  active: boolean
  barcodes: BarcodeRow[]
}

const TRACKING: Array<{ value: TrackingMode; label: string; blurb: string }> = [
  {
    value: 'NONE',
    label: 'Quantity only',
    blurb: 'Just a number per location. Right for consumables.',
  },
  {
    value: 'BATCH',
    label: 'Batch / lot',
    blurb: 'Stock is grouped into lots with expiry dates. Enables FEFO and recall.',
  },
  {
    value: 'SERIAL',
    label: 'Serial numbers',
    blurb: 'Every unit is tracked individually and can carry an RFID tag.',
  },
]

export function ItemForm({
  initial,
  categories,
  trackingLocked,
}: {
  initial: ItemFormValues
  categories: Array<{ id: string; name: string }>
  /** Movements exist, so the ledger's grain for this item is already set. */
  trackingLocked: boolean
}) {
  const [state, formAction] = useActionState<ItemFormState, FormData>(saveItemAction, {})

  const [tracking, setTracking] = useState<TrackingMode>(initial.trackingMode)
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>(initial.barcodes)

  const updateBarcode = (index: number, patch: Partial<BarcodeRow>) =>
    setBarcodes((current) =>
      current.map((row, i) =>
        i === index
          ? { ...row, ...patch }
          : // Only one primary: setting it here clears the others rather than
            // letting the server reject the whole form for it.
            patch.isPrimary
            ? { ...row, isPrimary: false }
            : row,
      ),
    )

  /**
   * Builds the payload explicitly rather than relying on a hidden input bound to
   * state.
   *
   * React 19 resets a form after its action completes. A controlled hidden input
   * with no onChange is restored to its render-time value, so a second submit
   * after a validation failure silently sent the ORIGINAL barcodes — the field
   * on screen showed the corrected code while the server kept rejecting the old
   * one. Reading state at submit time removes the whole class of problem.
   */
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    data.set('barcodes', JSON.stringify(barcodes))
    data.set('trackingMode', tracking)
    startTransition(() => formAction(data))
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      {initial.id && <input type="hidden" name="itemId" value={initial.id} />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="sku" label="SKU" error={state.fieldErrors?.sku}>
            <Input id="sku" name="sku" defaultValue={initial.sku} required maxLength={64} />
          </Field>

          <Field id="unit" label="Unit" hint="pcs, rolls, boxes, kg…">
            <Input id="unit" name="unit" defaultValue={initial.unit} required maxLength={24} />
          </Field>

          <Field id="name" label="Name" className="sm:col-span-2" error={state.fieldErrors?.name}>
            <Input id="name" name="name" defaultValue={initial.name} required maxLength={200} />
          </Field>

          <Field id="categoryId" label="Category">
            <select
              id="categoryId"
              name="categoryId"
              defaultValue={initial.categoryId ?? ''}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
            >
              <option value="">Uncategorised</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field id="reorderPoint" label="Reorder at" hint="Flagged low at or below this.">
              <Input
                id="reorderPoint"
                name="reorderPoint"
                type="number"
                min={0}
                defaultValue={initial.reorderPoint}
              />
            </Field>
            <Field id="maxLevel" label="Maximum">
              <Input
                id="maxLevel"
                name="maxLevel"
                type="number"
                min={0}
                defaultValue={initial.maxLevel ?? ''}
                placeholder="Optional"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tracking</CardTitle>
          <CardDescription>
            Decides what a movement of this item has to carry. It cannot change once stock has
            moved, because the ledger already describes this item at one grain.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {TRACKING.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'cursor-pointer rounded-lg border p-3 transition-colors',
                  tracking === option.value ? 'border-primary bg-primary/5' : 'hover:bg-accent',
                  trackingLocked && tracking !== option.value && 'cursor-not-allowed opacity-40',
                )}
              >
                <input
                  type="radio"
                  name="trackingMode"
                  value={option.value}
                  checked={tracking === option.value}
                  disabled={trackingLocked && tracking !== option.value}
                  onChange={() => setTracking(option.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.blurb}</span>
              </label>
            ))}
          </div>

          {trackingLocked && (
            <p className="text-xs text-muted-foreground">
              Locked: this item already has movements. Create a new item to track it differently.
            </p>
          )}

          {tracking === 'BATCH' && (
            <div className="grid gap-4 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input
                  type="checkbox"
                  name="expiryRequired"
                  defaultChecked={initial.expiryRequired}
                  className="size-4"
                />
                Every batch must have an expiry date
              </label>

              <Field id="shelfLifeDays" label="Shelf life (days)" hint="Used to derive expiry.">
                <Input
                  id="shelfLifeDays"
                  name="shelfLifeDays"
                  type="number"
                  min={1}
                  defaultValue={initial.shelfLifeDays ?? ''}
                  placeholder="Optional"
                />
              </Field>

              <Field id="nearExpiryDays" label="Near expiry (days)" hint="Warn this far ahead.">
                <Input
                  id="nearExpiryDays"
                  name="nearExpiryDays"
                  type="number"
                  min={0}
                  defaultValue={initial.nearExpiryDays}
                />
              </Field>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Barcodes</CardTitle>
          <CardDescription>
            An item can have several: a piece barcode and a case barcode that means a carton.
            Scanning a case counts its pack size, not one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {barcodes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No barcodes yet. This item can only be found by name or SKU until one is added.
            </p>
          )}

          {barcodes.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
              <div className="min-w-44 flex-1 space-y-1.5">
                <Label htmlFor={`barcode-${index}`}>Code</Label>
                <Input
                  id={`barcode-${index}`}
                  value={row.barcode}
                  onChange={(e) => updateBarcode(index, { barcode: e.target.value })}
                  className="tabular"
                  placeholder="8901234000045"
                />
              </div>

              <div className="w-32 space-y-1.5">
                <Label htmlFor={`type-${index}`}>Type</Label>
                <select
                  id={`type-${index}`}
                  value={row.type}
                  onChange={(e) => updateBarcode(index, { type: e.target.value as BarcodeType })}
                  className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {(['EAN13', 'ITF14', 'CODE128', 'QR', 'OTHER'] as const).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>

              <div className="w-24 space-y-1.5">
                <Label htmlFor={`pack-${index}`}>Pack size</Label>
                <Input
                  id={`pack-${index}`}
                  type="number"
                  min={1}
                  value={row.packSize}
                  onChange={(e) => updateBarcode(index, { packSize: Number(e.target.value) || 1 })}
                  className="tabular"
                />
              </div>

              <label className="flex h-10 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="primaryBarcode"
                  checked={row.isPrimary}
                  onChange={() => updateBarcode(index, { isPrimary: true })}
                  className="size-4"
                />
                Primary
              </label>

              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove barcode ${row.barcode || index + 1}`}
                onClick={() => setBarcodes((current) => current.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setBarcodes((current) => [
                ...current,
                {
                  barcode: '',
                  type: 'EAN13',
                  packSize: 1,
                  isPrimary: current.length === 0,
                },
              ])
            }
          >
            <Plus />
            Add barcode
          </Button>

          {state.fieldErrors?.barcodes && (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <Barcode className="size-4" />
              {state.fieldErrors.barcodes}
            </p>
          )}
        </CardContent>
      </Card>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="active"
          defaultChecked={initial.active}
          className="size-4"
          value="on"
        />
        Active
        {!initial.active && <Badge variant="secondary">Currently inactive</Badge>}
      </label>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <SaveButton isNew={!initial.id} />
    </form>
  )
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function SaveButton({ isNew }: { isNew: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending && <Loader2 className="animate-spin" />}
      {pending ? 'Saving…' : isNew ? 'Create item' : 'Save changes'}
    </Button>
  )
}
