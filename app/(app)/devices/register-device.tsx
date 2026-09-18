'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Plus } from 'lucide-react'
import { registerDeviceAction, type DeviceFormState } from './register-actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Mirrors the Prisma enums; a client component may not import their values. */
type Connection = 'NETWORK' | 'BLUETOOTH' | 'USB' | 'SIMULATED'

/**
 * Adding shared hardware.
 *
 * Only printers and fixed readers are offered. Scanners and handsets register
 * themselves when they first connect, and a form that let an admin type one in
 * by hand would create a second, wrong record of the same device.
 */
export function RegisterDevice({ sites }: { sites: Array<{ id: string; label: string }> }) {
  const [state, formAction] = useActionState<DeviceFormState, FormData>(registerDeviceAction, {})
  const [open, setOpen] = useState(false)
  const [connection, setConnection] = useState<Connection>('NETWORK')

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="mr-2 size-4" />
        Add a printer or reader
      </Button>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a printer or reader</CardTitle>
        <p className="text-sm text-muted-foreground">
          Scanners and handsets register themselves the first time they connect, so they are not
          listed here.
        </p>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="label">Name</Label>
              <Input id="label" name="label" placeholder="Goods-in printer" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="kind">Type</Label>
              <select
                id="kind"
                name="kind"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="PRINTER">Label printer</option>
                <option value="RFID_READER">Fixed RFID reader</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="connection">Connection</Label>
              <select
                id="connection"
                name="connection"
                value={connection}
                onChange={(event) => setConnection(event.target.value as Connection)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="NETWORK">On the network</option>
                <option value="SIMULATED">Simulated</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                name="address"
                placeholder="10.0.0.5:9100"
                disabled={connection !== 'NETWORK'}
              />
              <p className="text-xs text-muted-foreground">
                {connection === 'NETWORK'
                  ? 'Host, or host:port. Printers default to 9100 and readers to 5084.'
                  : 'A simulated device needs no address. It stands in for hardware and says so.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="vendor">Vendor</Label>
              <Input id="vendor" name="vendor" placeholder="Zebra" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input id="model" name="model" placeholder="ZD621R" />
            </div>

            {sites.length > 0 && (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="siteId">Site</Label>
                <select
                  id="siteId"
                  name="siteId"
                  className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {state.error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          {state.message && (
            <Alert>
              <CheckCircle2 className="size-4 text-ok" />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2">
            <SubmitButton />
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Adding…
        </>
      ) : (
        'Add device'
      )}
    </Button>
  )
}
