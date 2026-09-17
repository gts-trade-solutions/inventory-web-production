'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, ClipboardCheck, Loader2 } from 'lucide-react'
import { startCountAction, type CountActionState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

export function StartCountForm({
  locations,
}: {
  locations: Array<{ id: string; code: string; name: string; itemCount: number }>
}) {
  const [state, formAction] = useActionState<CountActionState, FormData>(startCountAction, {})

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="locationId">Location to count</Label>
        <select
          id="locationId"
          name="locationId"
          required
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
        >
          <option value="">Choose a location…</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} — {location.name} ({location.itemCount} item
              {location.itemCount === 1 ? '' : 's'})
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-40 space-y-1.5">
        <Label htmlFor="method">Method</Label>
        <select
          id="method"
          name="method"
          defaultValue="BARCODE"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
        >
          <option value="BARCODE">Barcode scan</option>
          <option value="RFID">RFID sweep</option>
          <option value="MANUAL">Manual entry</option>
        </select>
      </div>

      <SubmitButton />

      {state.error && (
        <Alert variant="destructive" className="w-full">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <ClipboardCheck />}
      Start count
    </Button>
  )
}
