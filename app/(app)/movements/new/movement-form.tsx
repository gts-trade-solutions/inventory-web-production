'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, CheckCircle2, Loader2, Sparkles } from 'lucide-react'
import { recordMovementAction, type MovementFormState } from '../actions'
import type { MovementFormData } from '@/lib/services/movement-form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export type MovementKind = 'RECEIVE' | 'ISSUE' | 'MOVE' | 'ADJUST' | 'SCRAP'

const NEEDS_SOURCE: MovementKind[] = ['ISSUE', 'MOVE', 'SCRAP']
const NEEDS_DESTINATION: MovementKind[] = ['RECEIVE', 'MOVE']
const NEEDS_REASON: MovementKind[] = ['ADJUST', 'SCRAP']

export function MovementForm({
  kind,
  data,
  siteId,
  isSupervisor,
}: {
  kind: MovementKind
  data: MovementFormData
  siteId: string
  isSupervisor: boolean
}) {
  const [state, formAction] = useActionState<MovementFormState, FormData>(recordMovementAction, {})

  const [fromLocationId, setFromLocationId] = useState('')
  const [batchId, setBatchId] = useState(data.proposedBatchId ?? '')
  const [selectedSerials, setSelectedSerials] = useState<string[]>([])

  const { item } = data
  const isBatch = item.trackingMode === 'BATCH'
  const isSerial = item.trackingMode === 'SERIAL'
  const overridingFefo = Boolean(
    data.proposedBatchId && batchId && batchId !== data.proposedBatchId,
  )

  if (state.success) {
    return (
      <Alert>
        <CheckCircle2 className="text-ok" />
        <AlertDescription className="space-y-3">
          <p>{state.success.message}</p>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/inventory/${item.id}`}>Back to item</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/movements/new?item=${item.id}&kind=${kind}`}>Record another</Link>
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="siteId" value={siteId} />
      {overridingFefo && <input type="hidden" name="fefoOverride" value="1" />}

      {NEEDS_SOURCE.includes(kind) && (
        <LocationField
          id="fromLocationId"
          label="From"
          locations={data.locations}
          onHand={data.onHandByLocation}
          value={fromLocationId}
          onChange={setFromLocationId}
          unit={item.unit}
          // Only locations that actually hold this item can be a source.
          onlyWithStock
          error={state.fieldErrors?.fromLocationId}
        />
      )}

      {NEEDS_DESTINATION.includes(kind) && (
        <LocationField
          id="toLocationId"
          label="To"
          locations={data.locations}
          onHand={data.onHandByLocation}
          unit={item.unit}
          error={state.fieldErrors?.toLocationId}
        />
      )}

      {kind === 'ADJUST' && (
        <LocationField
          id="locationId"
          label="Location"
          locations={data.locations}
          onHand={data.onHandByLocation}
          unit={item.unit}
          onlyWithStock
          error={state.fieldErrors?.locationId}
        />
      )}

      {isBatch && (
        <BatchField
          batches={data.batches}
          proposedId={data.proposedBatchId}
          value={batchId}
          onChange={setBatchId}
          allowBlocked={isSupervisor}
          creatable={kind === 'RECEIVE'}
          error={state.fieldErrors?.batchId}
        />
      )}

      {isSerial && NEEDS_SOURCE.includes(kind) && (
        <SerialField
          serials={data.serials}
          selected={selectedSerials}
          onChange={setSelectedSerials}
          needsLocation={!fromLocationId}
          error={state.fieldErrors?.serialUnitIds}
        />
      )}

      {kind === 'ADJUST' ? (
        <Field
          id="countedQuantity"
          label="Counted quantity"
          hint="What is actually on the shelf. The ledger records the difference."
          error={state.fieldErrors?.countedQuantity}
        >
          <Input
            id="countedQuantity"
            name="countedQuantity"
            type="number"
            min={0}
            required
            inputMode="numeric"
          />
        </Field>
      ) : (
        <Field id="quantity" label={`Quantity (${item.unit})`} error={state.fieldErrors?.quantity}>
          <Input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            required
            inputMode="numeric"
            // The serial picker decides the quantity — they must agree exactly,
            // so letting them be edited apart only invites a rejection.
            readOnly={isSerial && NEEDS_SOURCE.includes(kind)}
            value={
              isSerial && NEEDS_SOURCE.includes(kind) ? selectedSerials.length || '' : undefined
            }
            onChange={() => {}}
          />
        </Field>
      )}

      {NEEDS_REASON.includes(kind) && (
        <Field id="reasonCodeId" label="Reason" error={state.fieldErrors?.reasonCodeId}>
          <select
            id="reasonCodeId"
            name="reasonCodeId"
            required
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
          >
            <option value="">Choose a reason…</option>
            {data.reasonCodes
              .filter((reason) => reason.appliesTo === (kind === 'SCRAP' ? 'SCRAP' : 'ADJUST'))
              .map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
          </select>
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="reference" label="Reference" hint="Works order, delivery note, PO number.">
          <Input id="reference" name="reference" placeholder="Optional" />
        </Field>
        <Field id="note" label="Note">
          <Input id="note" name="note" placeholder="Optional" />
        </Field>
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <Submit kind={kind} />
    </form>
  )
}

function BatchField({
  batches,
  proposedId,
  value,
  onChange,
  allowBlocked,
  creatable,
  error,
}: {
  batches: MovementFormData['batches']
  proposedId: string | null
  value: string
  onChange: (value: string) => void
  allowBlocked: boolean
  creatable: boolean
  error?: string
}) {
  const usable = batches.filter((batch) => !batch.blockedReason || allowBlocked)

  return (
    <Field
      id="batchId"
      label="Batch"
      hint={
        proposedId
          ? 'The earliest-expiring batch with enough stock is selected. Changing it is recorded.'
          : creatable
            ? 'Choose the batch this stock belongs to.'
            : undefined
      }
      error={error}
    >
      <div className="space-y-1.5">
        {usable.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No usable batch at that location.
            {!allowBlocked &&
              batches.some((batch) => batch.blockedReason) &&
              ' Some are expired or quarantined — a supervisor can still use those.'}
          </p>
        )}

        {usable.map((batch) => {
          const selected = value === batch.id
          const proposed = batch.id === proposedId

          return (
            <label
              key={batch.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors',
                selected ? 'border-primary bg-primary/5' : 'hover:bg-accent',
                batch.blockedReason && 'border-destructive/40',
              )}
            >
              <input
                type="radio"
                name="batchId"
                value={batch.id}
                checked={selected}
                onChange={() => onChange(batch.id)}
                className="size-4"
              />
              <span className="min-w-0 flex-1">
                <span className="tabular flex flex-wrap items-center gap-2 text-sm font-medium">
                  {batch.batchNo}
                  {proposed && (
                    <Badge variant="ok" className="gap-1">
                      <Sparkles className="size-3" />
                      Use first
                    </Badge>
                  )}
                  {batch.blockedReason && (
                    <Badge variant="destructive">{batch.blockedReason}</Badge>
                  )}
                  {batch.expiryState === 'NEAR' && (
                    <Badge variant="warn">{batch.daysToExpiry}d left</Badge>
                  )}
                </span>
                <span className="tabular block text-xs text-muted-foreground">
                  {batch.available} available
                  {batch.expiryDate && ` · expires ${batch.expiryDate.toISOString().slice(0, 10)}`}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </Field>
  )
}

function SerialField({
  serials,
  selected,
  onChange,
  needsLocation,
  error,
}: {
  serials: MovementFormData['serials']
  selected: string[]
  onChange: (value: string[]) => void
  needsLocation: boolean
  error?: string
}) {
  if (needsLocation) {
    return (
      <Field id="serialUnitIds" label="Units" error={error}>
        <p className="text-sm text-muted-foreground">Choose a source location to list its units.</p>
      </Field>
    )
  }

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])

  return (
    <Field
      id="serialUnitIds"
      label={`Units (${selected.length} selected)`}
      hint="Serial-tracked stock moves by named unit, not by quantity."
      error={error}
    >
      {serials.length === 0 ? (
        <p className="text-sm text-muted-foreground">No units of this item are at that location.</p>
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
          {serials.map((unit) => (
            <label
              key={unit.id}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm',
                selected.includes(unit.id) ? 'bg-primary/5' : 'hover:bg-accent',
              )}
            >
              <input
                type="checkbox"
                name="serialUnitIds"
                value={unit.id}
                checked={selected.includes(unit.id)}
                onChange={() => toggle(unit.id)}
                className="size-4"
              />
              <span className="tabular flex-1">{unit.serialNo}</span>
              {unit.batchNo && (
                <span className="tabular text-xs text-muted-foreground">{unit.batchNo}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </Field>
  )
}

function LocationField({
  id,
  label,
  locations,
  onHand,
  unit,
  value,
  onChange,
  onlyWithStock,
  error,
}: {
  id: string
  label: string
  locations: MovementFormData['locations']
  onHand: Record<string, number>
  unit: string
  value?: string
  onChange?: (value: string) => void
  onlyWithStock?: boolean
  error?: string
}) {
  const options = onlyWithStock
    ? locations.filter((location) => (onHand[location.id] ?? 0) !== 0)
    : locations

  return (
    <Field id={id} label={label} error={error}>
      <select
        id={id}
        name={id}
        required
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
      >
        <option value="">Choose a location…</option>
        {options.map((location) => (
          <option key={location.id} value={location.id}>
            {location.code} — {location.name}
            {onHand[location.id] ? ` (${onHand[location.id]} ${unit})` : ''}
          </option>
        ))}
      </select>
      {onlyWithStock && options.length === 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          This item is not in stock anywhere. Receive some first.
        </p>
      )}
    </Field>
  )
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function Submit({ kind }: { kind: MovementKind }) {
  const { pending } = useFormStatus()
  const label = {
    RECEIVE: 'Receive stock',
    ISSUE: 'Issue stock',
    MOVE: 'Move stock',
    ADJUST: 'Post adjustment',
    SCRAP: 'Scrap stock',
  }[kind]

  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
      {pending && <Loader2 className="animate-spin" />}
      {pending ? 'Recording…' : label}
    </Button>
  )
}
