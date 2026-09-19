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
  parentId: string | null
  code: string
  name: string
  zone: Zone
  active: boolean
  depth: number
  isLeaf: boolean
  stockedLines: number
  onHand: number
  capacityUnits: number | null
  ownCapacityUnits: number | null
  fillPercent: number | null
}

const ZONES: Array<{ value: Zone; label: string }> = [
  { value: 'INBOUND', label: 'Inbound' },
  { value: 'STORAGE', label: 'Storage' },
  { value: 'OUTBOUND', label: 'Outbound' },
]

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-base'

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

  // Newest by `at`, not first-with-content: a successful create would otherwise
  // go on masking every later error, leaving a refusal invisible.
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
              Locations nest, so a warehouse can be described the way it is built — a zone holding
              aisles, an aisle holding racks, a rack holding shelves. Stock sits in the places at
              the bottom.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={create} className="flex flex-wrap items-end gap-3">
              <div className="w-44 space-y-1.5">
                <Label htmlFor="siteId">Site</Label>
                <select id="siteId" name="siteId" className={selectClass}>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="w-32 space-y-1.5">
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

              <div className="min-w-44 flex-1 space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required placeholder="Rack 03" maxLength={120} />
              </div>

              <div className="w-52 space-y-1.5">
                <Label htmlFor="parentId">Inside</Label>
                <select id="parentId" name="parentId" className={selectClass}>
                  <option value="">Top level</option>
                  {/* Only a place holding no stock of its own can contain
                      others, because stock sits at the bottom of the tree. */}
                  {locations
                    .filter((location) => location.onHand === 0)
                    .map((location) => (
                      <option key={location.id} value={location.id}>
                        {'— '.repeat(location.depth)}
                        {location.code}
                      </option>
                    ))}
                </select>
              </div>

              <div className="w-36 space-y-1.5">
                <Label htmlFor="zone">Zone</Label>
                <select id="zone" name="zone" defaultValue="STORAGE" className={selectClass}>
                  {ZONES.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="w-32 space-y-1.5">
                <Label htmlFor="capacityUnits">Capacity</Label>
                <Input
                  id="capacityUnits"
                  name="capacityUnits"
                  type="number"
                  min={1}
                  placeholder="unknown"
                  className="tabular"
                />
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

      {locations.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          No locations yet. Add them above, or load a whole warehouse at once from Admin → Import.
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead className="w-24">Zone</TableHead>
                <TableHead className="w-20 text-right">Lines</TableHead>
                <TableHead className="w-24 text-right">On hand</TableHead>
                <TableHead className="w-32 text-right">Capacity</TableHead>
                <TableHead className="w-28">Full</TableHead>
                {canEdit && <TableHead className="w-52 text-right">Status</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((location) => (
                <TableRow key={location.id} className={cn(!location.active && 'opacity-50')}>
                  <TableCell>
                    {/* Indented rather than nested markup: a table row cannot
                        contain a table, and the indent is what makes the
                        structure readable at a glance. */}
                    <span
                      style={{ paddingLeft: `${location.depth * 1.25}rem` }}
                      className="inline-block"
                    >
                      {location.depth > 0 && (
                        <span className="mr-1.5 text-muted-foreground">└</span>
                      )}
                      <span className="tabular font-medium">{location.code}</span>
                      <span className="ml-2 text-muted-foreground">{location.name}</span>
                    </span>
                    {!location.isLeaf && (
                      <Badge variant="outline" className="ml-2">
                        Holds places
                      </Badge>
                    )}
                    {!location.active && (
                      <Badge variant="outline" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">{location.zone}</TableCell>

                  <TableCell className="tabular text-right text-muted-foreground">
                    {location.stockedLines || '—'}
                  </TableCell>
                  <TableCell className="tabular text-right">{location.onHand || '—'}</TableCell>

                  <TableCell className="text-right">
                    {canEdit && location.isLeaf ? (
                      <form action={update} className="inline">
                        <input type="hidden" name="id" value={location.id} />
                        <CapacityInput value={location.ownCapacityUnits} code={location.code} />
                      </form>
                    ) : (
                      // A branch shows the sum of what is below it and has no
                      // capacity of its own to set.
                      <span className="tabular text-muted-foreground">
                        {location.capacityUnits ?? '—'}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    <Fill percent={location.fillPercent} />
                  </TableCell>

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
      )}
    </div>
  )
}

/**
 * How full a place is.
 *
 * Blank when no capacity is set. An unknown is shown as unknown rather than as
 * 0% — "empty" and "nobody has measured this" are different facts, and only one
 * of them means there is room.
 */
function Fill({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-xs text-muted-foreground">—</span>

  const tone = percent >= 100 ? 'bg-destructive' : percent >= 85 ? 'bg-warn' : 'bg-ok'

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full', tone)} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
      <span className="tabular text-xs text-muted-foreground">{percent}%</span>
    </div>
  )
}

/** Capacity, saved on blur so there is no button per row to hunt for. */
function CapacityInput({ value, code }: { value: number | null; code: string }) {
  const { pending } = useFormStatus()

  return (
    <Input
      name="capacityUnits"
      type="number"
      min={1}
      defaultValue={value ?? ''}
      placeholder="—"
      disabled={pending}
      aria-label={`Capacity of ${code} in units`}
      className="tabular h-8 w-24 text-right"
      // Saved when the field loses focus, and only when it actually changed.
      // A blur that submits an unchanged value writes an audit row saying
      // nothing happened.
      onBlur={(event) => {
        const next = event.target.value.trim()
        if (next === String(value ?? '')) return
        event.target.form?.requestSubmit()
      }}
    />
  )
}

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
