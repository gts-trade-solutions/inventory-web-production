'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Plus, RotateCcw, Trash2, XCircle } from 'lucide-react'
import {
  createLocationAction,
  deleteLocationAction,
  updateLocationAction,
  type LocationState,
} from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

export type Zone = 'INBOUND' | 'STORAGE' | 'OUTBOUND'

export interface LocationRow {
  id: string
  siteId: string
  siteCode: string
  code: string
  name: string
  zone: Zone
  active: boolean
  stockedLines: number
  onHand: number
}

const ZONES: Array<{ value: Zone; label: string; blurb: string }> = [
  { value: 'INBOUND', label: 'Inbound', blurb: 'Goods arrive here' },
  { value: 'STORAGE', label: 'Storage', blurb: 'Stock sits here' },
  { value: 'OUTBOUND', label: 'Outbound', blurb: 'Goods leave here' },
]

export function LocationAdmin({
  locations,
  sites,
  canEdit,
}: {
  locations: LocationRow[]
  sites: Array<{ id: string; code: string; name: string }>
  canEdit: boolean
}) {
  const [createState, create] = useActionState<LocationState, FormData>(createLocationAction, {})
  const [updateState, update] = useActionState<LocationState, FormData>(updateLocationAction, {})
  const [deleteState, remove] = useActionState<LocationState, FormData>(deleteLocationAction, {})

  // Newest by `at`, not first-with-content. Taking the first meant a
  // successful create kept masking every later error: a deactivate refused by
  // the server left "X added." on screen and the refusal invisible, which
  // reads as the button doing nothing.
  const notice =
    [createState, updateState, deleteState]
      .filter((state) => state.error || state.message)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? {}

  return (
    <div className="space-y-4">
      {canEdit && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add a location</CardTitle>
            <CardDescription>
              The code goes on the rack label and on paperwork, so keep it short and readable — A-01
              rather than AISLE-A-RACK-01.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={create} className="flex flex-wrap items-end gap-3">
              <div className="w-48 space-y-1.5">
                <Label htmlFor="siteId">Site</Label>
                <select id="siteId" name="siteId" className={selectClass}>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="w-36 space-y-1.5">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  name="code"
                  required
                  placeholder="A-03"
                  className="tabular uppercase"
                  maxLength={32}
                />
              </div>

              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  placeholder="Aisle A · Rack 03"
                  maxLength={120}
                />
              </div>

              <div className="w-40 space-y-1.5">
                <Label htmlFor="zone">Zone</Label>
                <select id="zone" name="zone" defaultValue="STORAGE" className={selectClass}>
                  {ZONES.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </select>
              </div>

              <AddButton />
            </form>
          </CardContent>
        </Card>
      )}

      {notice.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{notice.error}</AlertDescription>
        </Alert>
      )}
      {notice.message && (
        <Alert>
          <CheckCircle2 className="text-ok" />
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}

      {ZONES.map((zone) => {
        const inZone = locations.filter((location) => location.zone === zone.value)
        if (inZone.length === 0) return null

        return (
          <div key={zone.value}>
            <h2 className="mb-2 text-sm font-medium">
              {zone.label}
              <span className="ml-2 font-normal text-muted-foreground">{zone.blurb}</span>
            </h2>

            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Site</TableHead>
                    <TableHead className="w-32">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    {canEdit && <TableHead className="w-52 text-right">Status</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inZone.map((location) => (
                    <TableRow key={location.id} className={cn(!location.active && 'opacity-50')}>
                      <TableCell className="tabular text-muted-foreground">
                        {location.siteCode}
                      </TableCell>
                      <TableCell className="tabular font-medium">{location.code}</TableCell>
                      <TableCell>
                        {location.name}
                        {!location.active && (
                          <Badge variant="outline" className="ml-2">
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {location.stockedLines || '—'}
                      </TableCell>
                      <TableCell className="tabular text-right">{location.onHand || '—'}</TableCell>

                      {canEdit && (
                        <TableCell className="space-x-1 text-right">
                          <form action={update} className="inline">
                            <input type="hidden" name="id" value={location.id} />
                            <input type="hidden" name="active" value={String(!location.active)} />
                            <ToggleButton active={location.active} holding={location.onHand > 0} />
                          </form>

                          <form action={remove} className="inline">
                            <input type="hidden" name="id" value={location.id} />
                            <RemoveButton inUse={location.onHand > 0} />
                          </form>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )
      })}

      {locations.length === 0 && (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          No locations yet. Add them above, or load a whole warehouse at once from Admin → Import.
        </p>
      )}
    </div>
  )
}

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-base'

function AddButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <Plus />}
      Add
    </Button>
  )
}

function ToggleButton({ active, holding }: { active: boolean; holding: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant="ghost"
      disabled={pending}
      // Not disabled when it holds stock, deliberately. The server refuses with
      // a sentence saying how much is there and what to do, which teaches more
      // than a greyed-out button explaining nothing.
      title={
        active
          ? holding
            ? 'This location still holds stock; deactivating it will be refused'
            : 'Hide from the pickers; history keeps its name'
          : 'Make it usable again'
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : active ? <XCircle /> : <RotateCcw />}
      {active ? 'Deactivate' : 'Reactivate'}
    </Button>
  )
}

function RemoveButton({ inUse }: { inUse: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant="ghost"
      disabled={pending}
      title={
        inUse
          ? 'This location still holds stock; removing it will be refused'
          : 'Remove it entirely — only possible if nothing was ever recorded here'
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      <span className="sr-only">Remove</span>
    </Button>
  )
}
